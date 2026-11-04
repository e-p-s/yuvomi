/**
 * Modul: Medienzeit (Bildschirmzeit-Kontingente)
 * Zweck: Vier Reiter an einer Adresse: heute (Stand des Kindes), Geraete
 *        (Tracker-Anlage mit einmaligem Token), Regeln (Ruhezeit, Tauschkurs,
 *        Ausnahmen) und Tausch (Punkte gegen Minuten, Historie).
 *        Datenhaltung: server/routes/media-time.js (Prefix /api/v1/media-time),
 *        docs/medienzeit-konzept.md.
 * Abhaengigkeiten: /api.js, /i18n.js, /utils/date-format.js, /utils/html.js,
 *        /components/modal.js, /utils/fab.js, /utils/row-action.js,
 *        /utils/tablist.js, /utils/content-swap.js, /utils/skeleton.js,
 *        /utils/empty-state.js, /utils/reload-after-save.js
 *
 * BAUART (rewards-DNA, 2026-11-04): page-toolbar-Kopf mit eigener Tab-Leiste
 * (media-time-tabs page-toolbar__bar, role=tablist), content-swap je Reiter,
 * wireTablist mit dem geteilten sub-tab-Vokabular, FAB nur wo eine Primaktion
 * steht. Die Reiter-Pfade sind Adressen (/media-time, /media-time/devices,
 * /media-time/rules, /media-time/exchange); die Adresse entscheidet den Reiter,
 * wie bei den Konsequenzen der Belohnungen.
 */

import { api } from '/api.js';
import { t, getNumberFormat } from '/i18n.js';
import { dateText, dateTimeText } from '/utils/date-format.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { openModal, closeModal, captureModalContext, captureOpenContext, isModalContextCurrent, confirmOverModal, refocusAfterRender } from '/components/modal.js';
import { createPageFab, setPageFabAction } from '/utils/fab.js';
import { rowMenuHtml } from '/utils/row-action.js';
import { installPopoverMenus } from '/utils/popover-menu.js';
import { attachSegmentIndicator } from '/utils/segment-indicator.js';
import { wireTablist } from '/utils/tablist.js';
import { swapContent } from '/utils/content-swap.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { emptyStateHTML, mountLoadError } from '/utils/empty-state.js';
import { reloadAfterSave } from '/utils/reload-after-save.js';

/* VIER REITER, VIER ADRESSEN. Wie der Konsequenzen-Reiter der Belohnungen:
 * der Pfad entscheidet den Reiter (render liest location.pathname), der
 * Reiterwechsel folgt der Adresse ueber window.yuvomi.navigate. Der andere
 * Agent traegt die Routen in router.js ein; diese Seite kennt nur ihre Pfade. */
const TAB_PATHS = {
  today: '/media-time',
  devices: '/media-time/devices',
  rules: '/media-time/rules',
  exchange: '/media-time/exchange',
};
const TAB_ORDER = ['today', 'devices', 'rules', 'exchange'];

/* Der Tracker gilt online, wenn sein letzter Heartbeat in diesem Fenster lag.
 * Dieselbe Schwelle wie trackerStatus() serverseitig (TRACKER_ONLINE_WINDOW). */
const TRACKER_ONLINE_WINDOW_HOURS = 12;

/* Das Tauschpaket waehlt eine Zahl 1..100 (Route: quantity 1..100). */
const PURCHASE_MAX = 100;

/* Das Inventar zeigt hoechstens diese Zahl Pakete; die Route liefert mehr. */
const INVENTORY_MAX_ROWS = 50;

let state = {
  tab: 'today',
  /** Aktives Kind (Picker); null = die eigene Person (kein Picker). */
  selectedChildId: null,
  /** Kinder (display_name, id) aus GET /quotas; null = noch nie geladen. */
  children: null,
  /** false = keine Eltern-/Adminrechte; bis der 403 antwortet, gilt true. */
  canManage: true,
  today: null,
  /** Anpassungen des Tages (day-notes) fuer das gewaehlte Kind; null = nie geladen. */
  dayNotes: null,
  devices: null,
  quiet: null,
  settings: null,
  exceptions: null,
  purchases: null,
};

/* Die Adresse entscheidet den Reiter (Neuladen, Zurueck, Link). */
function tabFromPath(pathname) {
  const entry = Object.entries(TAB_PATHS).find(([, path]) => path === pathname);
  return entry ? entry[0] : 'today';
}

/* Der Reiter fuehrt die Adresse, ohne History-Schritt zu verschenken: der
 * Router (utils/router-navigate.js) ruft update() mit dem neuen Pfad auf. */
function navigateToTab(tab) {
  const path = TAB_PATHS[tab] || TAB_PATHS.today;
  if (location.pathname === path) return;
  window.yuvomi?.navigate(path);
}

/** Kurzer Status-Toast (das globale, per role="alert" angekündigte System). */
function toast(message, type = 'success') {
  window.yuvomi?.showToast?.(message, type);
}

function fmtNum(n) {
  return getNumberFormat().format(Number(n || 0));
}

/* Minuten sind hier die Aussage, nicht Prozent: jede Zahl nennt ihre Einheit. */
function minutesLabel(n) {
  return `${fmtNum(n)} ${t('mediaTime.minutesUnit')}`;
}

/* DER SATZ DER APP, NIE DER DES SERVERS (#1909): der Server nennt den Fall als
 * `reason` (media_time_*), die uebersetzten Saetze stehen in de.json unter
 * mediaTime.errors. Alles andere laeuft ueber den allgemeinen Rahmen. */
function mediaTimeErrorSentence(err) {
  const key = err?.data?.reason ? `mediaTime.errors.${err.data.reason}` : null;
  if (key) {
    const sentence = t(key);
    // t() liefert den Key zurueck, wenn ihn keine Locale traegt: dann ist der
    // Fall unbekannt, und der allgemeine Rahmen ist ehrlicher als der Key.
    if (sentence && sentence !== key) return sentence;
  }
  return t('mediaTime.errorGeneric');
}

/* ------------------------------------------------------------------ */
/* Datenladen                                                          */
/* ------------------------------------------------------------------ */

/* Die Liste der Kinder kommt von GET /media-time/quotas (requireManager,
 * liefert display_name). Ein 403 ist die Auskunft "kein Elternteil": dann gibt
 * es keinen Picker, die Seite fragt nur die eigene Person. */
async function ensureChildren() {
  try {
    const res = await api.get('/media-time/quotas');
    const rows = (res.data || []).filter((r) => Number.isInteger(r.user_id));
    state.children = rows.map((r) => ({ id: r.user_id, display_name: r.display_name || r.username || String(r.user_id) }));
    state.canManage = true;
  } catch (err) {
    if ((err?.status ?? err?.response?.status) === 403) {
      state.canManage = false;
      state.children = null;
      return;
    }
    throw err;
  }
  if (!state.children.length) {
    state.selectedChildId = null;
    return;
  }
  if (state.selectedChildId == null
    || !state.children.some((c) => c.id === state.selectedChildId)) {
    state.selectedChildId = state.children[0].id;
  }
}

function childQuery() {
  return state.canManage && state.selectedChildId != null
    ? `?user_id=${encodeURIComponent(state.selectedChildId)}`
    : '';
}

/* Der Tausch-Block auf "heute" braucht den Kurs; GET /settings beantwortet ihn
 * fuer jeden angemeldeten Nutzer (kein requireManager) und haelt damit die
 * Einrichtungsschritte ehrlich. Scheitert die Abfrage, bleibt der Stand null
 * und der Schritt zeigt sich als offen - eine Antwort ohne Zeile ist eine
 * Auskunft, die die Seite sich nicht selbst geben darf. */
async function loadSettingsLite() {
  if (state.settings) return;
  try {
    const res = await api.get('/media-time/settings');
    state.settings = res.data ?? null;
  } catch {
    state.settings = null;
  }
}

async function loadToday() {
  if (state.canManage) await ensureChildren();
  else state.canManage = false;
  const [today] = await Promise.all([
    api.get(`/media-time/today${childQuery()}`),
    loadSettingsLite(),
    loadDayNotes(),
  ]);
  state.today = today.data ?? null;
}

