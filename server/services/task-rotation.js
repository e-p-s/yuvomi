/**
 * Modul: Rotation für wiederkehrende Aufgaben
 * Zweck: Eine Serie wie "Müll rausbringen" haengt sonst fuer immer an einer
 *        Person. Rotation ist eine reine Zustellungs-Entscheidung an der
 *        Folgeinstanz: spawnRecurrenceFollowup() fragt hier nach, WEM die
 *        naechste Instanz gehoert. Die RRULE-Engine (services/recurrence.js)
 *        bleibt unangetastet — Rotation aendert nie ein Datum, nur den Inhaber.
 *
 *        Alle Strategien sind DETERMINISTISCH (kein Zufall): die Oberflaeche
 *        kann daraus "als naechstes: Leon" ableiten, ohne dass ein Blick in die
 *        Zukunft die Zuordnung veraendert.
 * Abhängigkeiten: keine (nur uebergebene DB-Handles)
 */

const MODES = ['round_robin', 'least_assigned', 'least_recent'];

export function isRotationMode(value) {
  return value === null || value === undefined || MODES.includes(value);
}

/**
 * Die Pool-Zeilen einer Serie, in Ablieferungsreihenfolge. Der Pool gehoert der
 * Serie, liegt aber an JEDEM Vorkommen als Wert (Migration 272, Prinzip
 * #1603): die Frage "wer ist dran" braucht keine Rueckwaertssuche ueber
 * geloeschte Glieder.
 */
function poolRows(d, task) {
  return d.prepare(`
    SELECT user_id, position FROM task_rotation_pool
    WHERE task_id = ? ORDER BY position ASC, user_id ASC
  `).all(task.id);
}

function rotationOriginId(d, task) {
  // Die Serie entscheidet ueber Rotation, nicht das einzelne Vorkommen:
  // Modus und Pool stehen am Ursprung, solange es da ist. An der laufenden
  // Instanz sind sie ohnehin kopiert, also faellt die Herkunft nie weg.
  return task.rotation_mode ? task : null;
}

/**
 * Wer bekommt die naechste Folgeinstanz?
 *   d      — DB-Handle (der Aufrufer haelt die Transaktion)
 *   task   — die eben erledigte Aufgabe (ihr Pool und Modus zaehlen)
 * Zurueck: user_id oder null (Rotation aus / zu kleiner Pool).
 */
export function pickRotationUser(d, task, seriesId = null) {
  if (!rotationOriginId(d, task)) return null;
  const rows = poolRows(d, task);
  // Unter zwei Mitgliedern waere "Rotation" eine Verschroebung des Status quo:
  // dieselbe Person, nur umstaendlicher ermittelt. Aus ist hier die ehrliche
  // Antwort.
  if (rows.length < 2) return null;
  const pool = rows.map((r) => r.user_id);
  // Der Verlauf haengt an der Serienwurzel (seriesOfTask, rewards.js). Ohne
  // uebergebene Wurzel gilt die Aufgabe selbst — fuer Aufrufer auerhalb des
  // Tasks-Routenpfads ist das nah genug, die Routes reichen die echte mit.
  const series = seriesId ?? task.recurrence_series_id ?? task.id;

  switch (task.rotation_mode) {
    case 'round_robin': {
      // Nachfolger des letzten Empfaengers; Unbekannt oder rausgeworfenes
      // Mitglied => wieder vorn anfangen. Kein Zaehlen von Runden — die Serie
      // merkt sich nur den letzten, nicht die Historie.
      const last = task.rotation_last_user;
      const idx = last === null || last === undefined ? -1 : pool.indexOf(last);
      return pool[(idx + 1) % pool.length];
    }
    case 'least_assigned': {
      // Wenigste offene Aufgaben ueberhaupt (nicht nur dieser Serie): die
      // Entlastung soll der bekommen, der schon am wenigsten traegt.
      // Gleichstand: der aeussere Poolrang (position) bricht — stabil, ohne
      // Zufallszahl.
      let best = null;
      let bestCount = Infinity;
      let bestPos = Infinity;
      for (const r of rows) {
        const n = d.prepare(`
          SELECT COUNT(*) AS n FROM tasks t
          WHERE t.status = 'open' AND t.archived_at IS NULL
            AND (t.assigned_to = ? OR EXISTS (
              SELECT 1 FROM task_assignments ta
              WHERE ta.task_id = t.id AND ta.user_id = ?))
        `).get(r.user_id, r.user_id).n;
        if (n < bestCount || (n === bestCount && r.position < bestPos)) {
          best = r.user_id; bestCount = n; bestPos = r.position;
        }
      }
      return best;
    }
    case 'least_recent': {
      // Wer hat diese Serie am laengsten nicht erledigt? Der Verlauf
      // (task_completions, series_id) traegt die Antwort; wer nie vorkam, gilt
      // als am laengsten frei.
      let best = null;
      let bestAt = '0000-01-01T00:00:00Z';
      let bestPos = Infinity;
      for (const r of rows) {
        const row = d.prepare(`
          SELECT MAX(c.completed_at) AS at
          FROM task_completions c
          WHERE c.user_id = ? AND c.series_id IN (
            SELECT id FROM tasks
            WHERE id = ? OR recurrence_origin_id = ? OR recurrence_series_id = ?)
        `).get(r.user_id, task.id, task.id, task.id);
        const at = row?.at ?? '0000-01-01T00:00:00Z';
        if (at < bestAt || (at === bestAt && r.position < bestPos)) {
          best = r.user_id; bestAt = at; bestPos = r.position;
        }
      }
      return best ?? pool[0];
    }
    default:
      return null;
  }
}

