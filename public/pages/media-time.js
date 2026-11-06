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
import { dateText, dateTimeText, clockText as clockOf } from '/utils/date-format.js';
import { t, getNumberFormat, parseTimeInput } from '/i18n.js';
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
  /* Familienstand des 'heute'-Reiters (Redesign 06.11.): eine Karte je Kind.
   * Eintrag: { userId, displayName, data (/today), checkins, dayNotes }.
   * null = Einzelkarten-Modus (Kind ohne Managerrechte, oder Haushalt ohne
   * Kontingente) - dann tragen today/checkins/dayNotes die eigene Person. */
  todayCards: null,
  /* Buchungen des Tages (GET /sessions): null = keine Antwort (in der
   * Uebergangszeit der Hintergrunddienst nicht da) - die Flaechen sagen dann
   * nichts, statt "keine Buchungen" zu behaupten. */
  sessions: null,
  /* Alle Kontingent-Zeilen (GET /quotas): Kind-zeilen ohne device_id,
   * Geraete-limits mit device_id (Kontract der Backend-Lane). */
  quotaRows: null,
  /** Anpassungen des Tages (day-notes) fuer das gewaehlte Kind; null = nie geladen. */
  dayNotes: null,
  checkins: null,
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
 * es keinen Picker, die Seite fragt nur die eigene Person. Die Antwort traegt
 * seit dem Familien-Redesign auch die Geraete-limits (Zeilen mit device_id) -
 * die zaehlen nicht zu den Kindern, bleiben aber als quotaRows stehen. */