/* Die Anpassungen des Tages (Eltern-Notizen) sind ein Manager-Pfad. Ohne
 * Manager-Recht bleibt der Stand leer - das Kind sieht die Begruendung der
 * laufenden Anpassung am Balken (today.reason), die Liste der Historie nicht.
 * Scheitert die Abfrage anders als am Recht, bleibt null: die Liste sagt dann
 * nichts, statt "heute nichts" zu behaupten, ohne es zu wissen. */
async function loadDayNotes() {
  if (!state.canManage || state.selectedChildId == null) {
    state.dayNotes = [];
    return;
  }
  try {
    const res = await api.get(`/media-time/quotas/${encodeURIComponent(state.selectedChildId)}/day-notes`);
    state.dayNotes = res.data?.items ?? [];
  } catch (err) {
    if ((err?.status ?? err?.response?.status) === 403) {
      state.dayNotes = [];
      return;
    }
    state.dayNotes = null;
  }
}

/* Geraete und Ruhezeit sind Manager-Pfade: ohne Antwort bleibt null, und die
 * Flaeche zeigt den Ladefehler, nicht eine leere Liste (leere Liste hiesse
 * "es gibt nichts", und das weiss die Seite ohne Antwort nicht). */
async function loadDevices() {
  await ensureChildren();
  const res = await api.get('/media-time/devices');
  state.devices = res.data ?? [];
}

async function loadRules() {
  await ensureChildren();
  const [quiet, settings, exceptions] = await Promise.all([
    api.get('/media-time/quiet-hours'),
    api.get('/media-time/settings'),
    api.get('/media-time/tracker/exceptions'),
  ]);
  state.quiet = quiet.data ?? null;
  state.settings = settings.data ?? null;
  state.exceptions = exceptions.data?.items ?? [];
}

async function loadPurchases() {
  if (state.canManage) await ensureChildren();
  const res = await api.get(`/media-time/purchases${childQuery()}`);
  state.purchases = res.data?.items ?? [];
}

/* ------------------------------------------------------------------ */
/* Kleine Bausteine                                                    */
/* ------------------------------------------------------------------ */

function icons(scope) {
  if (window.lucide) window.lucide.createIcons({ el: scope });
}

/** 'HH:MM:SS'/'HH:MM' (Server-Grenze) -> { h, m } oder null. */
function parseClock(raw) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || h > 23 || !Number.isInteger(min) || min > 59) return null;
  return { h, m };
}