/**
 * Rotation auf die Folgeinstanz anwenden (Aufrufer haelt die Transaktion).
 * Gibt { assignedTo, assignments, lastUser } zurueck oder null, wenn keine
 * Rotation laeuft — dann bleibt alles exakt beim heutigen Verhalten.
 */
export function rotationForFollowup(d, task) {
  const picked = pickRotationUser(d, task);
  if (picked === null || picked === undefined) return null;
  // Der Empfaenger der letzten Instanz war der letzte Stand — uebernommen,
  // bevor er ueberschrieben wird: sonst faende round_robin sich selbst.
  return {
    assignedTo: picked,
    assignments: [picked],
    lastUser: picked,
  };
}

/**
 * Modus + Pool + letzten Empfaenger als Wert auf eine Aufgabe schreiben
 * (POST/PUT/Anlegen der Folgeinstanz). `null`-Werte loeschen die Rotation.
 */
export function setRotation(d, taskId, { mode = null, pool = null, lastUser = null } = {}) {
  d.prepare('UPDATE tasks SET rotation_mode = ?, rotation_last_user = ? WHERE id = ?')
    .run(mode ?? null, lastUser ?? null, taskId);
  if (pool === null) {
    if (mode === null) d.prepare('DELETE FROM task_rotation_pool WHERE task_id = ?').run(taskId);
  } else {
    d.prepare('DELETE FROM task_rotation_pool WHERE task_id = ?').run(taskId);
    const ins = d.prepare('INSERT INTO task_rotation_pool (task_id, user_id, position) VALUES (?, ?, ?)');
    pool.forEach((uid, i) => ins.run(taskId, uid, i));
  }
}

/**
 * Rotation einer Aufgabe lesen (Detail/Liste): die drei Felder, die der Client
 * braucht. Der Pool als user_ids in Ablieferungsreihenfolge.
 */
export function readRotation(d, taskId) {
  const row = d.prepare('SELECT rotation_mode, rotation_last_user FROM tasks WHERE id = ?').get(taskId);
  const pool = d.prepare('SELECT user_id FROM task_rotation_pool WHERE task_id = ? ORDER BY position').all(taskId)
    .map((r) => r.user_id);
  return {
    rotation_mode: row?.rotation_mode ?? null,
    rotation_last_user: row?.rotation_last_user ?? null,
    rotation_pool: pool.length ? pool : null,
  };
}

/**
 * Rotation auf eine Folgeinstanz kopieren (Modus und Pool reisen als Wert
 * mit, #1603-Prinzip). Der letzte Empfaenger ist der frisch gesetzte.
 */
export function carryRotation(d, originTask, newTaskId) {
  if (!originTask?.rotation_mode) return;
  setRotation(d, newTaskId, {
    mode: originTask.rotation_mode,
    pool: poolRows(d, originTask).map((r) => r.user_id),
    lastUser: originTask.rotation_last_user,
  });
}
