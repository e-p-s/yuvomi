import { api } from '/api.js';
import { t } from '/i18n.js';
import { captureOpenContext, confirmModal, isModalContextCurrent, refocusAfterRender } from '/components/modal.js';
import { settingRowHtml, settingSwitchRowHtml } from '/settings/components.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';
import { errorSentence } from '/utils/friendly-error.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';

// Spiegelt MAX_POINTS in server/routes/tasks.js.
const MAX_TASK_POINTS = 10000;
// Spiegelt MAX_PENALTY in server/routes/rewards.js: der Katalog hort genau dort
// auf, wo die Vergabe aufhoert - eine Vorlage ueber der Grenze waere ein Glas,
// das kein Gast bekommt.
const MAX_CONSEQUENCE_POINTS = 100;

// KEIN AN/AUS-SCHALTER MEHR (Re-Critique 2026-09-27, A7 P1-3): "Belohnungen
// aktivieren" stand hier UND in Aktive Module - zwei Schalter fuer denselben
// Eintrag in `disabled_modules`. Das Modul geht nur noch dort an und aus; die
// Statuszeile des Blatts (shell.js) zeigt den Zustand und verlinkt dorthin.

function renderPage(container, preferences) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <!-- ZWEI ZEILEN IN EINEM TRAEGER (R17, E9), vorher zwei Karten mit je
           einem Kartentitel ("Einloesungen", "Standard-Punkte") ueber genau
           einem Bedienelement. Die Zeilen tragen die Namen der Bedienelemente;
           die Kartentitel sagten dasselbe in einem Wort. -->
      <div class="row-carrier settings-group">
        ${settingSwitchRowHtml({
          label: t('settings.rewardsApprovalLabel'),
          checked: preferences.rewards_require_approval !== false,
          description: t('settings.rewardsApprovalHint'),
          descriptionId: 'rewards-require-approval-hint',
          attrs: { id: 'rewards-require-approval', 'aria-describedby': 'rewards-require-approval-hint' },
        })}
        ${settingSwitchRowHtml({
          label: t('settings.rewardsLateDecayLabel'),
          checked: preferences.tasks_late_decay_enabled === true,
          description: t('settings.rewardsLateDecayHint'),
          descriptionId: 'tasks-late-decay-hint',
          attrs: { id: 'tasks-late-decay', 'aria-describedby': 'tasks-late-decay-hint' },
        })}
        <!-- KONSEQUENZEN (Default AUS): eine Familie ohne Strafsystem soll die
             Zeile nie anfassen muessen. Aus ist hier auch 403 am Server, nicht
             nur eine ausgeblendete Oberflaeche. -->
        ${settingSwitchRowHtml({
          label: t('settings.rewardsPenaltiesLabel'),
          checked: preferences.rewards_penalties_enabled === true,
          description: t('settings.rewardsPenaltiesHint'),
          descriptionId: 'rewards-penalties-hint',
          attrs: { id: 'rewards-penalties-enabled', 'aria-describedby': 'rewards-penalties-hint' },
        })}
        <!-- ERSTELLER-ANZEIGE (Default AUS): die Aufgaben-Leseansicht nennt den
             Anlegenden nur, wenn der Haushalt den Schalter setzt und die Aufgabe
             einen Ersteller traegt. Ohne Schalter zeigt sie nichts. -->
        ${settingSwitchRowHtml({
          label: t('settings.taskCreatedByVisibleLabel'),
          checked: preferences.task_created_by_visible === true,
          description: t('settings.taskCreatedByVisibleHint'),
          descriptionId: 'task-created-by-visible-hint',
          attrs: { id: 'task-created-by-visible', 'aria-describedby': 'task-created-by-visible-hint' },
        })}
        <!-- FREIGABEPFLICHT (Default AN): neue Aufgaben muessen von einem
             Elternteil bestaetigt werden, bevor Punkte zaehlen. Kinder koennen
             die Option an der Aufgabe nicht aendern; Aufgaben ohne Punkte
             (Memos) brauchen keine Bestaetigung. -->
        ${settingSwitchRowHtml({
          label: t('settings.tasksRequireApprovalLabel'),
          checked: preferences.tasks_require_approval !== false,
          description: t('settings.tasksRequireApprovalHint'),
          descriptionId: 'tasks-require-approval-hint',
          attrs: { id: 'tasks-require-approval', 'aria-describedby': 'tasks-require-approval-hint' },
        })}
        <!-- EIN SPEICHERMODELL AUF DER SEITE (Re-Critique 2026-09-27, A7 P2-8):
             der Schalter daneben speichert sofort, also tut es das Zahlenfeld
             auch - beim Verlassen und mit Enter. Ein eigener Speichern-Knopf nur
             fuer dieses Feld liess offen, ob die Schalter ihn auch brauchen. -->
        ${settingRowHtml({
          label: t('settings.rewardsDefaultPointsLabel'),
          labelFor: 'rewards-default-points',
          description: t('settings.rewardsDefaultPointsHint'),
          descriptionId: 'rewards-default-points-hint',
          extra: `<p class="form-hint" id="rewards-default-points-off-hint">${t('settings.rewardsDefaultPointsOffHint')}</p>
            <div id="rewards-default-points-error" class="form-error" role="alert" hidden></div>`,
          control: `<form class="settings-row-form" id="rewards-default-points-form" novalidate autocomplete="off">
            <input class="form-input" type="number" id="rewards-default-points" inputmode="numeric"
                   min="0" max="${MAX_TASK_POINTS}" step="1" enterkeyhint="done"
                   aria-describedby="rewards-default-points-hint rewards-default-points-off-hint rewards-default-points-error"
                   value="${Number(preferences.tasks_default_points) || 0}">
          </form>`,
        })}
      </div>
    </section>
    <!-- KONSEQUENZEN-KATALOG (Migration 287): die Vorlagen hinter der
         Straf-Vergabe. Unsichtbar, solange der Schalter oben aus ist - eine
         Familie ohne Strafsystem pflegt kein Regal, das sie nie oeffnet. -->
    <section class="settings-section" id="rewards-consequence-catalog" data-penalties-enabled="${preferences.rewards_penalties_enabled === true ? '1' : ''}" hidden>
      <div class="row-carrier settings-group">
        <div id="rewards-consequence-list" class="settings-consequence-list"
             aria-label="${esc(t('settings.rewardsConsequenceListLabel'))}"></div>
        <form class="settings-row-form" id="rewards-consequence-create-form" novalidate autocomplete="off">
          <label class="form-label" for="rewards-consequence-title">${esc(t('settings.rewardsConsequenceAddLabel'))} ${REQUIRED_MARK}</label>
          <div class="settings-consequence-create">
            <input class="form-input" type="text" id="rewards-consequence-title"
                   maxlength="120" required
                   placeholder="${esc(t('settings.rewardsConsequenceAddPlaceholder'))}">
            <input class="form-input" type="number" id="rewards-consequence-points" inputmode="numeric"
                   min="1" max="${MAX_CONSEQUENCE_POINTS}" step="1" required
                   aria-label="${esc(t('settings.rewardsConsequencePointsLabel'))} ${REQUIRED_MARK}">
            <button type="submit" class="btn btn--secondary" id="rewards-consequence-create">
              ${esc(t('settings.rewardsConsequenceAdd'))}
            </button>
          </div>
          <div id="rewards-consequence-error" class="form-error" role="alert" hidden></div>
        </form>
      </div>
    </section>
  `);
}

function bindEvents(container, preferences) {
  const approvalToggle = container.querySelector('#rewards-require-approval');
  approvalToggle?.addEventListener('change', async () => {
    approvalToggle.disabled = true;
    try {
      await savePreferences({ rewards_require_approval: approvalToggle.checked });
      window.yuvomi?.showToast(t('settings.rewardsSaved'), 'success');
    } catch (error) {
      approvalToggle.checked = !approvalToggle.checked;
      window.yuvomi?.showToast(errorSentence(error, 'settings.preferenceSaveFailed'), 'danger');
    } finally {
      approvalToggle.disabled = false;
    }
  });

  // Spaetabzug ist opt-in (Standard aus) - der Schalter spiegelt den
  // gespeicherten Wert, `=== true`, damit fehlende Einstellung aus bleibt.
  const lateDecayToggle = container.querySelector('#tasks-late-decay');
  lateDecayToggle?.addEventListener('change', async () => {
    lateDecayToggle.disabled = true;
    try {
      await savePreferences({ tasks_late_decay_enabled: lateDecayToggle.checked });
      window.yuvomi?.showToast(t('settings.rewardsSaved'), 'success');
    } catch (error) {
      lateDecayToggle.checked = !lateDecayToggle.checked;
      window.yuvomi?.showToast(errorSentence(error, 'settings.preferenceSaveFailed'), 'danger');
    } finally {
      lateDecayToggle.disabled = false;
    }
  });
  const penaltyToggle = container.querySelector('#rewards-penalties-enabled');
  penaltyToggle?.addEventListener('change', async () => {
    penaltyToggle.disabled = true;
    try {
      await savePreferences({ rewards_penalties_enabled: penaltyToggle.checked });
      preferences.rewards_penalties_enabled = penaltyToggle.checked;
      // Der Katalog folgt dem Schalter: aus ist das Regal zu, an geht es auf.
      applyConsequenceVisibility(container, penaltyToggle.checked);
      window.yuvomi?.showToast(t('settings.rewardsSaved'), 'success');
    } catch (error) {
      penaltyToggle.checked = !penaltyToggle.checked;
      window.yuvomi?.showToast(errorSentence(error, 'settings.preferenceSaveFailed'), 'danger');
    } finally {
      penaltyToggle.disabled = false;
    }
  });
  // Ersteller-Anzeige ist opt-in (Standard aus) - `=== true`, damit ein
  // fehlender Wert den Schalter aus laesst (dasselbe Muster wie der Penalty).
  const createdByToggle = container.querySelector('#task-created-by-visible');
  createdByToggle?.addEventListener('change', async () => {
    createdByToggle.disabled = true;
    try {
      await savePreferences({ task_created_by_visible: createdByToggle.checked });
      preferences.task_created_by_visible = createdByToggle.checked;
      window.yuvomi?.showToast(t('settings.rewardsSaved'), 'success');
    } catch (error) {
      createdByToggle.checked = !createdByToggle.checked;
      window.yuvomi?.showToast(errorSentence(error, 'settings.preferenceSaveFailed'), 'danger');
    } finally {
      createdByToggle.disabled = false;
    }
  });
  // Freigabepflicht neuer Aufgaben (Default AN) - ein fehlender Wert haelt an.
  const requireApprovalToggle = container.querySelector('#tasks-require-approval');
  requireApprovalToggle?.addEventListener('change', async () => {
    requireApprovalToggle.disabled = true;
    try {
      await savePreferences({ tasks_require_approval: requireApprovalToggle.checked });
      preferences.tasks_require_approval = requireApprovalToggle.checked;
      window.yuvomi?.showToast(t('settings.rewardsSaved'), 'success');
    } catch (error) {
      requireApprovalToggle.checked = !requireApprovalToggle.checked;
      window.yuvomi?.showToast(errorSentence(error, 'settings.preferenceSaveFailed'), 'danger');
    } finally {
      requireApprovalToggle.disabled = false;
    }
  });

  bindDefaultPoints(container, preferences);
  bindConsequenceCatalog(container, preferences);
}

/** Der Katalogabschnitt haengt am Schalter: sichtbar nur, wenn Konsequenzen an sind. */
function applyConsequenceVisibility(container, enabled) {
  const section = container.querySelector('#rewards-consequence-catalog');
  if (!section) return;
  section.hidden = !enabled;
}

/**
 * Konsequenzen-Katalog (Migration 287): Liste der Vorlagen mit Schalter
 * (an/aus) und Losch-Knopf, dazu eine Zeile 'Eintrag anlegen'. Ladt nur, wenn
 * der Schalter an ist - die Seite bleibt schnell, wo das Regal zu ist.
 * Das Loeschen ist der Toggle-Pfad der Praemienpflege: der Schalter deaktiviert
 * (sichtbar bleibt der Text), der Loesch-Knopf entfernt die Zeile.
 */
export function bindConsequenceCatalog(container, preferences) {
  const section = container.querySelector('#rewards-consequence-catalog');
  if (!section) return;
  applyConsequenceVisibility(container, preferences.rewards_penalties_enabled === true);
  if (preferences.rewards_penalties_enabled !== true) return;

  const list = container.querySelector('#rewards-consequence-list');
  const form = container.querySelector('#rewards-consequence-create-form');
  const titleInput = container.querySelector('#rewards-consequence-title');
  const pointsInput = container.querySelector('#rewards-consequence-points');
  const errorEl = container.querySelector('#rewards-consequence-error');
  if (!form || !titleInput || !pointsInput) return;

  const showError = (message) => {
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = false;
    // Das Feld war leer bzw. ungueltig: aria-invalid zeigt, wo es fehlt.
    titleInput.setAttribute('aria-invalid', 'true');
    pointsInput.setAttribute('aria-invalid', 'true');
  };
  const clearError = () => {
    if (errorEl) errorEl.hidden = true;
    titleInput.removeAttribute('aria-invalid');
    pointsInput.removeAttribute('aria-invalid');
  };

  let items = [];

  // Zeilen über die DOM-API, nicht als Markup-String: der Audit-Guard erlaubt
  // kein innerHTML unter public/, und die Titel sind Haushalt-Eingaben.
  function rowEl(item) {
    const row = document.createElement('div');
    row.className = 'settings-consequence-row';
    row.dataset.id = String(item.id);

    const title = document.createElement('span');
    title.className = 'settings-consequence-title';
    title.textContent = item.title;
    row.appendChild(title);

    const points = document.createElement('span');
    points.className = 'settings-consequence-points';
    points.textContent = String(Number(item.points));
    row.appendChild(points);

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'toggle-row settings-consequence-toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'rw-consequence-active';
    box.dataset.id = String(item.id);
    box.checked = Boolean(item.active);
    box.setAttribute('aria-label', `${t('settings.rewardsConsequenceActiveLabel')} · ${item.title}`);
    const boxHidden = document.createElement('span');
    boxHidden.className = 'visually-hidden';
    boxHidden.textContent = t('settings.rewardsConsequenceActiveLabel');
    toggleLabel.append(box, boxHidden);
    row.appendChild(toggleLabel);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn--ghost btn--sm rw-consequence-delete';
    del.dataset.id = String(item.id);
    del.setAttribute('aria-label', `${t('settings.rewardsConsequenceDelete')} · ${item.title}`);
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', 'trash-2');
    icon.setAttribute('aria-hidden', 'true');
    del.appendChild(icon);
    row.appendChild(del);
    return row;
  }

  function renderList() {
    if (!list?.isConnected) return;
    list.replaceChildren();
    if (!items.length) {
      const hint = document.createElement('p');
      hint.className = 'form-hint';
      hint.textContent = t('settings.rewardsConsequenceEmpty');
      list.appendChild(hint);
    } else {
      for (const item of items) list.appendChild(rowEl(item));
    }
    list.querySelectorAll?.('.rw-consequence-active').forEach((box) => {
      box.addEventListener('change', async () => {
        box.disabled = true;
        try {
          const res = await api.post(`/rewards/consequences/${box.dataset.id}/toggle`);
          const updated = res?.data;
          items = items.map((it) => (it.id === updated?.id ? updated : it));
          renderList();
          refocusAfterRender();
          window.yuvomi?.showToast(t('settings.rewardsConsequenceSaved'), 'success');
        } catch (error) {
          box.checked = !box.checked;
          showError(errorSentence(error, 'settings.preferenceSaveFailed'));
        } finally {
          box.disabled = false;
        }
      });
    });
    list.querySelectorAll?.('.rw-consequence-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = items.find((it) => String(it.id) === btn.dataset.id);
        const confirmed = await confirmModal(t('settings.rewardsConsequenceDeleteConfirm'), {
          confirmLabel: t('settings.rewardsConsequenceDelete'),
          detail: item?.title ?? '',
        });
        if (!confirmed || !btn.isConnected) return;
        btn.disabled = true;
        try {
          await api.delete(`/rewards/consequences/${btn.dataset.id}`);
          items = items.filter((it) => String(it.id) !== btn.dataset.id);
          renderList();
          refocusAfterRender();
          window.yuvomi?.showToast(t('settings.rewardsConsequenceDeleted'), 'success');
        } catch (error) {
          btn.disabled = false;
          showError(errorSentence(error, 'settings.preferenceSaveFailed'));
        }
      });
    });
  }

  async function load() {
    try {
      const res = await api.get('/rewards/consequences?all=1');
      items = Array.isArray(res?.data) ? res.data : [];
      renderList();
      refocusAfterRender();
    } catch {
      // Ohne Liste bleibt das Anlegefeld bedienbar - die Vorlagen sind eine
      // Erleichterung, keine Voraussetzung der Konsequenzen selbst.
      renderList();
      refocusAfterRender();
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();
    const title = String(titleInput.value ?? '').trim();
    const points = Math.trunc(Number(pointsInput.value));
    if (!title || title.length > 120 || !Number.isFinite(points) || points < 1 || points > MAX_CONSEQUENCE_POINTS) {
      showError(t('settings.rewardsConsequenceInvalid', { max: MAX_CONSEQUENCE_POINTS }));
      return;
    }
    const submit = container.querySelector('#rewards-consequence-create');
    if (submit) submit.disabled = true;
    try {
      const res = await api.post('/rewards/consequences', { title, points });
      if (res?.data) items = [...items, res.data];
      titleInput.value = '';
      pointsInput.value = '';
      renderList();
      window.yuvomi?.showToast(t('settings.rewardsConsequenceSaved'), 'success');
    } catch (error) {
      showError(errorSentence(error, 'settings.preferenceSaveFailed'));
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  load();
}

/**
 * Standard-Punkte für neue Aufgaben (#578). Speichert wie die Schalter der
 * Seite ohne eigenen Knopf: beim Verlassen des Feldes und mit Enter
 * (Re-Critique 2026-09-27, H12). Die Rückfrage, ob bestehende Aufgaben
 * mitgezogen werden, folgt dem gespeicherten Wert wie bisher - der Abschluss
 * der Eingabe ist jetzt das Verlassen des Feldes statt eines Klicks.
 *
 * Nicht bei jedem `change`: an Zahlenfeldern feuert er auch für jeden
 * Pfeilschritt, und jeder Zwischenwert wäre ein Schreibzugriff samt Rückfrage.
 * Escape nimmt eine noch nicht gespeicherte Eingabe zurück.
 */
export function bindDefaultPoints(container, preferences) {
  const form     = container.querySelector('#rewards-default-points-form');
  const input    = container.querySelector('#rewards-default-points');
  const errorEl  = container.querySelector('#rewards-default-points-error');
  if (!form || !input) return;

  let persisted = Number(preferences.tasks_default_points) || 0;
  let saving = false;

  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.hidden = false;
    input.setAttribute('aria-invalid', 'true');
  };
  const clearError = () => {
    errorEl.hidden = true;
    input.removeAttribute('aria-invalid');
  };

  async function commit() {
    if (saving) return;
    const raw = String(input.value ?? '').trim();
    const next = Math.trunc(Number(raw));
    if (raw === '' || !Number.isFinite(next) || next < 0 || next > MAX_TASK_POINTS) {
      showError(t('settings.rewardsDefaultPointsInvalid', { max: MAX_TASK_POINTS }));
      return;
    }
    clearError();
    if (next === persisted) {
      input.value = String(next);
      return;
    }

    // Feld sperren, solange der Request laeuft - sonst ueberschreibt der
    // Erfolgspfad eine Eingabe, die waehrenddessen getippt wurde. `readOnly`
    // statt `disabled`: ein deaktiviertes Feld verliert nach Enter den Fokus.
    saving = true;
    input.readOnly = true;
    input.setAttribute('aria-busy', 'true');
    const previous = persisted;
    // Die Rueckfrage zum Nachziehen entsteht erst aus zwei Antworten (#2134):
    // wer inzwischen einen Dialog geoeffnet hat, bekommt sie nicht daruebergelegt.
    const context = captureOpenContext();
    try {
      await savePreferences({ tasks_default_points: next });
      persisted = next;
      input.value = String(next);
      preferences.tasks_default_points = next;
      window.yuvomi?.showToast(t('settings.rewardsDefaultPointsSaved'), 'success');
    } catch (error) {
      input.value = String(previous); // Rollback
      showError(errorSentence(error, 'settings.preferenceSaveFailed'));
      return;
    } finally {
      saving = false;
      input.readOnly = false;
      input.removeAttribute('aria-busy');
    }

    // Wer das Blatt schon verlassen hat, bekommt die Rueckfrage nicht auf der
    // naechsten Seite: der neue Standard ist gespeichert, das Nachziehen optional.
    if (input.isConnected) await offerRebase(previous, next, context);
  }

  // Die Handler geben das Versprechen zurueck: dem Browser ist es gleich, ein
  // Test kann so auf den ganzen Speichervorgang warten.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    return commit();
  });
  input.addEventListener('blur', () => commit());
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || saving) return;
    input.value = String(persisted);
    clearError();
  });
}

/**
 * Nach einer Änderung anbieten, noch nicht erledigte Aufgaben nachzuziehen, die
 * auf dem alten Standard stehen. Erledigte bleiben außen vor, weil ihre Punkte
 * bereits im Ledger gutgeschrieben sind. Die Anzahl steht im Dialog, damit der
 * Wechsel vor der Bestätigung sichtbar ist.
 */
async function offerRebase(from, to, context) {
  if (from <= 0) return; // ohne vorherigen Standard gibt es nichts nachzuziehen

  let count = 0;
  try {
    const res = await api.get(`/tasks/points/affected?points=${from}`);
    count = Number(res?.data?.count) || 0;
  } catch {
    return; // Nachziehen ist optional — der neue Standard ist bereits gespeichert
  }
  if (count <= 0 || !isModalContextCurrent(context)) return;

  const confirmed = await confirmModal(
    t('settings.rewardsDefaultPointsRebaseTitle', { count, from, to }),
    {
      confirmLabel: t('settings.rewardsDefaultPointsRebaseConfirm'),
      detail: t('settings.rewardsDefaultPointsRebaseDetail'),
    },
  );
  if (!confirmed) return;

  try {
    const res = await api.post('/tasks/points/rebase', { from, to });
    const updated = Number(res?.data?.updated) || 0;
    window.yuvomi?.showToast(t('settings.rewardsDefaultPointsRebased', { count: updated }), 'success');
  } catch (error) {
    window.yuvomi?.showToast(errorSentence(error), 'danger');
  }
}

export async function render(container, { user }) {
  void user;
  const preferences = await getPreferences();
  renderPage(container, preferences);
  bindEvents(container, preferences);
}