async function ensureChildren() {
  try {
    const [res, members] = await Promise.all([
      api.get('/media-time/quotas'),
      // Kinder ohne Kontingent-Zeile existierten fuer die Seite sonst nicht -
      // genau darin lag, dass das zweite Kind unsichtbar blieb. /family/members
      // liefert den ganzen Haushalt in der Familienreihenfolge.
      api.get('/family/members').then((r) => r.data || []).catch(() => []),
    ]);
    const rows = (res.data || []).filter((r) => Number.isInteger(r.user_id));
    state.quotaRows = rows;
    const byId = new Map(rows
      .filter((r) => r.device_id == null)
      .map((r) => [r.user_id, { id: r.user_id, display_name: r.display_name || r.username || String(r.user_id) }]));
    const seen = new Set();
    const merged = [];
    for (const m of members) {
      if (m.family_role !== 'child' || !Number.isInteger(m.id) || seen.has(m.id)) continue;
      seen.add(m.id);
      merged.push(byId.get(m.id) || { id: m.id, display_name: m.display_name || String(m.id) });
    }
    for (const [id, c] of byId) if (!seen.has(id)) merged.push(c);
    state.children = merged;
    state.canManage = true;
  } catch (err) {
    if ((err?.status ?? err?.response?.status) === 403) {
      state.canManage = false;
      state.children = null;
      state.quotaRows = null;
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

/* Die Kontingent-zeile eines Kindes (ohne Geraetebindung) und das Limit eines
 * Geraets - beide aus quotaRows; fehlt die Zeile, fehlt die Auskunft. */
function quotaRowFor(userId) {
  return (state.quotaRows || []).find((r) => r.user_id === userId && r.device_id == null) ?? null;
}

function deviceLimitFor(userId, deviceId) {
  if (deviceId == null) return null;
  return (state.quotaRows || []).find((r) => r.user_id === userId && r.device_id === deviceId) ?? null;
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

/* Der Tag als Schluessel ('YYYY-MM-DD', lokale Zeit) - fuer die Sessions-Abfrage
 * und fuer die Start-/Ende-Zeiten einer Buchung. */
function localDayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/* Die Karte eines Kindes: Tagesstand, Check-ins und Anpassungen parallel. Eine
 * Kindantwort, die failt, faellt aus der Familienansicht - die andern Kinder
 * bleiben lesbar (Promise.all statt Abbruch der ganzen Seite). */
async function loadChildCard(userId) {
  const [today, checkins, dayNotes] = await Promise.all([
    api.get(`/media-time/today?user_id=${encodeURIComponent(userId)}`).then((r) => r.data ?? null).catch(() => null),
    api.get(`/media-time/checkins?user_id=${encodeURIComponent(userId)}`)
      .then((r) => r.data?.items ?? [])
      .catch((err) => ((err?.status ?? err?.response?.status) === 403 ? [] : null)),
    api.get(`/media-time/quotas/${encodeURIComponent(userId)}/day-notes`)
      .then((r) => r.data?.items ?? [])
      .catch((err) => ((err?.status ?? err?.response?.status) === 403 ? [] : null)),
  ]);
  return { userId, displayName: childNameFor(userId), data: today, checkins, dayNotes };
}

/* Die Buchungen des Tages. Die Route antwortet pro Kind (GET /sessions mit
 * user_id); Eltern ziehen alle Kinder parallel und fuellen eine gemeinsame
 * Liste, ein Kind fragt die eigenen ab (ohne user_id - der Server nimmt den
 * Anrufer). Scheitern alle Abfragen (die Route waechst in der Parallel-Lane),
 * bleibt null: die Buchungszone sagt dann nichts - still, ohne Fehlerbild. */
async function loadSessions() {
  const day = encodeURIComponent(localDayKey());
  const ids = state.canManage && state.children?.length
    ? state.children.map((c) => c.id)
    : [null];
  const settled = await Promise.allSettled(ids.map((id) => {
    const q = id != null ? `&user_id=${encodeURIComponent(id)}` : '';
    return api.get(`/media-time/sessions?day=${day}${q}`)
      .then((r) => (Array.isArray(r.data) ? r.data : (r.data?.items ?? [])));
  }));
  const ok = settled.filter((s) => s.status === 'fulfilled');
  if (!ok.length) { state.sessions = null; return; }
  state.sessions = ok
    .flatMap((s) => s.value)
    .sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')));
}

async function loadToday() {
  if (state.canManage) await ensureChildren();
  else state.canManage = false;
  const tasks = [loadSettingsLite(), ensureDevicesLite(), loadSessions()];
  if (state.canManage && state.children?.length) {
    // Familienansicht: jedes Kind mit eigener Tageskarte, nebeneinander gestapelt.
    tasks.push((async () => {
      const cards = await Promise.all(state.children.map((c) => loadChildCard(c.id)));
      state.todayCards = cards;
      const first = cards.find((c) => c.data) ?? cards[0] ?? null;
      state.today = first?.data ?? null;
      if (first) state.selectedChildId = first.userId;
    })());
  } else {
    // Einzelkarte (Kind ohne Managerrede, oder Haushalt ohne Kontingente).
    state.todayCards = null;
    tasks.push((async () => {
      const [today] = await Promise.all([
        api.get('/media-time/today'),
        loadCheckins(),
        loadDayNotes(),
      ]);
      state.today = today.data ?? null;
    })());
  }
  await Promise.all(tasks);
}

/* Check-ins (Einbuchen/Ausbuchen, Nutzer 05.11.): die offenen und die letzten
 * Sitzungen des gewaehlten Kindes. Scheitert der Zugriff (Kind ohne Geraet),
 * bleibt null: die Flaeche zeigt dann nichts, statt "nichts gebucht" zu
 * behaupten. Geraete fuer die Auswahl sind Manager-Pfad - ein Kind bucht auf
 * seinem einzige(n) Geraet, wenn es genau eins kennt, sonst die Liste. */
async function loadCheckins() {
  const target = state.canManage
    ? state.selectedChildId
    : (Number.isInteger(state.user?.id) ? state.user.id : null);
  if (target == null) { state.checkins = null; return; }
  try {
    const res = await api.get(`/media-time/checkins?user_id=${encodeURIComponent(target)}`);
    state.checkins = res.data?.items ?? [];
  } catch (err) {
    const status = err?.status ?? err?.response?.status;
    state.checkins = status === 403 ? [] : null;
  }
}

/* Die Anpassungen des Tages (Eltern-Notizen): Eltern sehen sie pro gewaehltem
 * Kind, Kinder sehen IHRE EIGENE Historie (Transparenz, Nutzer 04.11.: "Kinder
 * sehen die Begruendung"). Der Server-Pfad laesst beides zu (GET /day-notes:
 * eigenes Kind oder Elter). Scheitert die Abfrage anders als am Recht, bleibt
 * null: die Liste sagt dann nichts, statt "heute nichts" zu behaupten. */
async function loadDayNotes() {
  const target = state.canManage
    ? state.selectedChildId
    : (Number.isInteger(state.user?.id) ? state.user.id : null);
  if (target == null) {
    state.dayNotes = [];
    return;
  }
  try {
    const res = await api.get(`/media-time/quotas/${encodeURIComponent(target)}/day-notes`);
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

/* Der FAB traegt die einzige Primaktion des Reiters: auf 'heute' die Buchung
 * (Elternpfad), auf 'Geraete' das neue Geraet. Auf den andern Reitern gibt es
 * keine Primaktion, die einen Knopf verdient haette. */
let fab = null;

function updateMediaTimeFab() {
  if (!fab) return;
  const keepNoun = () => fab.dataset?.dockLabel || t('newLabel.mediaTime');
  if (!state.canManage) {
    setPageFabAction(fab, { hidden: true, dockLabel: keepNoun() });
    return;
  }
  if (state.tab === 'today' && state.children?.length) {
    setPageFabAction(fab, {
      label: t('mediaTime.bookingAdd'),
      dockLabel: t('newLabel.mediaTime'),
      onClick: () => openBookingModal(),
    });
    return;
  }
  if (state.tab !== 'devices') {
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
        <h1 class="page-toolbar__title" id="media-time-title">${esc(t('nav.mediaTime'))}</h1>
        <div class="page-toolbar__actions"></div>
        <nav class="media-time-tabs page-toolbar__bar" role="tablist" aria-label="${esc(t('nav.mediaTime'))}">
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
      <label class="label" for="mt-child">${esc(t('mediaTime.childSwitchTitle'))}</label>
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

/* ------------------------------------------------------------------ */
/* Check-in / Check-out (Einbuchen/Ausbuchen, Nutzer 05.11.)            */
/* ------------------------------------------------------------------ */

/* Geraete fuer die Karten und den Buchungs-Dialog: GET /devices ist Manager-Pfad
 * und liefert allen Kindern auf einmal (Gereraeteliste nach user_id gruupierbar);
 * ein Kind fragt sich selbst ab (?user_id=), der Server laesst es nur eigene
 * Geraete sehen. Scheitert der Zugriff (403), bleibt null: die Kachel sagt dann
 * nichts, statt "kein Geraet" zu behaupten. */
async function ensureDevicesLite() {
  if (state.devices != null) return;
  const target = state.canManage ? null
    : (Number.isInteger(state.user?.id) ? state.user.id : null);
  if (!state.canManage && target == null) { state.devices = null; return; }
  const path = state.canManage
    ? '/media-time/devices'
    : `/media-time/devices?user_id=${encodeURIComponent(target)}`;
  try {
    const res = await api.get(path);
    state.devices = res.data ?? [];
  } catch (err) {
    const status = err?.status ?? err?.response?.status;
    state.devices = status === 403 ? null : (state.devices ?? null);
  }
}

function checkinDeviceName(deviceId) {
  const dev = (state.devices || []).find((d) => d.id === deviceId);
  return dev?.name || t('mediaTime.deviceLabel');
}

/* Check-in-Block pro Kindkarte (Einbuchen/Ausbuchen, Nutzer 05.11.): "Jedes
 * Kind soll sich einbuchen und ausbuchen koennen." Geraete ohne Agent (Konsole,
 * Fernseher) fuehrt das Kind den Buch selbst - die offenen Sitzungen zuerst,
 * darunter ein Knopf je freiem Geraet. Kinder durfen nur ihr eigenes Geraet
 * buchen (Serverrecht); der Block haengt unter den Geraetezeilen der Karte. */
function checkinBlockHtml(card) {
  const items = card.checkins;
  if (!Array.isArray(items)) return '';
  const open = items.filter((c) => !c.ended_at);
  const closed = items.filter((c) => c.ended_at);
  const devices = (state.devices || [])
    .filter((d) => !d.revoked_at)
    .filter((d) => !state.canManage || d.user_id === card.userId);
  if (!devices.length && !open.length) return '';
  const rows = open.map((c) => `
    <li class="list-row">
      <div class="list-row__main">
        <p class="list-row__name">${esc(t('mediaTime.checkinOpen', { device: checkinDeviceName(c.device_id) }))}</p>
        <p class="list-row__meta">${esc(t('mediaTime.checkinSince', { time: dateTimeText(c.started_at) }))}</p>
      </div>
      <button class="btn btn--secondary btn--sm" type="button" data-action="mt-checkout" data-checkin-id="${Number(c.id)}">
        <i data-lucide="log-out" aria-hidden="true"></i>${esc(t('mediaTime.checkOut'))}
      </button>
    </li>`).join('');
  const bookButtons = devices
    .filter((d) => !open.some((c) => c.device_id === d.id))
    .map((d) => `
      <button class="btn btn--secondary btn--sm" type="button" data-action="mt-checkin" data-checkin-user="${Number(card.userId)}" data-device-id="${Number(d.id)}">
        <i data-lucide="log-in" aria-hidden="true"></i>${esc(t('mediaTime.checkInOn', { device: esc(d.name) }))}
      </button>`).join(' ');
  const last = closed.slice(0, 3).map((c) =>
    `${esc(checkinDeviceName(c.device_id))} ${esc(dateTimeText(c.started_at))}`
  ).join(', ');
  return `
    <div class="mt-checkin">
      <h3 class="mt-group-title">${esc(t('mediaTime.checkinTitle'))}</h3>
      <p class="mt-section__note">${esc(t('mediaTime.checkinHint'))}</p>
      ${rows ? `<ul class="row-carrier">${rows}</ul>` : ''}
      ${bookButtons ? `<div class="mt-checkin__actions">${bookButtons}</div>` : ''}
      ${last ? `<p class="mt-section__note">${esc(t('mediaTime.checkinRecent', { list: last }))}</p>` : ''}
    </div>`;
}

async function doCheckin(childId, deviceId) {
  const target = childId ?? (Number.isInteger(state.user?.id) ? state.user.id : null);
  if (target == null) return;
  try {
    await api.post('/media-time/checkins', { user_id: target, device_id: deviceId });
    toast(t('mediaTime.checkinDone'));
    await reloadAfterSave(async () => {
      await renderCurrentTab(_container, { direction: 0 });
    });
  } catch (e) {
    toast(mediaTimeErrorSentence(e), 'danger');
  }
}

async function doCheckout(checkinId) {
  try {
    await api.post(`/media-time/checkins/${encodeURIComponent(checkinId)}/end`, {});
    toast(t('mediaTime.checkoutDone'));
    await reloadAfterSave(async () => {
      await renderCurrentTab(_container, { direction: 0 });
    });
  } catch (e) {
    toast(mediaTimeErrorSentence(e), 'danger');
  }
}

/* Laufbalken-Ticker (Nutzer 05.11.): die Tageskarten leben. Waehrend eine
 * Buchung laeuft, tickt der Mitlauf-Zaehler alle 30 Sekunden - das Kind sieht
 * Bewegung, ohne nachzuladen. Der Zaehler haelt seine Startzeit im Datenattribut,
 * der Takt aktualisiert alle Karten zugleich; ein zweiter Takt wird nicht
 * eroffnet (dieselbe Frequenz, die die Seite schon hat). */
let _tickerTimer = null;
function elapsedTextFor(startIso) {
  const seen = new Date(startIso).getTime();
  if (!Number.isFinite(seen)) return '';
  const min = Math.max(0, Math.floor((Date.now() - seen) / 60000));
  return t('mediaTime.tickerElapsed', { min: fmtNum(min) });
}
function tickerHtml(data, checkins) {
  const open = (Array.isArray(checkins) ? checkins : []).find((c) => !c.ended_at);
  let text;
  let live = false;
  let startAttr = '';
  if (data.quiet_active) text = t('mediaTime.tickerQuiet');
  else if (open) {
    text = `${t('mediaTime.tickerRunning', { time: clockOf(open.started_at, { suffix: false }) })} - `;
    live = true;
    startAttr = ` data-checkin-start="${esc(open.started_at)}"`;
  } else text = t('mediaTime.tickerIdle');
  const elapsed = open ? elapsedTextFor(open.started_at) : '';
  return `<p class="mt-ticker"><span class="mt-ticker__dot${live ? ' mt-ticker__dot--live' : ''}" aria-hidden="true"></span>${esc(text)}<span data-mt-ticker-elapsed${startAttr}>${esc(elapsed)}</span></p>`;
}
function startTicker() {
  if (_tickerTimer) return;
  _tickerTimer = setInterval(() => {
    if (!_container?.isConnected || !content()) {
      clearInterval(_tickerTimer);
      _tickerTimer = null;
      return;
    }
    _container.querySelectorAll('[data-checkin-start]').forEach((el) => {
      el.textContent = elapsedTextFor(el.dataset.checkinStart);
    });
  }, 30_000);
}

/* Family-Link-Istzeit auf der Tageskarte (Spec 287). Ohne Zuordnung steht
 * hier nichts; ohne Collector-Sitzion steht der Hinweis, NIE eine Null.
 * Die Minuten zaehlen bereits im Balken (dayUsage-Ersatz) - dieser Block ist
 * die Auskunft ueber die Quelle, nicht das Konto. */
function familylinkDetailsHtml(fl) {
  if (!fl || !fl.mapped) return '';
  if (fl.status === 'login_noetig') {
    return `<p class="mt-meta__fl mt-meta__fl--warn">${esc(t(state.canManage ? 'mediaTime.flLoginParent' : 'mediaTime.flLoginChild'))}</p>`;
  }
  if (!fl.devices?.length) return `<p class="mt-meta__fl">${esc(t('mediaTime.flNoneToday'))}</p>`;
  const total = fl.devices.reduce((s, r) => s + (r.consumed_min || 0), 0);
  const lines = fl.devices.map((r) => {
    if (!r.media_time_device_id) return '';
    return `<p class="mt-meta__fl">${esc(r.device_name || t('mediaTime.flDevice'))}: ${esc(t('mediaTime.flGoogleMin', { min: fmtNum(Math.round(r.consumed_min || 0)) }))}</p>`;
  }).join('');
  return `<p class="mt-meta__fl mt-meta__fl--head">${esc(t('mediaTime.flSourceLine', { min: fmtNum(Math.round(total)) }))}</p>${lines}`;
}

/* Familienansicht (Redesign 06.11.): das eine Bild des Tages. Zone 1 ist eine
 * Karte je Kind (Restzeit als Hero, Klartext-Satz, Balken, Budget-Zeile,
 * Geraetezone, Check-in, Family-Link eingeklappt). Zone 2 sind die Buchungen
 * des Tages als eine Liste fuer den ganzen Haushalt. Der Rest (Regeln, Geraete,
 * Tausch) steht in seinen Reitern. */

/* Die Karten des heutigen Bildes: Manager sehen alle Kinder gestapelt; ohne
 * Managerliste (Kind, oder Haushalt ohne Kontingente) traegt die eigene Person
 * die eine Karte - dieselben Bausteine, damit das Bild nie zwei Gesichter hat. */
function todayCards() {
  if (state.todayCards?.length) return state.todayCards.filter((c) => c.data);
  if (state.today) {
    return [{
      userId: state.selectedChildId ?? (Number.isInteger(state.user?.id) ? state.user.id : null),
      displayName: state.canManage && state.selectedChildId != null
        ? childNameFor(state.selectedChildId) : null,
      data: state.today,
      checkins: state.checkins,
      dayNotes: state.dayNotes,
    }];
  }
  return [];
}

/* Icon nach Geraeteart (media_time_devices.platform); unbekannt bleibt das
 * allgemeine Geraetesignal. */
function platformIcon(platform) {
  if (platform === 'windows') return 'monitor';
  if (platform === 'console') return 'gamepad-2';
  if (platform === 'tv') return 'tv';
  return 'smartphone';
}

/* Der Tracker-Stand als Meta-Zeilen (aufgeklappte Einzelheiten der Karte). */
function trackerMetaHtml(data) {
  const quiet = data.quiet
    ? `<span class="mt-meta__quiet"><span class="mt-chip mt-chip--quiet">${esc(t('mediaTime.quietWindowLabel', {
      from: esc(data.quiet.from), to: esc(data.quiet.to),
    }))}</span></span>`
    : '';
  return `
      ${metaCell(t('mediaTime.trackerLabel'),
    data.tracker?.online ? t('mediaTime.trackerOnline') : t('mediaTime.trackerOffline'))}
      ${metaCell(t('mediaTime.lastSeenLabel'), esc(seenAgoText(data.tracker?.last_seen_at)))}
      ${quiet}`;
}

/* Geraetezone der Karte: eine Zeile je Geraet, das GET /today fuer den Tag
 * nennt (data.devices - Kontract der Backend-Lane). Fehlt das Feld, fehlt die
 * Zone: kein Bild erfindet hier "keine Nutzung". */
function deviceUsageHtml(card) {
  const rows = Array.isArray(card.data.devices) ? card.data.devices : null;
  if (!rows || !rows.length) return '';
  const total = rows.reduce((s, r) => s + (Number(r.minutes) || 0), 0);
  /* Quelle der Minuten: steht auf dem Geraet eine manuelle Buchung des Tages,
   * sagt das Badge "manuell", sonst "automatisch" (Agent oder Family-Link). */
  const manualNames = new Set((state.sessions || [])
    .filter((s) => s.user_id === card.userId && s.source === 'manual')
    .map((s) => String(s.device_name ?? '')));
  const items = rows.map((row) => {
    const dev = (state.devices || []).find((d) => d.id === row.device_id) ?? null;
    const name = row.device_name || dev?.name || t('mediaTime.deviceUnnamed');
    const mins = Number(row.minutes) || 0;
    const share = total > 0 ? Math.min(1, mins / total) : 0;
    const limit = deviceLimitFor(card.userId, row.device_id);
    const manual = manualNames.has(String(row.device_name ?? ''));
    const menu = (state.canManage && row.device_id != null) ? rowMenuHtml({
      id: `mt-usage-menu-${card.userId}-${row.device_id}`,
      label: t('common.moreActionsNamed', { name }),
      items: [{
        action: 'device-limit', icon: 'sliders-horizontal',
        label: t('mediaTime.deviceLimitAction'),
        attrs: { 'data-limit-user': card.userId, 'data-limit-device': row.device_id, 'data-limit-name': name },
      }],
    }) : '';
    return `
      <li class="list-row mt-usage-row">
        <div class="list-row__main">
          <p class="list-row__name"><i class="mt-usage-row__icon" data-lucide="${platformIcon(dev?.platform)}" aria-hidden="true"></i>${esc(name)}</p>
          <p class="list-row__meta">${esc(platformLabel(dev?.platform))}${limit?.daily_minutes != null ? ` · <span class="tag">${esc(t('mediaTime.deviceLimitChip', { minutes: fmtNum(limit.daily_minutes) }))}</span>` : ''}</p>
          <span class="mt-share" aria-hidden="true"><span class="mt-share__fill" style="--mt-progress:${share}"></span></span>
        </div>
        <div class="mt-usage-row__end">
          <span class="list-row__end">${esc(minutesLabel(mins))}</span>
          <span class="tag">${esc(t(manual ? 'mediaTime.sourceManual' : 'mediaTime.sourceAutomatic'))}</span>
        </div>
        ${menu ? `<div class="list-row__actions">${menu}</div>` : ''}
      </li>`;
  }).join('');
  return `
    <div class="mt-usage">
      <h3 class="mt-group-title">${esc(t('mediaTime.devicesTodayTitle'))}</h3>
      <ul class="row-carrier">${items}</ul>
    </div>`;
}

/* Die eine Kindkarte: Restzeit als Hero, Klartext-Satz, Balken (nutzt/Total),
 * Budget-Chip (Manager aendert ihn hier), Geraetezone, Check-in-Block, und das
 * Fachwort (Tracker, Family-Link) eingeklappt unter dem gewohnten Satz. */
function childCardHtml(card) {
  const data = card.data;
  const uid = card.userId ?? 'self';
  const titleId = `mt-child-${uid}-title`;
  const chip = chipFor(data);
  const head = `
        <div class="mt-card__head">
          <h2 class="mt-card__title" id="${titleId}">${card.displayName ? esc(card.displayName) : esc(t('mediaTime.todayTitleChild'))}</h2>
          <span class="${chip.cls}">${esc(chip.label)}</span>
        </div>`;
  if (!data.enabled) {
    return `
      <section class="mt-section mt-card mt-child-card" aria-labelledby="${titleId}">
        ${head}
        <p class="mt-section__note">${esc(t('mediaTime.disabledBody'))}</p>
      </section>`;
  }
  const quota = Number(data.quota_min || 0);
  const remaining = Math.max(0, Number(data.remaining_min || 0));
  const used = Math.max(0, quota - remaining);
  /* Der Balken fuellt sich mit der Nutzung (nutzt/Total). Die Toende folgen dem
   * Chip-Muster: ok = Akzent, nearing = Warnung, exceeded = Alarm. */
  const barState = data.quiet_active ? 'quiet'
    : (data.state === 'exceeded' ? 'exceeded'
      : (data.state === 'nearing' ? 'nearing' : (quota > 0 ? 'ok' : 'none')));
  const ratio = quota > 0 ? Math.max(0, Math.min(1, used / quota)) : 0;
  const progressLabel = t('mediaTime.remainingOfQuota', {
    remaining: fmtNum(remaining),
    quota: fmtNum(quota),
  });
  const usedSentence = t('mediaTime.usedToday', { used: fmtNum(used), quota: fmtNum(quota) });
  const stateSentence = {
    ok: '', nearing: t('mediaTime.barNearing'), exceeded: t('mediaTime.barExceeded'),
    quiet: t('mediaTime.barQuiet'), none: t('mediaTime.barNoQuota'),
  }[barState];
  const sentence = stateSentence ? `${usedSentence} - ${stateSentence}` : usedSentence;
  /* Die Budget-Zeile: das Tagesbudget als Chip; Manager aendern ihn gleich hier
   * (Presets + freie Zahl). Die harte Obergrenze ist ein Fortgeschrittenen-Satz
   * und steht nur, wenn eine Zeile sie traegt. */
  const qRow = quotaRowFor(card.userId);
  const budgetValue = qRow?.daily_minutes ?? quota;
  const budgetChip = state.canManage
    ? `<button class="mt-chip mt-budget-chip" type="button" data-action="mt-open-budget" data-budget-child="${Number(card.userId)}">
         <i data-lucide="wallet" aria-hidden="true"></i>${esc(t('mediaTime.budgetChip', { minutes: fmtNum(budgetValue) }))}
       </button>`
    : `<span class="mt-chip">${esc(t('mediaTime.budgetChip', { minutes: fmtNum(budgetValue) }))}</span>`;
  const hardCap = qRow?.max_daily_minutes != null
    ? `<span class="mt-hardcap-line">${esc(t('mediaTime.budgetHardCap', { minutes: fmtNum(qRow.max_daily_minutes) }))}</span>`
    : '';
  /* Die Anpassung des Tages (Eltern-Notiz, Entscheidung 4): Basis + Anpassung =
   * Kontingent. Der Knopf steht nur Eltern (PUT ist requireManager); die
   * Begruendung lesen Kinder ohne Frage. */
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
        ${state.canManage ? `<button class="btn btn--secondary btn--sm" type="button" data-action="mt-open-adjust" data-adjust-child="${Number(card.userId)}">
          <i data-lucide="pencil" aria-hidden="true"></i>${esc(t('mediaTime.adjustAction'))}
        </button>` : ''}
      </p>
      ${reasonText ? `<p class="mt-quota-reason">${esc(t('mediaTime.quotaReason', { reason: reasonText }))}</p>` : ''}`;
  /* Die Anpassungen des Tages als Protokoll unter der Karte: Eltern sehen ihr
   * Kind, ein Kind sieht sich selbst (Transparenz ist die Regel). */
  const notes = card.dayNotes;
  const notesBlock = Array.isArray(notes) && notes.length
    ? `
      <div class="mt-daynotes">
        <h3 class="mt-group-title">${esc(t('mediaTime.dayNotesTitle'))}</h3>
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
      </div>` : '';
  /* Der Tauschweg (Punkte -> Minuten) bleibt auf der Karte: derselbe Kurs wie
   * im vierten Reiter, in einem Satz; der Knopf ist Elternpfad (POST prueft). */
  const exchange = data.exchange ? `
    <div class="mt-exchange">
      <p class="mt-section__note">${esc(state.canManage
    ? t('mediaTime.exchangeHint', { points: fmtNum(data.exchange.points), minutes: fmtNum(data.exchange.minutes) })
    : t('mediaTime.exchangeHintChild', { points: fmtNum(data.exchange.points), minutes: fmtNum(data.exchange.minutes) }))}</p>
      <div class="mt-row-actions"><button class="btn btn--secondary btn--sm" type="button" data-action="mt-open-purchase" data-purchase-child="${Number(card.userId)}">
        <i data-lucide="coins" aria-hidden="true"></i>${esc(state.canManage ? t('mediaTime.exchangeCta') : t('mediaTime.exchangeCtaChild'))}
      </button></div>
    </div>` : '';
  return `
    <section class="mt-section mt-card mt-child-card" aria-labelledby="${titleId}">
      ${head}
      <p class="mt-hero" aria-hidden="true"><span class="mt-hero__num">${esc(fmtNum(remaining))}</span><span class="mt-hero__unit">${esc(t('mediaTime.heroFreeUnit'))}</span></p>
      <p class="mt-hero__sentence mt-hero__sentence--${barState}">${esc(sentence)}</p>
      <div class="mt-progress__track" role="progressbar"
           aria-label="${esc(t('mediaTime.progressLabel'))}"
           aria-valuenow="${fmtNum(used)}" aria-valuemin="0" aria-valuemax="${fmtNum(quota)}"
           aria-valuetext="${esc(progressLabel)}"><div class="mt-progress__fill mt-progress__fill--${barState}" style="--mt-progress:${ratio}"></div></div>
      <p class="mt-progress__label" aria-hidden="true">${esc(progressLabel)}</p>
      <p class="mt-budget-line">${budgetChip}${hardCap}</p>
      ${quotaLine}
      ${deviceUsageHtml(card)}
      ${tickerHtml(data, card.checkins)}
      ${checkinBlockHtml(card)}
      ${exchange}
      <details class="mt-details">
        <summary class="mt-details__summary">${esc(t('mediaTime.detailTitle'))}</summary>
        <p class="mt-details__hint">${esc(t('mediaTime.detailHint'))}</p>
        <div class="mt-meta">
          ${metaCell(t('mediaTime.metaCharged'), minutesLabel(data.charged_min))}
          ${metaCell(t('mediaTime.metaExempt'), minutesLabel(data.exempt_min))}
          ${metaCell(t('mediaTime.metaUnknown'), minutesLabel(data.unknown_min))}
          ${metaCell(t('mediaTime.metaPurchased'), minutesLabel(data.purchased_min))}
          ${(Number(data.duty_min) || 0) > 0 ? metaCell(t('mediaTime.metaDuty'), minutesLabel(data.duty_min)) : ''}
          ${trackerMetaHtml(data)}
          ${familylinkDetailsHtml(data.familylink)}
        </div>
      </details>
      ${notesBlock}
    </section>`;
}

/* Zone 2: die Buchungen des Tages, eine Liste fuer den ganzen Haushalt. Keine
 * Antwort (die Route waechst in der Parallel-Lane) laesst die Zone still
 * wegfallen - eine Antwort mit leerer Liste ist der erklaerende Leerzustand. */
function bookingsSectionHtml() {
  const rows = state.sessions;
  if (!Array.isArray(rows)) return '';
  const add = state.canManage ? `
      <button class="btn btn--primary btn--sm" type="button" data-action="mt-booking-add">
        <i data-lucide="plus" aria-hidden="true"></i>${esc(t('mediaTime.bookingAdd'))}
      </button>` : '';
  const body = rows.length
    ? `<ul class="row-carrier">${rows.map(bookingRowHtml).join('')}</ul>`
    : emptyStateHTML({
      icon: 'calendar-clock',
      title: t('mediaTime.bookingsEmptyTitle'),
      description: t('mediaTime.bookingsEmptyBody'),
      action: state.canManage
        // secondary: der FAB traegt 'Zeit buchen' bereits als Primaktion.
        ? { label: t('mediaTime.bookingAdd'), icon: 'plus', tone: 'secondary', className: 'mt-booking-add' }
        : undefined,
    });
  return `
    <section class="mt-section" aria-labelledby="mt-bookings-title">
      <div class="mt-section__head">
        <h2 class="mt-section__title u-section-title" id="mt-bookings-title">${esc(t('mediaTime.bookingsTitle'))}</h2>
        ${add}
      </div>
      ${body}
    </section>`;
}

/* Eine Buchungszeile: 'HH:MM - HH:MM · Kind · Geraet · N Min' mit Quelle-Badge.
 * Bearbeiten/Loeschen nur wo der Server die Zeile freigibt (editable) und die
 * Rechte stehen; Zeilen des Laufs (automatisch) bleiben, wie sie sind. Die
 * Notiz steckt in app_label ('manual' ist der Platzhalter des Servers). */
function bookingRowHtml(s) {
  const from = s.started_at ? clockOf(s.started_at, { suffix: false }) : '';
  const to = s.ended_at ? clockOf(s.ended_at, { suffix: false }) : '';
  const time = from && to ? `${from} - ${to}` : (from || dateTimeText(s.started_at));
  const device = s.device_name || t('mediaTime.bookingDeviceNone');
  const noteText = s.app_label && s.app_label !== 'manual' ? s.app_label : '';
  const app = noteText ? ` · ${esc(noteText)}` : '';
  const menu = (state.canManage && s.editable) ? rowMenuHtml({
    id: `mt-booking-menu-${s.id}`,
    label: t('common.moreActionsNamed', { name: device }),
    items: [
      { action: 'booking-edit', icon: 'pencil', label: t('mediaTime.bookingEdit'), attrs: { 'data-booking-edit': s.id } },
      { action: 'booking-delete', icon: 'trash-2', label: t('mediaTime.bookingDelete'), danger: true, attrs: { 'data-booking-delete': s.id } },
    ],
  }) : '';
  return `
    <li class="list-row" data-booking="${Number(s.id)}">
      <div class="list-row__main">
        <p class="list-row__name">${esc(time)} <span class="tag">${esc(t(s.source === 'manual' ? 'mediaTime.sourceManual' : 'mediaTime.sourceAutomatic'))}</span></p>
        <p class="list-row__meta">${esc(childNameFor(s.user_id))} · ${esc(device)} · ${esc(minutesLabel(s.used_minutes))}${app}</p>
      </div>
      ${menu ? `<div class="list-row__actions">${menu}</div>` : ''}
    </li>`;
}

function renderToday(el) {
  const cards = todayCards();
  const cardBlocks = cards.map(childCardHtml).join('');
  const emptyBlock = cards.length ? '' : emptyStateHTML({
    icon: 'hourglass',
    title: t('mediaTime.emptyTodayTitle'),
    description: t('mediaTime.emptyTodayBody'),
  });
  el.insertAdjacentHTML('beforeend', `
    <div class="media-time-content__inner">
      ${cardBlocks}${emptyBlock}
      ${bookingsSectionHtml()}
      ${setupStepsHtml()}
    </div>`);
  installPopoverMenus(el);
  el.querySelector('[data-action="mt-booking-add"]')
    ?.addEventListener('click', () => openBookingModal());
  el.querySelector('.mt-booking-add')
    ?.addEventListener('click', () => openBookingModal());
  el.querySelectorAll('[data-budget-child]').forEach((btn) =>
    btn.addEventListener('click', () => openBudgetModal(Number(btn.dataset.budgetChild))));
  el.querySelectorAll('[data-adjust-child]').forEach((btn) =>
    btn.addEventListener('click', () => openAdjustModal(Number(btn.dataset.adjustChild))));
  el.querySelectorAll('[data-purchase-child]').forEach((btn) =>
    btn.addEventListener('click', () => openPurchaseModal(Number(btn.dataset.purchaseChild))));
  el.querySelectorAll('[data-action="mt-checkin"]').forEach((btn) =>
    btn.addEventListener('click', () =>
      doCheckin(Number(btn.dataset.checkinUser), Number(btn.dataset.deviceId))));
  el.querySelectorAll('[data-action="mt-checkout"]').forEach((btn) =>
    btn.addEventListener('click', () => doCheckout(Number(btn.dataset.checkinId))));
  el.querySelectorAll('[data-limit-user]').forEach((btn) =>
    btn.addEventListener('click', () => openDeviceLimitModal(
      Number(btn.dataset.limitUser), Number(btn.dataset.limitDevice), btn.dataset.limitName ?? '')));
  el.querySelectorAll('[data-booking-edit]').forEach((btn) =>
    btn.addEventListener('click', () => openBookingModal(
      null, (state.sessions || []).find((s) => s.id === Number(btn.dataset.bookingEdit)) ?? null)));
  el.querySelectorAll('[data-booking-delete]').forEach((btn) =>
    btn.addEventListener('click', () => deleteBooking(
      (state.sessions || []).find((s) => s.id === Number(btn.dataset.bookingDelete)))));
}

/* ------------------------------------------------------------------ */
/* Buchen, Budget, Geraete-Limit                                       */
/* ------------------------------------------------------------------ */

/* Die Geraete-Auswahl des Buchungs-Dialogs: die Geraete des gewaehlten Kindes,
 * vornan 'Ohne Geraet' (null) fuer die Zeit ohne Tracker. */
function bookingDeviceOptions(userId, selectedDeviceId) {
  const devices = (state.devices || [])
    .filter((d) => !d.revoked_at && d.user_id === userId)
    .map((d) => `
    <option value="${d.id}"${d.id === selectedDeviceId ? ' selected' : ''}>${esc(d.name)}</option>`).join('');
  return `<option value=""${selectedDeviceId == null ? ' selected' : ''}>${esc(t('mediaTime.bookingDeviceNone'))}</option>${devices}`;
}

/* Kindwechsel im offenen Dialog: die Auswahl wird ueber die DOM-API neu
 * gebaut (der innerHTML-Kanon der App schreibt keine Nutzerdaten als
 * HTML-Zeichenkette zurueck). */
function paintBookingDevices(sel, userId) {
  sel.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = t('mediaTime.bookingDeviceNone');
  sel.appendChild(none);
  (state.devices || [])
    .filter((d) => !d.revoked_at && d.user_id === userId)
    .forEach((d) => {
      const opt = document.createElement('option');
      opt.value = String(d.id);
      opt.textContent = d.name;
      sel.appendChild(opt);
    });
}

/* Buchung anlegen oder aendern: wahlweise Zeitraum (Start + Ende) oder Dauer
 * (Minuten), dazu Geraet und Notiz. POST /media-time/sessions traegt beide
 * Formen (Kontract der Backend-Lane), Aenderungen laufen ueber PATCH. Die
 * Zeiteingabe folgt dem weiten Eingabekanon der App (parseTimeInput: "9:30",
 * "0930" und "9h30" sind dasselbe). */
function openBookingModal(presetChildId = null, existing = null) {
  if (!state.canManage) return;
  const children = state.children || [];
  if (!children.length) return;
  const userId = existing?.user_id ?? presetChildId ?? state.selectedChildId ?? children[0].id;
  /* Die Zeile von /sessions traegt den device_id (aeeltere Antworten nur den
   * Namen): erst die Kennung, dann der Name, sonst 'Ohne Geraet'. */
  let deviceId = existing?.device_id ?? null;
  if (existing && existing.device_id == null && existing.device_name) {
    const dev = (state.devices || [])
      .find((d) => d.user_id === userId && d.name === existing.device_name);
    deviceId = dev?.id ?? null;
  }
  /* PATCH aendert die Dauer (ended_at bleibt der Anker), nicht die Uhrzeit:
   * die Bearbeiten-Ansicht bietet darum nur die Dauer - der Zeitraum steht,
   * wie er gelaufen ist. */
  const modeLocked = !!existing;
  const hhmm = (iso) => (iso ? clockOf(iso, { suffix: false }) : '');
  const modalContext = captureModalContext();
  openModal({
    title: existing ? t('mediaTime.bookingEditTitle') : t('mediaTime.bookingAdd'),
    initialFocus: 'edit',
    content: `
      <form id="mt-booking-form" novalidate>
        <div class="form-group">
          <label class="label" for="mt-booking-child">${esc(t('mediaTime.bookingChildLabel'))}${REQUIRED_MARK}</label>
          <select class="input" id="mt-booking-child" required>${children.map((c) => `
            <option value="${c.id}"${c.id === userId ? ' selected' : ''}>${esc(c.display_name)}</option>`).join('')}</select>
        </div>
        <div class="form-group">
          <label class="label" for="mt-booking-device">${esc(t('mediaTime.deviceLabel'))}</label>
          <select class="input" id="mt-booking-device">${bookingDeviceOptions(userId, deviceId)}</select>
        </div>
        ${modeLocked ? '' : `
        <div class="form-group">
          <span class="label" id="mt-booking-mode-label">${esc(t('mediaTime.bookingModeGroupLabel'))}</span>
          <div class="mt-mode" role="group" aria-labelledby="mt-booking-mode-label">
            <button class="mt-mode__btn" type="button" data-mode="period" aria-pressed="false">${esc(t('mediaTime.bookingModePeriod'))}</button>
            <button class="mt-mode__btn mt-mode__btn--on" type="button" data-mode="duration" aria-pressed="true">${esc(t('mediaTime.bookingModeDuration'))}</button>
          </div>
        </div>
        <div data-mode-block="period" hidden>
          <div class="form-group">
            <label class="label" for="mt-booking-start">${esc(t('mediaTime.bookingFromLabel'))}${REQUIRED_MARK}</label>
            <input class="input mt-quiet__time" id="mt-booking-start" type="time" required value="">
          </div>
          <div class="form-group">
            <label class="label" for="mt-booking-end">${esc(t('mediaTime.bookingToLabel'))}${REQUIRED_MARK}</label>
            <input class="input mt-quiet__time" id="mt-booking-end" type="time" required value="">
          </div>
        </div>`}
        <div data-mode-block="duration">
          <div class="form-group">
            <label class="label" for="mt-booking-minutes">${esc(t('mediaTime.manualMinutesLabel'))}${REQUIRED_MARK}</label>
            <input class="input" id="mt-booking-minutes" type="number" min="1" max="720" step="1" inputmode="numeric" autocomplete="off" required
                   value="${existing && Number.isInteger(Number(existing.used_minutes)) && Number(existing.used_minutes) > 0 ? Number(existing.used_minutes) : ''}">
            ${existing && existing.started_at ? `<p class="form-hint">${esc(t('mediaTime.bookingEditAnchor', { time: `${hhmm(existing.started_at)} - ${hhmm(existing.ended_at)}` }))}</p>` : ''}
          </div>
        </div>
        <div class="form-group">
          <label class="label" for="mt-booking-note">${esc(t('mediaTime.manualNoteLabel'))}</label>
          <input class="input" id="mt-booking-note" maxlength="120" value="${esc(existing?.app_label && existing.app_label !== 'manual' ? existing.app_label : '')}">
        </div>
        <div id="mt-booking-error" class="form-error" role="alert" hidden></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary" id="mt-booking-submit">${esc(existing ? t('common.save') : t('common.add'))}</button>
        </div>
      </form>`,
    onSave: async (panel) => {
      const errEl = panel.querySelector('#mt-booking-error');
      const submit = panel.querySelector('#mt-booking-submit');
      const fail = (msg) => { errEl.textContent = msg; errEl.hidden = false; };
      const selChild = Number(panel.querySelector('#mt-booking-child').value) || userId;
      const devRaw = panel.querySelector('#mt-booking-device').value;
      const note = String(panel.querySelector('#mt-booking-note').value || '').trim() || null;
      const body = { user_id: selChild, device_id: devRaw === '' ? null : Number(devRaw), note };
      const active = panel.querySelector('.mt-mode__btn--on')?.dataset.mode || 'duration';
      if (active === 'period') {
        const st = parseTimeInput(panel.querySelector('#mt-booking-start').value);
        const en = parseTimeInput(panel.querySelector('#mt-booking-end').value);
        if (!st || !en) { fail(t('mediaTime.bookingTimeProblem')); return; }
        if (en <= st) { fail(t('mediaTime.bookingTimeOrder')); return; }
        const day = localDayKey();
        body.start_at = new Date(`${day}T${st}:00`).toISOString();
        body.end_at = new Date(`${day}T${en}:00`).toISOString();
      } else {
        const minutes = Number.parseInt(panel.querySelector('#mt-booking-minutes').value, 10);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720) {
          fail(t('mediaTime.bookingMinutesProblem'));
          return;
        }
        body.minutes = minutes;
      }
      submit.disabled = true;
      try {
        if (existing) {
          await api.patch(`/media-time/sessions/${encodeURIComponent(existing.id)}`, body);
        } else {
          await api.post('/media-time/sessions', body);
        }
        if (!isModalContextCurrent(modalContext)) return;
        closeModal({ force: true, context: modalContext });
        toast(t('mediaTime.bookingSaved'));
        await reloadAfterSave(async () => {
          await renderCurrentTab(_container, { direction: 0 });
          refocusAfterRender();
        });
      } catch (e) {
        submit.disabled = false;
        fail(mediaTimeErrorSentence(e));
      }
    },
  });
  /* Kind wechseln = Geraeteliste wechseln; der Umschalter schiebt die Felder.
   * Der Blick in den laufenden Dialog folgt dem offenen Muster der Seite
   * (openTokenModal): erst einhaengen, dann lauschen. */
  setTimeout(() => {
    const panel = document.querySelector('.modal-panel');
    if (!panel) return;
    panel.querySelector('#mt-booking-child')?.addEventListener('change', (ev) => {
      const sel = panel.querySelector('#mt-booking-device');
      if (sel) paintBookingDevices(sel, Number(ev.target.value));
    });
    panel.querySelectorAll('.mt-mode__btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.mt-mode__btn').forEach((b) => {
          const on = b === btn;
          b.classList.toggle('mt-mode__btn--on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        panel.querySelectorAll('[data-mode-block]').forEach((block) => {
          block.hidden = block.dataset.modeBlock !== btn.dataset.mode;
        });
      });
    });
  }, 0);
}

/* Buchung loeschen: die Rueckfrage nennt, was fort ist; der Tag rechnet neu
 * (dieselbe Confirm/Toast-Grammatik wie der Geraete-Entzug). */
async function deleteBooking(session) {
  if (!session || !state.canManage) return;
  const ok = await confirmOverModal(t('mediaTime.bookingDeleteTitle'), {
    confirmLabel: t('common.delete'),
    danger: true,
    detail: t('mediaTime.bookingDeleteDetail', {
      who: childNameFor(session.user_id),
      minutes: fmtNum(session.used_minutes),
    }),
  });
  if (!ok) return;
  try {
    await api.delete(`/media-time/sessions/${encodeURIComponent(session.id)}`);
    toast(t('mediaTime.bookingDeleted'));
    await reloadAfterSave(async () => {
      await renderCurrentTab(_container, { direction: 0 });
      refocusAfterRender();
    });
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

/* Tagesbudget (der editierbare Chip der Karte): Preset oder freie Zahl, PUT auf
 * die Kind-Zeile. PUT schreibt, was die Zeile schon haelt (enabled, harte
 * Obergrenze) - der Chip aendert die Zahl, keinen stillen Ruecksetzer. */
function openBudgetModal(childId) {
  if (!state.canManage) return;
  const row = quotaRowFor(childId);
  const card = (state.todayCards || []).find((c) => c.userId === childId);
  const current = row?.daily_minutes ?? Number(card?.data?.quota_min ?? 0);
  const maxCap = row?.max_daily_minutes ?? null;
  const presets = [30, 45, 60, 90];
  const modalContext = captureModalContext();
  openModal({
    title: t('mediaTime.budgetTitle', { name: childNameFor(childId) }),
    content: `
      <form id="mt-budget-form" novalidate>
        <div class="form-group">
          <span class="label">${esc(t('mediaTime.budgetPresetsLabel'))}</span>
          <div class="mt-row-actions">
            ${presets.map((p) => `<button class="btn btn--secondary btn--sm" type="button" data-budget-preset="${p}">${esc(minutesLabel(p))}</button>`).join('')}
          </div>
        </div>
        <div class="form-group">
          <label class="label" for="mt-budget-minutes">${esc(t('mediaTime.budgetMinutesLabel'))}${REQUIRED_MARK}</label>
          <input class="input" id="mt-budget-minutes" type="number" min="1" max="1440" step="1" inputmode="numeric" autocomplete="off" required
                 value="${Number.isInteger(Number(current)) && Number(current) > 0 ? Number(current) : ''}">
          ${maxCap != null ? `<p class="form-hint">${esc(t('mediaTime.budgetHardCap', { minutes: fmtNum(maxCap) }))}</p>` : ''}
        </div>
        <div id="mt-budget-error" class="form-error" role="alert" hidden></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary" id="mt-budget-submit">${esc(t('common.save'))}</button>
        </div>
      </form>`,
    onSave: async (panel) => {
      const errEl = panel.querySelector('#mt-budget-error');
      const submit = panel.querySelector('#mt-budget-submit');
      const minutes = Number.parseInt(panel.querySelector('#mt-budget-minutes').value, 10);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        errEl.textContent = t('mediaTime.budgetProblem');
        errEl.hidden = false;
        return;
      }
      const body = { daily_minutes: minutes, enabled: row ? row.enabled !== false : true };
      if (maxCap != null) body.max_daily_minutes = maxCap;
      submit.disabled = true;
      try {
        await api.put(`/media-time/quotas/${encodeURIComponent(childId)}`, body);
        if (!isModalContextCurrent(modalContext)) return;
        closeModal({ force: true, context: modalContext });
        toast(t('mediaTime.budgetSaved'));
        await reloadAfterSave(async () => {
          await renderCurrentTab(_container, { direction: 0 });
          refocusAfterRender();
        });
      } catch (err) {
        submit.disabled = false;
        errEl.textContent = mediaTimeErrorSentence(err);
        errEl.hidden = false;
      }
    },
  });
  setTimeout(() => {
    const panel = document.querySelector('.modal-panel');
    panel?.querySelectorAll('[data-budget-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = panel.querySelector('#mt-budget-minutes');
        if (input) input.value = btn.dataset.budgetPreset;
      });
    });
  }, 0);
}

/* Limit je Geraet (optional, Kontract: Zeile mit device_id): Minuten pro Tag
 * auf diesem Geraet; 0 hebt das Limit auf. */
function openDeviceLimitModal(childId, deviceId, deviceName) {
  if (!state.canManage) return;
  const limit = deviceLimitFor(childId, deviceId);
  const modalContext = captureModalContext();
  openModal({
    title: t('mediaTime.deviceLimitTitle', { name: deviceName || t('mediaTime.deviceLabel') }),
    content: `
      <form id="mt-limit-form" novalidate>
        <div class="form-group">
          <label class="label" for="mt-limit-minutes">${esc(t('mediaTime.deviceLimitMinutesLabel'))}${REQUIRED_MARK}</label>
          <input class="input" id="mt-limit-minutes" type="number" min="0" max="1440" step="1" inputmode="numeric" autocomplete="off" required
                 value="${limit?.daily_minutes != null ? Number(limit.daily_minutes) : ''}">
          <p class="form-hint">${esc(t('mediaTime.deviceLimitHint'))}</p>
        </div>
        <div id="mt-limit-error" class="form-error" role="alert" hidden></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary" id="mt-limit-submit">${esc(t('common.save'))}</button>
        </div>
      </form>`,
    onSave: async (panel) => {
      const errEl = panel.querySelector('#mt-limit-error');
      const submit = panel.querySelector('#mt-limit-submit');
      const minutes = Number.parseInt(panel.querySelector('#mt-limit-minutes').value, 10);
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
        errEl.textContent = t('mediaTime.budgetProblem');
        errEl.hidden = false;
        return;
      }
      submit.disabled = true;
      try {
        await api.put(`/media-time/quotas/${encodeURIComponent(childId)}`, {
          device_id: deviceId, daily_minutes: minutes,
        });
        if (!isModalContextCurrent(modalContext)) return;
        closeModal({ force: true, context: modalContext });
        toast(t('mediaTime.deviceLimitSaved'));
        await reloadAfterSave(async () => {
          await renderCurrentTab(_container, { direction: 0 });
          refocusAfterRender();
        });
      } catch (err) {
        submit.disabled = false;
        errEl.textContent = mediaTimeErrorSentence(err);
        errEl.hidden = false;
      }
    },
  });
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
function openAdjustModal(childId = null) {
  if (!state.canManage) return;
  const target = childId ?? state.selectedChildId;
  if (target == null) return;
  const card = (state.todayCards || []).find((c) => c.userId === target);
  const data = card?.data ?? state.today;
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
    title: t('mediaTime.adjustTitle', { name: childNameFor(target) }),
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
        await api.put(`/media-time/quotas/${encodeURIComponent(target)}/day`, {
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

function openPurchaseModal(childId = null) {
  /* Der Selbstkauf steht auch Kindern offen (POST /purchase laesst targetId ==
   * actor zu, Server prüft Punkte und Cap) - der Modal ist bewusst identisch,
   * der Satz nennt Kurs und Menge, der Rechner bleibt beim Server. */
  const target = childId ?? state.selectedChildId ?? null;
  const rate = (state.todayCards || []).find((c) => c.userId === target)?.data?.exchange
    ?? state.today?.exchange;
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
        if (state.canManage && target != null) body.user_id = target;
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
  if (platform === 'console') return t('mediaTime.platformConsole');
  if (platform === 'tv') return t('mediaTime.platformTv');
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
            <option value="console">${esc(t('mediaTime.platformConsole'))}</option>
            <option value="tv">${esc(t('mediaTime.platformTv'))}</option>
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

/* Regeln = Config-Seite, nummerierte Gruppen (Nutzer 05.11.: "Config Seite
 * strukturierter und intuitiver"). Die Reihenfolge folgt den Fragen der
 * Eltern: An/Aus und Sperre -> Ruhezeit -> Punkte -> Apps -> Google. Jede
 * Gruppe traegt eine Zahl, damit die Seite eine Leserechnung hat. */
function groupHeading(id, num, labelKey) {
  return `<h2 class="mt-section__title u-section-title" id="${id}">`
    + `<span class="mt-groupnum" aria-hidden="true">${num}</span>${esc(t(labelKey))}</h2>`;
}

function renderRules(el) {
  el.insertAdjacentHTML('beforeend', `
    <div class="media-time-content__inner">
      <p class="mt-section__note">${esc(state.canManage ? t('mediaTime.rulesIntro') : t('mediaTime.rulesChildHint'))}</p>

      <section class="mt-section" aria-labelledby="mt-basic-title">
        ${groupHeading('mt-basic-title', 1, 'mediaTime.groupBasics')}
        <p class="mt-section__note">${esc(t('mediaTime.groupBasicsHint'))}</p>
        <div id="mt-switch-host"></div>
        <div class="form-group mt-hardcap-row">
          <label class="label" for="mt-enforcement">${esc(t('mediaTime.enforcementLabel'))}</label>
          <select class="input" id="mt-enforcement">
            <option value="count">${esc(t('mediaTime.enforcementCount'))}</option>
            <option value="lock">${esc(t('mediaTime.enforcementLock'))}</option>
          </select>
          <p class="form-hint">${esc(t('mediaTime.enforcementHelp'))}</p>
        </div>
      </section>

      <section class="mt-section" aria-labelledby="mt-quiet-title">
        ${groupHeading('mt-quiet-title', 2, 'mediaTime.groupQuiet')}
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

      <section class="mt-section" aria-labelledby="mt-exchange-group-title">
        ${groupHeading('mt-exchange-group-title', 3, 'mediaTime.groupExchange')}
        <p class="mt-section__note">${esc(t('mediaTime.rateGroupHint'))}</p>
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
          ${groupHeading('mt-exceptions-title', 4, 'mediaTime.exceptionsTitle')}
          <button class="btn btn--secondary btn--sm" type="button" data-action="mt-exception-add">
            <i data-lucide="plus" aria-hidden="true"></i>${esc(t('mediaTime.exceptionAdd'))}
          </button>
        </div>
        <p class="mt-section__note">${esc(t('mediaTime.exceptionsBody'))}</p>
        <p class="mt-section__note">${esc(t('mediaTime.exceptionSectionHint'))}</p>
        <div id="mt-exception-host"></div>
      </section>

      ${state.canManage ? `
      <section class="mt-section" aria-labelledby="mt-fl-title">
        ${groupHeading('mt-fl-title', 5, 'mediaTime.groupGoogle')}
        <p class="mt-section__note">${esc(t('mediaTime.flIntro'))}</p>
        <div id="mt-fl-host"></div>
      </section>` : ''}
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
  el.querySelector('#mt-enforcement') && (el.querySelector('#mt-enforcement').value = s?.enforcement === 'lock' ? 'lock' : 'count');
  el.querySelector('[data-action="mt-save-rate"]')?.addEventListener('click', () => saveRate(el));
  el.querySelector('[data-action="mt-off-rate"]')?.addEventListener('click', async () => {
    await api.put('/media-time/settings', { exchange: null });
    toast(t('mediaTime.rateOffDone'));
    await reloadAfterSave(() => renderCurrentTab(_container, { direction: 0 }));
  });
  el.querySelector('#mt-hardcap')?.addEventListener('change', (ev) => saveHardCap(ev.target.value === '1'));
  el.querySelector('#mt-enforcement')?.addEventListener('change', async (ev) => {
    try {
      await api.put('/media-time/settings', { enforcement: ev.target.value });
      toast(ev.target.value === 'lock' ? t('mediaTime.enforcementLockToast') : t('mediaTime.enforcementCountToast'));
    } catch (err) {
      toast(mediaTimeErrorSentence(err), 'danger');
    }
  });

  /* (c) Ausnahmen */
  renderExceptionRows(el);
  el.querySelector('[data-action="mt-exception-add"]')?.addEventListener('click', () => openExceptionModal(null));


  /* (d) Google Family Link (Eltern): Schalter, Status, Abruf, Zuordnung. */
  const flHost = el.querySelector('#mt-fl-host');
  if (flHost) renderFlHost(flHost);
}

function flStatusText(s) {
  if (s?.familylink_status === 'ok') return t('mediaTime.flStatusOk');
  if (s?.familylink_status === 'login_noetig') return t('mediaTime.flLoginParent');
  return t('mediaTime.flStatusNone');
}

function renderFlHost(host) {
  const s = state.settings || {};
  host.insertAdjacentHTML('beforeend', `
    <label class="toggle-row toggle-row--switch">
      <span class="toggle-row__label">${esc(t('mediaTime.flSwitchLabel'))}</span>
      <span class="toggle">
        <input type="checkbox" role="switch" id="mt-fl-enabled"${s.familylink_ingest_enabled ? ' checked' : ''}>
        <span class="toggle__track" aria-hidden="true"></span>
      </span>
    </label>
    <p class="form-hint">${esc(t('mediaTime.flSwitchHint'))}</p>
    <p class="mt-section__note" id="mt-fl-status">${esc(flStatusText(s))}</p>
    <div class="mt-row-actions">
      <button class="btn btn--secondary btn--sm" type="button" data-action="mt-fl-fetch">
        <i data-lucide="refresh-cw" aria-hidden="true"></i>${esc(t('mediaTime.flFetch'))}
      </button>
    </div>
    <div id="mt-fl-map"></div>`);
  host.querySelector('#mt-fl-enabled')?.addEventListener('change', async (ev) => {
    try {
      await api.put('/media-time/settings', { familylink_ingest_enabled: ev.target.checked });
      state.settings = { ...state.settings, familylink_ingest_enabled: ev.target.checked };
      toast(ev.target.checked ? t('mediaTime.flOnToast') : t('mediaTime.flOffToast'));
    } catch (err) {
      ev.target.checked = !ev.target.checked;
      toast(mediaTimeErrorSentence(err), 'danger');
    }
  });
  host.querySelector('[data-action="mt-fl-fetch"]')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      const res = await api.post('/media-time/familylink/ingest', {});
      const status = res?.data?.status;
      state.settings = { ...state.settings, familylink_status: status };
      const st = host.querySelector('#mt-fl-status');
      if (st) st.textContent = flStatusText(state.settings);
      toast(status === 'ok'
        ? t('mediaTime.flFetchOk', { written: fmtNum(res?.data?.written ?? 0) })
        : t('mediaTime.flFetchLogin'));
    } catch (err) {
      toast(mediaTimeErrorSentence(err), 'danger');
    }
    btn.disabled = false;
  });
  loadFlMap(host.querySelector('#mt-fl-map'));
}

/* Zuordnung Kind <-> Google-Konto und Google-Geraet <-> Medienzeit-Geraet.
 * Die Google-Kennung ist eine Ziffernfolge aus dem Collector-Bericht
 * (scripts/familylink) - ein Pseudonym, kein Name. Geraete lassen sich dem
 * Kind zuordnen, damit die Google-Minuten auf dem richtigen Balken landen. */
async function loadFlMap(mapEl) {
  if (!mapEl || state.selectedChildId == null) return;
  await ensureDevicesLite();
  let mapping = null;
  try {
    const res = await api.get(`/media-time/familylink/mapping?user_id=${state.selectedChildId}`);
    mapping = res?.data ?? null;
  } catch { /* ohne Auskunft: Formular leer, nichts behaupten */ }
  const devices = state.devices || [];
  const rows = devices.map((dev) => {
    const mapped = (mapping?.devices || []).find((m) => m.media_time_device_id === dev.id);
    return `
      <div class="list-row">
        <div class="list-row__main">
          <p class="list-row__name">${esc(dev.name)}</p>
        </div>
        <input class="input mt-fl__gdev" data-device-id="${dev.id}" maxlength="64"
          placeholder="${esc(t('mediaTime.flDeviceGooglePh') || '')}"
          value="${esc(mapped?.google_device_id || dev.google_device_id || '')}">
      </div>`;
  }).join('');
  const known = (mapping?.devices || []).filter((m) => !m.media_time_device_id).map((m) => m.google_device_id);
  mapEl.insertAdjacentHTML('beforeend', `
    <h3 class="mt-group-title">${esc(t('mediaTime.flMapTitle'))}</h3>
    <p class="form-hint">${esc(t('mediaTime.flMapHint'))}</p>
    <div class="form-group">
      <label class="label" for="mt-fl-uid">${esc(t('mediaTime.flGoogleUidLabel'))}</label>
      <input class="input" id="mt-fl-uid" inputmode="numeric" maxlength="40" value="${esc(mapping?.google_uid || '')}">
    </div>
    ${rows ? `<div class="row-carrier">${rows}</div>` : ''}
    ${known.length ? `<p class="form-hint">${esc(t('mediaTime.flKnownDevices'))}: ${esc(known.join(', '))}</p>` : ''}
    <div class="mt-row-actions">
      <button class="btn btn--primary btn--sm" type="button" data-action="mt-fl-map-save">${esc(t('mediaTime.flMapSave'))}</button>
      <button class="btn btn--secondary btn--sm" type="button" data-action="mt-fl-map-clear">${esc(t('mediaTime.flMapClear'))}</button>
    </div>`);
  mapEl.querySelector('[data-action="mt-fl-map-save"]')?.addEventListener('click', async () => {
    const uid = mapEl.querySelector('#mt-fl-uid').value.trim();
    if (!/^[0-9]{6,40}$/.test(uid)) {
      toast(t('mediaTime.flUidProblem'), 'danger');
      return;
    }
    const devs = [...mapEl.querySelectorAll('.mt-fl__gdev')].filter((i) => i.value.trim())
      .map((i) => ({ google_device_id: i.value.trim(), media_time_device_id: Number(i.dataset.deviceId) }));
    try {
      await api.put('/media-time/familylink/mapping', {
        user_id: state.selectedChildId, google_uid: uid, devices: devs,
      });
      toast(t('mediaTime.flMapSaved'));
      await reloadAfterSave(() => renderCurrentTab(_container, { direction: 0 }));
    } catch (err) {
      toast(mediaTimeErrorSentence(err), 'danger');
    }
  });
  mapEl.querySelector('[data-action="mt-fl-map-clear"]')?.addEventListener('click', async () => {
    try {
      await api.put('/media-time/familylink/mapping', { user_id: state.selectedChildId, google_uid: null });
      toast(t('mediaTime.flMapCleared'));
      await reloadAfterSave(() => renderCurrentTab(_container, { direction: 0 }));
    } catch (err) {
      toast(mediaTimeErrorSentence(err), 'danger');
    }
  });
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
        <p class="list-row__meta">${item.kind === 'duty' ? `<span class="badge badge--soft">${esc(t('mediaTime.exceptionKind.duty'))}</span> · ` : ''}${esc(t(`mediaTime.exceptionMatch.${item.match_type}`))} · ${esc(t(`mediaTime.exceptionExempt.${item.exempt_from}`))} · ${esc(exceptionUserLabel(item.user_id))}${item.note ? ` · ${esc(item.note)}` : ''}</p>
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
          <label class="label" for="mt-exc-kind">${esc(t('mediaTime.exceptionKindLabel'))}</label>
          <select class="input" id="mt-exc-kind">
            <option value="quota">${esc(t('mediaTime.exceptionKind.quota'))}</option>
            <option value="duty">${esc(t('mediaTime.exceptionKind.duty'))}</option>
          </select>
          <p class="form-hint">${esc(t('mediaTime.exceptionKindHelp'))}</p>
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
        // 'duty' = Pflichtzeit (zaehlt nie gegen das Kontingent, eigener Satz in /today)
        kind: panel.querySelector('#mt-exc-kind')?.value === 'duty' ? 'duty' : 'quota',
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
    set('#mt-exc-kind', existing.kind === 'duty' ? 'duty' : 'quota');
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
  // Die Kachel auf der Uebersicht springt mit ?user_id=<kind> voraus
  // (dashboard.js, data-route). Ohne diese Zeile wuerde ensureChildren immer
  // auf dem ersten Kind landen und der Sprung waere einer zu viel.
  applyUserIdFromSearch();
  _container = container;
  renderShell(container);
  await renderCurrentTab(container);
  startTicker();
}

/** ?user_id= (Kachel-Sprung, tiefer Link) als Vorauswahl, falls gueltig. */
function applyUserIdFromSearch() {
  try {
    const raw = new URLSearchParams(location.search).get('user_id');
    if (raw == null) return;
    const id = Number.parseInt(raw, 10);
    if (Number.isInteger(id) && id > 0) state.selectedChildId = id;
  } catch { /* abweichende Adresse: Vorauswahl bleibt aus */ }
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