function clockText({ h, m }) {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/* "vor 5 Min", "vor 2 Std", "gerade eben"; ohne Zeit den Leerwert der Seite. */
function seenAgoText(iso) {
  if (!iso) return t('mediaTime.neverSeen');
  const seen = new Date(iso).getTime();
  if (!Number.isFinite(seen)) return t('mediaTime.neverSeen');
  const mins = Math.max(0, Math.round((Date.now() - seen) / 60000));
  if (mins < 1) return t('mediaTime.justNow');
  if (mins < 60) return t('mediaTime.minAgo', { count: mins });
  const hours = Math.round(mins / 60);
  return t('mediaTime.hoursAgo', { count: hours });
}

/* ------------------------------------------------------------------ */
/* Shell + Tabs                                                        */
/* ------------------------------------------------------------------ */

/* TEXT-REITER OHNE ICON (rewards-DNA, Critique 2026-10-16 D3): dieselbe Grammatik
 * wie Budget, Belohnungen und Haushaltshilfe - nur das Wort, die Klasse `sub-tab`
 * ist das geteilte Vokabular aus sub-tabs.css. */
function tabButton(tab, label) {
  const on = state.tab === tab;
  return `
    <button class="sub-tab${on ? ' sub-tab--active' : ''}" type="button" role="tab"
            data-tab-id="${esc(tab)}" aria-controls="media-time-content"
            aria-selected="${on ? 'true' : 'false'}"${on ? ' aria-current="page"' : ''} tabindex="${on ? '0' : '-1'}">
      <span class="sub-tab__label">${esc(label)}</span>
    </button>`;
}

/* Der FAB traegt die einzige Primaktion des Reiters: Geraete anlegen. Auf den
 * andern Reitern gibt es keine Primaktion, die einen Knopf verdient haette. */
let fab = null;

function updateMediaTimeFab() {
  if (!fab) return;
  const keepNoun = () => fab.dataset?.dockLabel || t('newLabel.mediaTime');
  if (!state.canManage || state.tab !== 'devices') {
    setPageFabAction(fab, { hidden: true, dockLabel: keepNoun() });
    return;
  }
  setPageFabAction(fab, {
    label: t('mediaTime.deviceAdd'),
    dockLabel: t('newLabel.mediaTime'),
    onClick: () => openDeviceModal(),
  });
}

let _container = null;
let _tabs = null;

function renderShell(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="media-time-page app-page app-page--reading" data-composition="reading">
      <header class="page-toolbar page-toolbar--narrow page-toolbar--tabs-title media-time-toolbar">
        <h1 class="page-toolbar__title" id="media-time-title">${esc(t('mediaTime.title'))}</h1>
        <div class="page-toolbar__actions"></div>
        <nav class="media-time-tabs page-toolbar__bar" role="tablist" aria-label="${esc(t('mediaTime.title'))}">
          ${tabButton('today', t('mediaTime.tabToday'))}
          ${tabButton('devices', t('mediaTime.tabDevices'))}
          ${tabButton('rules', t('mediaTime.tabRules'))}
          ${tabButton('exchange', t('mediaTime.tabExchange'))}
        </nav>
      </header>
      <div class="media-time-content" id="media-time-content"></div>
    </div>`);

  _tabs = wireTablist(container.querySelector('.media-time-tabs'), {
    activeId: state.tab,
    activeClass: 'sub-tab--active',
    onChange: (id, { direction = 0 } = {}) => {
      state.tab = id;
      navigateToTab(id);
      renderCurrentTab(container, { direction });
    },
  });
  // Geteilte gleitende Kapsel unter dem aktiven Reiter (derselbe Kanon wie
  // Belohnungen und Fasten); die Seite baut den Kopf bei jedem Aufruf neu.
  attachSegmentIndicator(container.querySelector('.media-time-tabs'), { key: 'media-time-tabs' });
  fab = createPageFab({ id: 'media-time-fab', dockLabel: t('newLabel.mediaTime') });
  container.querySelector('.media-time-page').appendChild(fab);
  updateMediaTimeFab();
  icons(container);
}

function content() {
  return document.getElementById('media-time-content');
}

/* DAS SKELETT GEHOERT ZUM ERSTEN LADEN (rewards-DNA, Critique R16): der
 * Traeger bleibt stehen, was da ist, bis die Antwort kommt; der Reiterwechsel
 * blendet in Schrittrichtung ein. `renderSeq` verwirft eine Antwort, die ein
 * spaeterer Wechsel ueberholt hat. */
let renderSeq = 0;
const filledHosts = new WeakSet();

function loadFor(tab) {
  if (tab === 'devices') return loadDevices();
  if (tab === 'rules') return loadRules();
  if (tab === 'exchange') return loadPurchases();
  return loadToday();
}

function drawTab(el, tab) {
  if (tab === 'devices') renderDevices(el);
  else if (tab === 'rules') renderRules(el);
  else if (tab === 'exchange') renderExchange(el);
  else renderToday(el);
}

/* Manager-Reiter ohne Manager-Rechte: der Reiter bleibt (die Route fuehrt
 * hierher), aber die Flaechen zeigen densinen Satz - ein leerer Raum ohne
 * Erklaerung waere die leere Zusage. */
function forbiddenPanel() {
  return `<div class="mt-section">${emptyStateHTML({
    icon: 'lock',
    title: t('mediaTime.managerOnlyTitle'),
    description: t('mediaTime.managerOnlyBody'),
  })}</div>`;
}

function renderCurrentTab(container, { direction = null } = {}) {
  const el = content();
  if (!el) return Promise.resolve();
  const seq = ++renderSeq;
  const first = !filledHosts.has(el);
  if (first) {
    el.replaceChildren();
    el.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 3 }));
  }
  const tab = state.tab;
  return (async () => {
    try {
      await loadFor(tab);
      if (seq !== renderSeq) return;
      if ((tab === 'devices' || tab === 'rules') && state.canManage) {
        // Die erfolgreiche Manager-Antwort ist die Auskunft, dass die Rechte
        // noch stehen - der Weg, auf dem die Seite das erfahrt.
        state.canManage = true;
      }
      const draw = () => {
        el.replaceChildren();
        if ((tab === 'devices' || tab === 'rules') && !state.canManage) {
          el.insertAdjacentHTML('beforeend', forbiddenPanel());
        } else {
          drawTab(el, tab);
        }
        icons(el);
      };
      swapContent(el, draw, { direction: direction ?? 0, animate: !first && direction !== null });
      filledHosts.add(el);
    } catch (err) {
      if (seq !== renderSeq) return;
      const status = err?.status ?? err?.response?.status;
      if (status === 403 && (tab === 'devices' || tab === 'rules')) {
        // Die Absage der Route ist die Auskunft, nicht der Fehler: die Flaesche
        // erklaert, warum hier nichts steht, statt einen Ladefehler zu werfen.
        state.canManage = false;
        const draw = () => {
          el.replaceChildren();
          el.insertAdjacentHTML('beforeend', forbiddenPanel());
          icons(el);
        };
        swapContent(el, draw, { direction: 0, animate: !first });
        filledHosts.add(el);
        updateMediaTimeFab();
        return;
      } else {
        mountLoadError(el, {
          title: t('mediaTime.loadError'),
          description: t('common.loadErrorDescription'),
          error: err,
          retryLabel: t('common.retry'),
          onRetry: () => renderCurrentTab(container),
        });
      }
    }
    updateMediaTimeFab();
  })();
}

/* ------------------------------------------------------------------ */
/* Kind-Picker                                                         */
/* ------------------------------------------------------------------ */

function childPickerHtml() {
  if (!state.canManage || !state.children?.length) return '';
  const opts = state.children.map((c) => `
    <option value="${c.id}"${c.id === state.selectedChildId ? ' selected' : ''}>${esc(c.display_name)}</option>`).join('');
  return `
    <div class="mt-picker">
      <label class="label" for="mt-child">${esc(t('mediaTime.childLabel'))}</label>
      <select class="input" id="mt-child">${opts}</select>
    </div>`;
}

function wireChildPicker(el, container) {
  el.querySelector('#mt-child')?.addEventListener('change', (ev) => {
    state.selectedChildId = Number(ev.target.value) || null;
    renderCurrentTab(container, { direction: 0 });
  });
}

/* ------------------------------------------------------------------ */
/* Reiter: heute                                                       */
/* ------------------------------------------------------------------ */

/* Der Zustand ist die Aussage, nicht die Prozentzahl: der Chip nennt ihn,
 * der Balken fuellt sich, und aria-valuetext traegt denselben Satz. */
function chipFor(data) {
  if (!data.enabled) return { cls: 'mt-chip', label: t('mediaTime.chipDisabled') };
  if (data.quiet_active) return { cls: 'mt-chip mt-chip--quiet', label: t('mediaTime.chipQuiet') };
  if (data.state === 'exceeded') return { cls: 'mt-chip mt-chip--exceeded', label: t('mediaTime.chipExceeded') };
  if (data.state === 'nearing') return { cls: 'mt-chip mt-chip--nearing', label: t('mediaTime.chipNearing') };
  return { cls: 'mt-chip mt-chip--ok', label: t('mediaTime.chipOk') };
}

/* Der Stillstand, bevor der Haushalt den Schalter anwirft: drei Schritte, die
 * alle etwas ANLEGEN (renderSetupHints-Muster der Belohnungen). Die Antwort auf
 * die Frage "was fehlt noch" kommt aus dem Serverstand, nie aus der Seite. */
function setupStepsHtml() {
  const quotaSet = !!state.children?.length;
  const deviceKnown = state.devices != null && state.devices.length > 0;
  const steps = [
    { done: !!state.settings?.enabled, label: t('mediaTime.setupStepEnable') },
    { done: quotaSet, label: t('mediaTime.setupStepQuota') },
    { done: deviceKnown, label: t('mediaTime.setupStepDevice') },
  ];
  const items = steps.map((step) => `
    <li class="mt-setup-step${step.done ? ' mt-setup-step--done' : ''}">
      <i class="mt-setup-step__mark" data-lucide="${step.done ? 'check-circle-2' : 'circle'}" aria-hidden="true"></i>
      <span class="mt-setup-step__label">${esc(step.label)}</span>
    </li>`).join('');
  return `
    <section class="mt-section mt-setup" aria-labelledby="mt-setup-title">
      <h2 class="mt-section__title u-section-title" id="mt-setup-title">${esc(t('mediaTime.setupTitle'))}</h2>
      <ol class="mt-setup-list">${items}</ol>
      ${state.canManage ? `<p class="mt-section__note">${esc(t('mediaTime.setupRulesHint'))}</p>` : ''}
    </section>`;
}

function metaCell(label, value) {
  return `
      <p class="mt-meta__item">
        <span class="mt-meta__label">${esc(label)}</span>
        <span class="mt-meta__value">${esc(value)}</span>
      </p>`;
}

function renderToday(el) {
  const data = state.today;
  if (!data) {
    el.insertAdjacentHTML('beforeend', `<div class="media-time-content__inner">${emptyStateHTML({
      icon: 'hourglass',
      title: t('mediaTime.emptyTodayTitle'),
      description: t('mediaTime.emptyTodayBody'),
    })}</div>`);
    return;
  }

  const header = `${childPickerHtml()}`;

  if (!data.enabled) {
    el.insertAdjacentHTML('beforeend', `<div class="media-time-content__inner">${header}
      <div class="mt-section">${emptyStateHTML({
        icon: 'hourglass',
        title: t('mediaTime.disabledTitle'),
        description: t('mediaTime.disabledBody'),
      })}</div>
      ${setupStepsHtml()}</div>`);
    wireChildPicker(el, _container);
    return;
  }

  const chip = chipFor(data);
  const quota = Number(data.quota_min || 0);
  const remaining = Math.max(0, Number(data.remaining_min || 0));
  const ratio = quota > 0 ? Math.max(0, Math.min(1, remaining / quota)) : 0;
  const progressLabel = t('mediaTime.remainingOfQuota', {
    remaining: fmtNum(remaining),
    quota: fmtNum(quota),
  });

  const quiet = data.quiet
    ? `<span class="mt-chip mt-chip--quiet">${esc(t('mediaTime.quietWindowLabel', {
      from: esc(data.quiet.from), to: esc(data.quiet.to),
    }))}</span>`
    : '';
  const trackerOnline = data.tracker?.online;
  const tracker = `
      ${metaCell(t('mediaTime.trackerLabel'),
    trackerOnline ? t('mediaTime.trackerOnline') : t('mediaTime.trackerOffline'))}
      ${metaCell(t('mediaTime.lastSeenLabel'), esc(seenAgoText(data.tracker?.last_seen_at)))}
      ${quiet ? `<span class="mt-meta__quiet">${quiet}</span>` : ''}`;

  const exchange = (data.exchange && state.canManage) ? `
    <section class="mt-section" aria-labelledby="mt-exchange-title">
      <h2 class="mt-section__title u-section-title" id="mt-exchange-title">${esc(t('mediaTime.exchangeTitle'))}</h2>
      <p class="mt-section__note">${esc(t('mediaTime.exchangeHint', {
    points: fmtNum(data.exchange.points),
    minutes: fmtNum(data.exchange.minutes),
  }))}</p>
      <button class="btn btn--primary" type="button" data-action="mt-open-purchase">
        <i data-lucide="coins" aria-hidden="true"></i>${esc(t('mediaTime.exchangeCta'))}
      </button>
    </section>` : '';

  /* Die Anpassung des Tages (Eltern-Notizen, Entscheidung 4): Basis + Anpassung
   * = Kontingent, als eigener Satz UEBER dem Balken - der Balken zeigt das
   * Ergebnis, dieser nennt, wie es zustande kam. Der Knopf steht nur Eltern
   * (PUT ist requireManager); die Begruendung der letzten Anpassung (reason aus
   * /today) sehen Kinder ebenfalls - Transparenz ist hier die Regel, nicht der
   * Umweg. Fehlt `adjusted_min` in der Antwort (ein Server vor der Anpassung),
   * gilt er als 0: nur der Basiswert, kein Knopf-Satz ueber einem Irrtum. */
  const adjusted = Number(data.adjusted_min) || 0;
  const baseQuota = quota - adjusted;
  const reasonText = String(data.reason ?? '').trim();
  const quotaLine = `
      <p class="mt-quota-line">
        <span class="mt-quota-line__text">${esc(t('mediaTime.quotaLine', {
    base: fmtNum(baseQuota),
    adjusted: adjusted >= 0 ? `+${fmtNum(adjusted)}` : `-${fmtNum(Math.abs(adjusted))}`,
    quota: fmtNum(quota),
  }))}</span>
        ${state.canManage ? `<button class="btn btn--secondary btn--sm" type="button" data-action="mt-open-adjust">
          <i data-lucide="pencil" aria-hidden="true"></i>${esc(t('mediaTime.adjustAction'))}
        </button>` : ''}
      </p>
      ${reasonText ? `<p class="mt-quota-reason">${esc(t('mediaTime.quotaReason', { reason: reasonText }))}</p>` : ''}`;

  /* Die Anpassungen des Tages als Protokoll: jede Zeile delta + Grund + wann.
   * Der Zugang ist wie der GET-Endpunkt: Eltern sehen ihr Kind, ein Kind sieht
   * sich selbst (der Server erlaubt beides). `null` = die Antwort ist nie
   * gekommen: dann steht hier nichts, was "heute nichts" behauptet. */
  const notes = state.dayNotes;
  const notesSection = (state.canManage || state.user?.id === state.selectedChildId) && Array.isArray(notes) && notes.length
    ? `
    <section class="mt-section" aria-labelledby="mt-day-notes-title">
      <h2 class="mt-section__title u-section-title" id="mt-day-notes-title">${esc(t('mediaTime.dayNotesTitle'))}</h2>
      <ul class="row-carrier">${notes.map((note) => {
        const delta = Number(note.delta_minutes) || 0;
        const who = note.created_by === state.user?.id
          ? ''
          : `${esc(t('mediaTime.dayNotesBy', { name: childNameFor(note.created_by) }))} · `;
        return `
        <li class="list-row">
          <div class="list-row__main">
            <p class="list-row__name">${esc(String(note.reason ?? ''))}</p>
            <p class="list-row__meta">${who}${esc(dateTimeText(note.created_at))}</p>
          </div>
          <span class="list-row__end">${delta >= 0 ? `+${fmtNum(delta)}` : `-${fmtNum(Math.abs(delta))}`} ${esc(t('mediaTime.minutesUnit'))}</span>
        </li>`;
      }).join('')}</ul>
    </section>` : '';

  el.insertAdjacentHTML('beforeend', `
    <div class="media-time-content__inner">
      ${header}
      <section class="mt-section mt-card" aria-labelledby="mt-today-title">
        <div class="mt-card__head">
          <h2 class="mt-card__title" id="mt-today-title">${esc(t('mediaTime.todayTitle'))}</h2>
          <span class="${chip.cls}">${esc(chip.label)}</span>
        </div>
        ${quotaLine}
        <div class="mt-progress__track" role="progressbar"
             aria-label="${esc(t('mediaTime.progressLabel'))}"
             aria-valuenow="${fmtNum(remaining)}" aria-valuemin="0" aria-valuemax="${fmtNum(quota)}"
             aria-valuetext="${esc(progressLabel)}"><div class="mt-progress__fill" style="--mt-progress:${ratio}"></div></div>
        <p class="mt-progress__label" aria-hidden="true">${esc(progressLabel)}</p>
        <div class="mt-meta">
          ${metaCell(t('mediaTime.metaCharged'), minutesLabel(data.charged_min))}
          ${metaCell(t('mediaTime.metaExempt'), minutesLabel(data.exempt_min))}
          ${metaCell(t('mediaTime.metaUnknown'), minutesLabel(data.unknown_min))}
          ${metaCell(t('mediaTime.metaPurchased'), minutesLabel(data.purchased_min))}
          ${tracker}
        </div>
      </section>
      ${notesSection}
      ${exchange}
      ${setupStepsHtml()}
    </div>`);
  wireChildPicker(el, _container);
  el.querySelector('[data-action="mt-open-purchase"]')
    ?.addEventListener('click', () => openPurchaseModal());
  el.querySelector('[data-action="mt-open-adjust"]')
    ?.addEventListener('click', () => openAdjustModal());
}

/* Anzeigenamen fuer die Anpassungs-Notizen: derPicker-Kinder, sonst der
 * Inhaber der Seite (Eintrag des eigenen Kindes). */
function childNameFor(userId) {
  const child = state.children?.find((c) => c.id === userId);
  if (child) return child.display_name;
  return state.user?.display_name || t('mediaTime.childLabel');
}

/* ------------------------------------------------------------------ */
/* Tageskontingent anpassen (Eltern)                                    */
/* ------------------------------------------------------------------ */

/* Keine Zustands-Korrektur, sondern ein Protokolleintrag: delta + Pflichtgrund,
 * der Server summiert und der Tag gilt neu. Der Grund ist Pflicht, weil das
 * Kind ihn liest - eine Anpassung ohne Satz waere eine Zahl ohne Antwort.
 * Vor dem Speichern die Rueckfrage mit Detail (confirmOverModal-Muster): was
 * sich aendert, steht in der Frage, nicht erst hinter ihr. */
function openAdjustModal() {
  if (!state.canManage || state.selectedChildId == null) return;
  const data = state.today;
  if (!data) return;
  const quota = Number(data.quota_min || 0);
  const adjusted = Number(data.adjusted_min) || 0;
  const modalContext = captureModalContext();
  const refresh = async () => {
    await loadToday();
    if (!isModalContextCurrent(modalContext)) return;
    closeModal({ force: true, context: modalContext });
    await renderCurrentTab(_container, { direction: 0 });
    refocusAfterRender();
  };
  openModal({
    title: t('mediaTime.adjustTitle', { name: childNameFor(state.selectedChildId) }),
    content: `
      <form id="mt-adjust-form" novalidate>
        <div class="form-group">
          <label class="label" for="mt-adjust-delta">${esc(t('mediaTime.adjustDeltaLabel'))}${REQUIRED_MARK}</label>
          <input class="input" id="mt-adjust-delta" type="number" min="-1440" max="1440" step="1" required
                 inputmode="numeric" autocomplete="off">
          <p class="form-hint">${esc(t('mediaTime.adjustDeltaHint', {
            quota: fmtNum(quota),
            adjusted: adjusted >= 0 ? `+${fmtNum(adjusted)}` : `-${fmtNum(Math.abs(adjusted))}`,
          }))}</p>
        </div>
        <div class="form-group">
          <label class="label" for="mt-adjust-reason">${esc(t('mediaTime.adjustReasonLabel'))}${REQUIRED_MARK}</label>
          <textarea class="input" id="mt-adjust-reason" rows="2" maxlength="300" required></textarea>
          <p class="form-hint">${esc(t('mediaTime.adjustReasonHint'))}</p>
        </div>
        <div id="mt-adjust-error" class="form-error" role="alert" hidden></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary" id="mt-adjust-submit">${esc(t('mediaTime.adjustConfirm'))}</button>
        </div>
      </form>`,
    onSave: async (panel) => {
      const deltaEl = panel.querySelector('#mt-adjust-delta');
      const reasonEl = panel.querySelector('#mt-adjust-reason');
      const errEl = panel.querySelector('#mt-adjust-error');
      const submit = panel.querySelector('#mt-adjust-submit');
      const fail = (msg) => {
        errEl.textContent = msg;
        errEl.hidden = false;
      };
      const delta = Math.trunc(Number(deltaEl.value));
      if (!Number.isInteger(delta) || delta === 0 || delta < -1440 || delta > 1440) {
        fail(t('mediaTime.adjustDeltaProblem'));
        return;
      }
      const reason = String(reasonEl.value ?? '').trim();
      if (reason.length < 3 || reason.length > 300) {
        fail(t('mediaTime.adjustReasonProblem'));
        return;
      }
      // Die Rueckfrage nennt das Ergebnis, nicht die Absicht: von ... nach ...
      const confirmed = await confirmOverModal({
        title: t('mediaTime.adjustConfirmTitle', {
          from: fmtNum(quota),
          to: fmtNum(Math.max(0, quota + delta)),
        }),
        detail: t('mediaTime.adjustConfirmDetail', { reason }),
        confirmLabel: t('mediaTime.adjustConfirm'),
      });
      if (!confirmed) return;
      submit.disabled = true;
      try {
        await api.put(`/media-time/quotas/${encodeURIComponent(state.selectedChildId)}/day`, {
          delta_minutes: delta,
          reason,
        });
        await reloadAfterSave(refresh);
      } catch (err) {
        submit.disabled = false;
        errEl.textContent = mediaTimeErrorSentence(err);
        errEl.hidden = false;
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* Punkte gegen Minuten tauschen                                       */
/* ------------------------------------------------------------------ */

function openPurchaseModal() {
  if (!state.canManage) return;
  const rate = state.today?.exchange;
  if (!rate) return;
  const modalContext = captureModalContext();
  const refresh = async () => {
    await loadToday();
    if (!isModalContextCurrent(modalContext)) return;
    closeModal({ force: true, context: modalContext });
    await renderCurrentTab(_container, { direction: 0 });
    refocusAfterRender();
  };
  openModal({
    title: t('mediaTime.purchaseTitle'),
    content: `
      <form id="mt-purchase-form" novalidate>
        <div class="form-group">
          <label class="label" for="mt-purchase-qty">${esc(t('mediaTime.purchaseQtyLabel'))}${REQUIRED_MARK}</label>
          <input class="input" id="mt-purchase-qty" type="number" min="1" max="${PURCHASE_MAX}" step="1" value="1" required>
          <p class="form-hint">${esc(t('mediaTime.purchaseHint', {
            points: fmtNum(rate.points),
            minutes: fmtNum(rate.minutes),
          }))}</p>
        </div>
        <div id="mt-purchase-error" class="form-error" role="alert" hidden></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary" id="mt-purchase-submit">${esc(t('mediaTime.purchaseConfirm'))}</button>
        </div>
      </form>`,
    onSave: async (panel) => {
      const qtyEl = panel.querySelector('#mt-purchase-qty');
      const errEl = panel.querySelector('#mt-purchase-error');
      const submit = panel.querySelector('#mt-purchase-submit');
      const qty = Math.trunc(Number(qtyEl.value));
      if (!Number.isInteger(qty) || qty < 1 || qty > PURCHASE_MAX) {
        errEl.textContent = t('mediaTime.purchaseQtyProblem');
        errEl.hidden = false;
        return;
      }
      submit.disabled = true;
      try {
        const body = { quantity: qty };
        if (state.selectedChildId != null) body.user_id = state.selectedChildId;
        await api.post('/media-time/purchase', body);
        toast(t('mediaTime.purchaseDoneToast', {
          minutes: fmtNum(rate.minutes * qty),
          points: fmtNum(rate.points * qty),
        }));
        await reloadAfterSave(refresh);
      } catch (err) {
        if (!isModalContextCurrent(modalContext)) return undefined;
        errEl.textContent = mediaTimeErrorSentence(err);
        errEl.hidden = false;
        submit.disabled = false;
      }
      return undefined;
    },
  });
}

/* ------------------------------------------------------------------ */
/* Reiter: Geraete                                                     */
/* ------------------------------------------------------------------ */

function platformLabel(platform) {
  if (platform === 'android') return t('mediaTime.platformAndroid');
  if (platform === 'windows') return t('mediaTime.platformWindows');
  return platform || t('mediaTime.platformUnknown');
}

/* revoke-Bestaetigung: der Revoke loescht nichts an Sessions, er zieht nur den
 * Token ab - der Satz nennt das, damit die Frage ehrlich bleibt. */
async function revokeDevice(id, name) {
  const ok = await confirmOverModal(t('mediaTime.deviceRevokeTitle'), {
    confirmLabel: t('mediaTime.deviceRevokeConfirm'),
    danger: true,
    detail: t('mediaTime.deviceRevokeDetail', { name }),
  });
  if (!ok) return;
  try {
    await api.post(`/media-time/devices/${encodeURIComponent(id)}/revoke`, {});
    toast(t('mediaTime.deviceRevokedToast'));
    await reloadAfterSave(async () => {
      await loadDevices();
      await renderCurrentTab(_container, { direction: 0 });
    });
    refocusAfterRender();
  } catch (err) {
    const status = err?.status ?? err?.response?.status;
    if (status === 403) {
      state.canManage = false;
      await renderCurrentTab(_container, { direction: 0 });
      return;
    }
    toast(mediaTimeErrorSentence(err), 'danger');
  }
}

/* Die Endzone jeder Zeile traegt hoechstens EINE sichtbare Handlung (Kanons
 * D10 und D6): der Rest zieht in den Mehr-Knopf - auch der Papierkorb, der als
 * offenes Zeichen nie die lauteste Farbe der Liste fuehren darf. Der Knopf
 * braucht installPopoverMenus an der Wurzel, die ihn enthaelt. */
function deviceRow(device) {
  const revoked = !!device.revoked_at;
  const name = device.name || t('mediaTime.deviceUnnamed');
  const actions = revoked ? '' : rowMenuHtml({
    id: `mt-device-menu-${device.id}`,
    label: t('common.moreActionsNamed', { name }),
    items: [
      { action: 'inventory', icon: 'package-search', label: t('mediaTime.inventoryOpen', { name }), attrs: { 'data-inventory': device.id } },
      { action: 'revoke', icon: 'key-round', label: t('mediaTime.deviceRevokeAction', { name }), danger: true, attrs: { 'data-revoke': device.id } },
    ],
  });
  return `
    <li class="list-row mt-device-row" data-device="${device.id}">
      <div class="list-row__main">
        <p class="list-row__name">${esc(name)}${revoked ? ` <span class="tag">${esc(t('mediaTime.revokedChip'))}</span>` : ''}</p>
        <p class="list-row__meta">${esc(platformLabel(device.platform))} · ${esc(
  device.child_name || (state.children?.find((c) => c.id === device.user_id)?.display_name ?? t('mediaTime.childLabel'))
)} · ${esc(t('mediaTime.lastSeenLabel'))} ${esc(seenAgoText(device.last_seen_at))}</p>
      </div>
      <div class="list-row__actions">${actions}</div>
    </li>`;
}

function renderDevices(el) {
  const rows = state.devices ?? [];
  const body = rows.length
    ? `<ul class="mt-device-list row-carrier">${rows.map(deviceRow).join('')}</ul>`
    : emptyStateHTML({
      icon: 'smartphone',
      title: t('mediaTime.devicesEmptyTitle'),
      description: t('mediaTime.devicesEmptyBody'),
      action: state.canManage
        // tone secondary: auf diesem Reiter steht der FAB bereits fuer
        // 'Geraet hinzufuegen' (updateMediaTimeFab) - die leere Liste braucht
        // keine zweite Primaeraktion (R23 D14).
        ? { label: t('mediaTime.deviceAdd'), icon: 'plus', tone: 'secondary', className: 'mt-add-device' }
        : undefined,
    });
  el.insertAdjacentHTML('beforeend', `
    <div class="media-time-content__inner">
      <section class="mt-section" aria-labelledby="mt-devices-title">
        <h2 class="mt-section__title u-section-title" id="mt-devices-title">${esc(t('mediaTime.devicesTitle'))}</h2>
        ${body}
      </section>
    </div>`);
  el.querySelector('.mt-add-device')?.addEventListener('click', () => openDeviceModal());
  installPopoverMenus(el);
  el.querySelectorAll('[data-revoke]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const device = rows.find((d) => d.id === Number(btn.dataset.revoke));
      revokeDevice(Number(btn.dataset.revoke), device?.name ?? t('mediaTime.deviceUnnamed'));
    });
  });
  el.querySelectorAll('[data-inventory]').forEach((btn) => {
    btn.addEventListener('click', () => openInventoryModal(Number(btn.dataset.inventory)));
  });
}

/* Geraet anlegen: POST /devices liefert das Token EINMAL im Klartext. Der
 * Nach-Dialog haelt es, bis es kopiert wurde - danach ist es fuer immer fort. */
function openDeviceModal() {
  if (!state.canManage) return;
  const kindOptions = (state.children || []).map((c) => `
    <option value="${c.id}">${esc(c.display_name)}</option>`).join('');
  const modalContext = captureModalContext();
  openModal({
    title: t('mediaTime.deviceAddTitle'),
    content: `
      <form id="mt-device-form" novalidate>
        <div class="form-group">
          <label class="label" for="mt-device-name">${esc(t('mediaTime.deviceNameLabel'))}${REQUIRED_MARK}</label>
          <input class="input" id="mt-device-name" maxlength="100" required>
        </div>
        <div class="form-group">
          <label class="label" for="mt-device-platform">${esc(t('mediaTime.devicePlatformLabel'))}</label>
          <select class="input" id="mt-device-platform">
            <option value="windows">${esc(t('mediaTime.platformWindows'))}</option>
            <option value="android" selected>${esc(t('mediaTime.platformAndroid'))}</option>
          </select>
        </div>
        <div class="form-group">
          <label class="label" for="mt-device-child">${esc(t('mediaTime.deviceChildLabel'))}${REQUIRED_MARK}</label>
          <select class="input" id="mt-device-child" required>${kindOptions}</select>
        </div>
        <div id="mt-device-error" class="form-error" role="alert" hidden></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}
          <button type="submit" class="btn btn--primary">${esc(t('common.add'))}</button>
        </div>
      </form>`,
    onSave: async (panel) => {
      const errEl = panel.querySelector('#mt-device-error');
      const name = String(panel.querySelector('#mt-device-name').value || '').trim();
      const platform = panel.querySelector('#mt-device-platform').value;
      const userId = Number(panel.querySelector('#mt-device-child').value) || null;
      if (!name || !userId) {
        errEl.textContent = t('mediaTime.deviceFormProblem');
        errEl.hidden = false;
        return;
      }
      try {
        const res = await api.post('/media-time/devices', { name, platform, user_id: userId });
        closeModal({ force: true, context: modalContext });
        openTokenModal(res.data);
      } catch (err) {
        errEl.textContent = mediaTimeErrorSentence(err);
        errEl.hidden = false;
      }
    },
  });
}

/* DER TOKEN IST NUR EINMAL DA: der Server schickt den Klartext in der
 * Anlege-Antwort und weis nie wieder etwas davon. Der Dialog sagt das, zeigt
 * das Feld readonly und bietet den einen Weg: Kopieren. */
function openTokenModal(data) {
  openModal({
    title: t('mediaTime.tokenTitle'),
    content: `
      <div class="form-group">
        <label class="label" for="mt-token">${esc(t('mediaTime.tokenLabel'))}</label>
        <input class="input mt-token" id="mt-token" type="text" readonly value="${esc(data.token || '')}">
      </div>
      <p class="form-hint">${esc(t('mediaTime.tokenWarning'))}</p>
      <div class="modal-panel__footer modal-panel__footer--plain">
        <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.close'))}</button>
        <button type="button" class="btn btn--primary" id="mt-token-copy">
          <i data-lucide="copy" aria-hidden="true"></i>${esc(t('mediaTime.tokenCopy'))}
        </button>
      </div>`,
  });
  setTimeout(() => {
    document.getElementById('mt-token-copy')?.addEventListener('click', async () => {
      const token = String(data.token || '');
      if (!token) return;
      try {
        await navigator.clipboard.writeText(token);
        toast(t('mediaTime.tokenCopied'));
      } catch {
        toast(t('mediaTime.tokenCopyFailed'), 'warning');
      }
    });
  }, 0);
}

/* Inventar eines Geraets: die Zeilen stammen aus dem Tracker-Delta, der Satz
 * erklaert, wofuer die Liste da ist (neu installiert?). */
async function openInventoryModal(deviceId) {
  // Der Oeffnungswunsch wird VOR der Anfrage festgehalten: kommt die Antwort
  // spaet, entscheidet der Kontext, ob dieser Dialog ueberhaupt noch geoeffnet
  // werden darf (#1997, Spaet-Dialog-Scanner des Audits).
  const modalContext = captureOpenContext();
  let items = [];
  try {
    const res = await api.get(`/media-time/devices/${encodeURIComponent(deviceId)}/inventory`);
    items = res.data?.items ?? [];
  } catch (err) {
    toast(mediaTimeErrorSentence(err), 'danger');
    return;
  }
  if (!isModalContextCurrent(modalContext)) return;
  const rows = items.slice(0, INVENTORY_MAX_ROWS).map((item) => {
    const estimate = item.first_install_estimate
      ? ` <span class="tag">${esc(t('mediaTime.firstInstallChip', { date: dateText(item.first_install_estimate) }))}</span>`
      : '';
    const version = item.version_name ? ` · ${esc(item.version_name)}` : '';
    return `
      <li class="list-row">
        <div class="list-row__main">
          <p class="list-row__name">${esc(item.package_name)}${estimate}</p>
          <p class="list-row__meta">${esc(t('mediaTime.inventoryLastSeen'))} ${esc(dateText(item.last_seen_at))}${version}</p>
        </div>
      </li>`;
  }).join('');
  const more = items.length > INVENTORY_MAX_ROWS
    ? `<p class="mt-section__note">${esc(t('mediaTime.inventoryTruncHint', { shown: fmtNum(INVENTORY_MAX_ROWS), total: fmtNum(items.length) }))}</p>`
    : '';
  const body = items.length
    ? `<ul class="row-carrier">${rows}</ul>${more}`
    : `<p class="mt-section__note">${esc(t('mediaTime.inventoryEmpty'))}</p>`;
  openModal({
    title: t('mediaTime.inventoryTitle'),
    content: `${body}
      <div class="modal-panel__footer modal-panel__footer--plain">
        <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.close'))}</button>
      </div>`,
  });
}

/* ------------------------------------------------------------------ */
/* Reiter: Regeln                                                      */
/* ------------------------------------------------------------------ */

function renderRules(el) {
  el.insertAdjacentHTML('beforeend', `
    <div class="media-time-content__inner">
      <section class="mt-section" aria-labelledby="mt-quiet-title">
        <h2 class="mt-section__title u-section-title" id="mt-quiet-title">${esc(t('mediaTime.quietTitle'))}</h2>
        <p class="mt-section__note">${esc(t('mediaTime.quietBody'))}</p>
        <div class="mt-quiet-form">
          <label class="label" for="mt-quiet-from">${esc(t('mediaTime.quietFrom'))}</label>
          <input class="input mt-quiet__time" id="mt-quiet-from" type="time">
          <label class="label" for="mt-quiet-to">${esc(t('mediaTime.quietTo'))}</label>
          <input class="input mt-quiet__time" id="mt-quiet-to" type="time">
        </div>
        <div class="mt-row-actions">
          <button class="btn btn--primary" type="button" data-action="mt-save-quiet">${esc(t('common.save'))}</button>
          <button class="btn btn--secondary" type="button" data-action="mt-clear-quiet">${esc(t('mediaTime.quietClear'))}</button>
        </div>
      </section>

      <section class="mt-section" aria-labelledby="mt-settings-title">
        <h2 class="mt-section__title u-section-title" id="mt-settings-title">${esc(t('mediaTime.settingsTitle'))}</h2>
        <div id="mt-switch-host"></div>
        <div class="form-group">
          <label class="label" for="mt-rate-points">${esc(t('mediaTime.ratePointsLabel'))}</label>
          <input class="input mt-rate__field" id="mt-rate-points" type="number" min="1" max="9999" step="1">
        </div>
        <div class="form-group">
          <label class="label" for="mt-rate-minutes">${esc(t('mediaTime.rateMinutesLabel'))}</label>
          <input class="input mt-rate__field" id="mt-rate-minutes" type="number" min="1" max="1440" step="1">
        </div>
        <div class="mt-row-actions">
          <button class="btn btn--primary" type="button" data-action="mt-save-rate">${esc(t('common.save'))}</button>
          <button class="btn btn--secondary" type="button" data-action="mt-off-rate">${esc(t('mediaTime.rateOff'))}</button>
        </div>
        <div class="form-group mt-hardcap-row">
          <label class="label" for="mt-hardcap">${esc(t('mediaTime.hardCapLabel'))}</label>
          <select class="input" id="mt-hardcap">
            <option value="1">${esc(t('mediaTime.hardCapHard'))}</option>
            <option value="0">${esc(t('mediaTime.hardCapBuyable'))}</option>
          </select>
          <p class="form-hint">${esc(t('mediaTime.hardCapHint'))}</p>
        </div>
      </section>

      <section class="mt-section" aria-labelledby="mt-exceptions-title">
        <div class="mt-section__head">
          <h2 class="mt-section__title u-section-title" id="mt-exceptions-title">${esc(t('mediaTime.exceptionsTitle'))}</h2>
          <button class="btn btn--secondary btn--sm" type="button" data-action="mt-exception-add">
            <i data-lucide="plus" aria-hidden="true"></i>${esc(t('mediaTime.exceptionAdd'))}
          </button>
        </div>
        <p class="mt-section__note">${esc(t('mediaTime.exceptionsBody'))}</p>
        <div id="mt-exception-host"></div>
      </section>
    </div>`);
  wireRules(el);
}

function wireRules(el) {
  /* (a) Ruhezeit */
  const q = state.quiet;
  if (q?.range) {
    const [from, to] = String(q.range).split('-');
    el.querySelector('#mt-quiet-from').value = from || '';
    el.querySelector('#mt-quiet-to').value = to || '';
  }
  el.querySelector('[data-action="mt-save-quiet"]')?.addEventListener('click', async () => {
    const from = el.querySelector('#mt-quiet-from').value;
    const to = el.querySelector('#mt-quiet-to').value;
    if (!from || !to) {
      toast(t('mediaTime.quietProblem'), 'danger');
      return;
    }
    await putQuiet(`${from}-${to}`);
  });
  el.querySelector('[data-action="mt-clear-quiet"]')?.addEventListener('click', () => putQuiet(null));

  /* (b) Schalter + Kurs + Cap */
  const s = state.settings;
  const host = el.querySelector('#mt-switch-host');
  host.insertAdjacentHTML('beforeend', `
    <label class="toggle-row toggle-row--switch">
      <span class="toggle-row__label">${esc(t('mediaTime.switchLabel'))}</span>
      <span class="toggle">
        <input type="checkbox" role="switch" id="mt-enabled"${s?.enabled ? ' checked' : ''}>
        <span class="toggle__track" aria-hidden="true"></span>
      </span>
    </label>
    <p class="form-hint">${esc(t('mediaTime.switchHint'))}</p>`);
  host.querySelector('#mt-enabled')?.addEventListener('change', (ev) => setEnabled(ev.target.checked, ev.target));
  if (s?.exchange) {
    el.querySelector('#mt-rate-points').value = s.exchange.points;
    el.querySelector('#mt-rate-minutes').value = s.exchange.minutes;
  }
  if (s) el.querySelector('#mt-hardcap').value = s.hard_cap ? '1' : '0';
  el.querySelector('[data-action="mt-save-rate"]')?.addEventListener('click', () => saveRate(el));
  el.querySelector('[data-action="mt-off-rate"]')?.addEventListener('click', async () => {
    await api.put('/media-time/settings', { exchange: null });
    toast(t('mediaTime.rateOffDone'));
    await reloadAfterSave(() => renderCurrentTab(_container, { direction: 0 }));
  });
  el.querySelector('#mt-hardcap')?.addEventListener('change', (ev) => saveHardCap(ev.target.value === '1'));

  /* (c) Ausnahmen */
  renderExceptionRows(el);
  el.querySelector('[data-action="mt-exception-add"]')?.addEventListener('click', () => openExceptionModal(null));
}

async function putQuiet(range) {
  try {
    await api.put('/media-time/quiet-hours', { range });
    toast(t('mediaTime.quietSaved'));
    await reloadAfterSave(() => renderCurrentTab(_container, { direction: 0 }));
  } catch (err) {
    const status = err?.status ?? err?.response?.status;
    if (status === 403) {
      state.canManage = false;
      await renderCurrentTab(_container, { direction: 0 });
      return;
    }
    toast(mediaTimeErrorSentence(err), 'danger');
  }
}

/* Der Schalter wirkt sofort (Komponenten-Kanon "Schalter in Einstellungen"):
 * umlegen speichert, ein Fehler legt ihn zurueck. */
async function setEnabled(checked, input) {
  try {
    await api.put('/preferences', { media_time_enabled: checked });
    state.settings = { ...state.settings, enabled: checked };
    toast(checked ? t('mediaTime.switchOnToast') : t('mediaTime.switchOffToast'));
  } catch (err) {
    input.checked = !checked;
    toast(mediaTimeErrorSentence(err), 'danger');
  }
}

async function saveRate(el) {
  const points = Math.trunc(Number(el.querySelector('#mt-rate-points').value));
  const minutes = Math.trunc(Number(el.querySelector('#mt-rate-minutes').value));
  if (!Number.isInteger(points) || points < 1 || points > 9999
    || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    toast(t('mediaTime.rateProblem'), 'danger');
    return;
  }
  try {
    await api.put('/media-time/settings', { exchange: `${points}:${minutes}` });
    toast(t('mediaTime.rateSaved'));
    await reloadAfterSave(() => renderCurrentTab(_container, { direction: 0 }));
  } catch (err) {
    toast(mediaTimeErrorSentence(err), 'danger');
  }
}

async function saveHardCap(hard) {
  try {
    await api.put('/media-time/settings', { hard_cap: hard });
    state.settings = { ...state.settings, hard_cap: hard };
    toast(t('mediaTime.rateSaved'));
  } catch (err) {
    const status = err?.status ?? err?.response?.status;
    if (status === 403) {
      state.canManage = false;
      await renderCurrentTab(_container, { direction: 0 });
      return;
    }
    toast(mediaTimeErrorSentence(err), 'danger');
  }
}

function exceptionUserLabel(userId) {
  if (userId == null) return t('mediaTime.exceptionHousehold');
  return state.children?.find((c) => c.id === userId)?.display_name ?? String(userId);
}

/* Ein PUT ueber die Ausnahme-Route antwortet nur "Regel fehlt" oder "Regel da".
 * Der 403 ist die dritte Auskunft (Rechte weggefallen) und faehrt hier zur
 * Absage-Flaesche, nie zum Toast allein. */
async function putExceptionsGuarded(body) {
  try {
    await api.put('/media-time/tracker/exceptions', body);
    return true;
  } catch (err) {
    const status = err?.status ?? err?.response?.status;
    if (status === 403) {
      state.canManage = false;
      await renderCurrentTab(_container, { direction: 0 });
      return false;
    }
    throw err;
  }
}

function renderExceptionRows(el) {
  const host = el.querySelector('#mt-exception-host');
  if (!host) return;
  const items = state.exceptions || [];
  host.replaceChildren();
  if (!items.length) {
    host.insertAdjacentHTML('beforeend', `<p class="mt-section__note">${esc(t('mediaTime.exceptionsEmpty'))}</p>`);
    return;
  }
  const rows = items.map((item) => `
    <li class="list-row" data-exception="${item.id}">
      <div class="list-row__main">
        <p class="list-row__name">${esc(item.pattern)}</p>
        <p class="list-row__meta">${esc(t(`mediaTime.exceptionMatch.${item.match_type}`))} · ${esc(t(`mediaTime.exceptionExempt.${item.exempt_from}`))} · ${esc(exceptionUserLabel(item.user_id))}${item.note ? ` · ${esc(item.note)}` : ''}</p>
      </div>
      <div class="list-row__actions">
        ${rowMenuHtml({
    id: `mt-exception-menu-${item.id}`,
    label: t('common.moreActionsNamed', { name: item.pattern }),
    items: [
      { action: 'exception-edit', icon: 'pencil', label: t('mediaTime.exceptionEdit', { name: item.pattern }), attrs: { 'data-exception-edit': item.id } },
      { action: 'exception-revoke', icon: 'trash-2', label: t('mediaTime.exceptionRevokeAction', { name: item.pattern }), danger: true, attrs: { 'data-exception-revoke': item.id } },
    ],
  })}
      </div>
    </li>`).join('');
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `<ul class="row-carrier">${rows}</ul>`);
  installPopoverMenus(host);
  host.querySelectorAll('[data-exception-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openExceptionModal(items.find((x) => x.id === Number(btn.dataset.exceptionEdit)) ?? null);
    });
  });
  host.querySelectorAll('[data-exception-revoke]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = items.find((x) => x.id === Number(btn.dataset.exceptionRevoke));
      const ok = await confirmOverModal(t('mediaTime.exceptionRevokeTitle'), {
        confirmLabel: t('common.delete'),
        danger: true,
        detail: t('mediaTime.exceptionRevokeDetail', { pattern: item?.pattern ?? '' }),
      });
      if (!ok) return;
      try {
        const applied = await putExceptionsGuarded({ revoke: [Number(btn.dataset.exceptionRevoke)] });
        if (!applied) return;
        toast(t('mediaTime.exceptionRevokedToast'));
        await reloadAfterSave(() => renderCurrentTab(_container, { direction: 0 }));
        refocusAfterRender();
      } catch (err) {
        toast(mediaTimeErrorSentence(err), 'danger');
      }
    });
  });
}

/* Regel anlegen/aelendern: upsert ist ueber (user_id, match_type, pattern)
 * eindeutig - Bearbeiten ist dasselbe PUT mit dem neuen Wert. */
function openExceptionModal(existing) {
  const childOpts = `<option value="">${esc(t('mediaTime.exceptionHousehold'))}</option>
    ${(state.children || []).map((c) => `<option value="${c.id}">${esc(c.display_name)}</option>`).join('')}`;
  const modalContext = captureModalContext();
  openModal({
    title: existing ? t('mediaTime.exceptionEditTitle') : t('mediaTime.exceptionAddTitle'),
    initialFocus: 'edit',
    content: `
      <form id="mt-exception-form" novalidate>
        <div class="form-group">
          <label class="label" for="mt-exc-user">${esc(t('mediaTime.exceptionUserLabel'))}</label>
          <select class="input" id="mt-exc-user">${childOpts}</select>
        </div>
        <div class="form-group">
          <label class="label" for="mt-exc-match">${esc(t('mediaTime.exceptionMatchLabel'))}</label>
          <select class="input" id="mt-exc-match">
            <option value="exact">${esc(t('mediaTime.exceptionMatch.exact'))}</option>
            <option value="prefix">${esc(t('mediaTime.exceptionMatch.prefix'))}</option>
            <option value="glob">${esc(t('mediaTime.exceptionMatch.glob'))}</option>
          </select>
        </div>
        <div class="form-group">
          <label class="label" for="mt-exc-pattern">${esc(t('mediaTime.exceptionPatternLabel'))}${REQUIRED_MARK}</label>
          <input class="input" id="mt-exc-pattern" maxlength="200" placeholder="de.youtube..." required>
        </div>
        <div class="form-group">
          <label class="label" for="mt-exc-exempt">${esc(t('mediaTime.exceptionExemptLabel'))}</label>
          <select class="input" id="mt-exc-exempt">
            <option value="quota">${esc(t('mediaTime.exceptionExempt.quota'))}</option>
            <option value="history">${esc(t('mediaTime.exceptionExempt.history'))}</option>
            <option value="charged">${esc(t('mediaTime.exceptionExempt.charged'))}</option>
          </select>
          <p class="form-hint">${esc(t('mediaTime.exceptionPatternHelp'))}</p>
        </div>
        <div class="form-group">
          <label class="label" for="mt-exc-note">${esc(t('mediaTime.exceptionNoteLabel'))}</label>
          <input class="input" id="mt-exc-note" maxlength="500">
        </div>
        <div id="mt-exception-error" class="form-error" role="alert" hidden></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}
          <button type="submit" class="btn btn--primary">${esc(existing ? t('common.save') : t('common.add'))}</button>
        </div>
      </form>`,
    onSave: async (panel) => {
      const errEl = panel.querySelector('#mt-exception-error');
      const userRaw = panel.querySelector('#mt-exc-user').value;
      const item = {
        user_id: userRaw === '' ? null : Number(userRaw),
        match_type: panel.querySelector('#mt-exc-match').value,
        pattern: String(panel.querySelector('#mt-exc-pattern').value || '').trim(),
        exempt_from: panel.querySelector('#mt-exc-exempt').value,
        note: String(panel.querySelector('#mt-exc-note').value || '').trim() || null,
      };
      if (!item.pattern) {
        errEl.textContent = t('mediaTime.exceptionPatternProblem');
        errEl.hidden = false;
        return;
      }
      try {
        const upsert = [item];
        let revoke = [];
        if (existing && (existing.user_id !== item.user_id
          || existing.match_type !== item.match_type
          || existing.pattern !== item.pattern)) {
          // Aendern an den Schluesseln ist eine neue Regel: die alte zieht ab,
          // sonst stünden zwei Regeln fuer ein Kind im Tracker-Cache.
          revoke = [existing.id];
        }
        const applied = await putExceptionsGuarded({ upsert, revoke });
        if (!applied) {
          closeModal({ force: true, context: modalContext });
          return;
        }
        if (!isModalContextCurrent(modalContext)) return;
        closeModal({ force: true, context: modalContext });
        toast(t('mediaTime.exceptionSavedToast'));
        await reloadAfterSave(() => renderCurrentTab(_container, { direction: 0 }));
        refocusAfterRender();
      } catch (err) {
        errEl.textContent = mediaTimeErrorSentence(err);
        errEl.hidden = false;
      }
    },
  });
  if (existing) {
    const set = (sel, value) => {
      const node = document.querySelector(sel);
      if (node && value != null) node.value = String(value);
    };
    set('#mt-exc-user', existing.user_id ?? '');
    set('#mt-exc-match', existing.match_type);
    set('#mt-exc-pattern', existing.pattern);
    set('#mt-exc-exempt', existing.exempt_from);
    set('#mt-exc-note', existing.note ?? '');
  }
}

/* ------------------------------------------------------------------ */
/* Reiter: Tausch                                                      */
/* ------------------------------------------------------------------ */

/* Der Schluessel der Kaufzeile ist der Tages-Key ('YYYY-MM-DD'). Der Tag wird
 * gelesen, nie umgerechnet (dateText liest einen Key als Key). */
function purchaseRow(item) {
  const who = state.children?.find((c) => c.id === item.reported_by)?.display_name;
  const meta = who
    ? `${esc(t('mediaTime.purchaseReportedBy'))} ${esc(who)} · ${esc(dateTimeText(item.created_at))}`
    : esc(dateTimeText(item.created_at));
  return `
    <li class="list-row">
      <div class="list-row__main">
        <p class="list-row__name">${esc(dateText(item.minute_key))}</p>
        <p class="list-row__meta">${meta}</p>
      </div>
      <span class="list-row__end">+${esc(minutesLabel(item.used_minutes))}</span>
    </li>`;
}

function renderExchange(el) {
  const items = state.purchases ?? [];
  const exchange = state.today?.exchange;
  const cta = (state.canManage && exchange) ? `
    <div class="mt-row-actions">
      <button class="btn btn--primary" type="button" data-action="mt-open-purchase">
        <i data-lucide="coins" aria-hidden="true"></i>${esc(t('mediaTime.exchangeCta'))}
      </button>
    </div>` : '';
  const body = items.length
    ? `<ul class="row-carrier">${items.map(purchaseRow).join('')}</ul>`
    : emptyStateHTML({
      icon: 'coins',
      title: t('mediaTime.exchangeEmptyTitle'),
      description: t('mediaTime.exchangeExplanation'),
    });
  el.insertAdjacentHTML('beforeend', `
    <div class="media-time-content__inner">
      ${childPickerHtml()}
      <section class="mt-section" aria-labelledby="mt-purchases-title">
        <h2 class="mt-section__title u-section-title" id="mt-purchases-title">${esc(t('mediaTime.purchasesTitle'))}</h2>
        ${cta}
        ${body}
      </section>
    </div>`);
  wireChildPicker(el, _container);
  el.querySelector('[data-action="mt-open-purchase"]')
    ?.addEventListener('click', () => openPurchaseModal());
}

/* ------------------------------------------------------------------ */
/* Einstieg                                                            */
/* ------------------------------------------------------------------ */

export async function render(container, { user } = {}) {
  state.user = user || null;
  state.tab = tabFromPath(location.pathname);
  _container = container;
  renderShell(container);
  await renderCurrentTab(container);
}

/**
 * Soft-Navigation zwischen den Reiter-Adressen (Router). Adressenwechsel ist
 * ein Reiterwechsel: derselbe Traeger, Inhalt in Schrittrichtung.
 * @returns {Promise<boolean>} false, wenn die Seite nicht steht.
 */
export async function update({ path, user } = {}) {
  if (!_container?.isConnected || !content()) return false;
  if (user) state.user = user;
  const tab = tabFromPath(path || location.pathname);
  if (tab !== state.tab) {
    const from = TAB_ORDER.indexOf(state.tab);
    state.tab = tab;
    _tabs?.sync(tab);
    await renderCurrentTab(_container, { direction: TAB_ORDER.indexOf(tab) - from });
  }
  return true;
}
