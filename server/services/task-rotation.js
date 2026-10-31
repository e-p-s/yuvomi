/**
 * Modul: Rotation für wiederkehrende Aufgaben
 * Zweck: Eine Serie wie "Müll rausbringen" haengt sonst fuer immer an einer
 *        Person. Rotation ist eine reine Zustellungs-Entscheidung an der
 *        Folgeinstanz: spawnRecurrenceFollowup() fragt hier nach, WEM die
 *        naechste Instanz gehoert. Die RRULE-Engine (services/recurrence.js)
 *        bleibt unangetastet - Rotation aendert nie ein Datum, nur den Inhaber.
 *
 *        Nur die feste Reihenfolge (upstream #1763: "An order, not a set").
 *        Verteilung nach Last oder Gerechtigkeit ist dort ausdruecklich
 *        ausserhalb des Rahmens - und jede dieser Strategien waere ein
 *        zweiter Weg, den Zeiger zu verlieren.
 *
 *        DER ZEIGER IST EINE POSITION. Die Serie merkt sich, welche
 *        Pool-Position zuletzt dran war (rotation_last_position) - nicht
 *        welche Person. Ein Mitglied, das den Pool verlaesst, verschiebt den
 *        Platz des Zeigers nicht; die sichtbare Reihenfolge laeuft dort
 *        weiter, wo sie war (Kevin, Max, Kevin - nie ein stiller Neustart
 *        vorn). rotation_last_user wandert weiter mit, ist aber nur
 *        Information: die Reihenfolge liest es nie. Genau das Lesen war der
 *        alte Fehler - ein rausgeworfenes Mitglied gab -1 und die Serie
 *        begann vorn von vorn.
 *
 *        Die offenen Fragen aus #1763, beantwortet in nextRotationEntry:
 *        - Erledigt eine ANDERE Person die Aufgabe, rueckt der Zeiger
 *          trotzdem weiter. Rotation folgt der Serie, nicht der Person, die
 *          abhakt.
 *        - Wird die Reihenfolge mitten in der Serie geaendert, bleibt der
 *          Zeiger stehen und die naechste Wahl liegt auf der Position danach
 *          - kein Reset (test:task-rotation haelt beide Antworten fest).
 *
 *        Alles daran ist DETERMINISTISCH (kein Zufall): die Oberflaeche kann
 *        daraus "als naechstes: Leon" ableiten (rotation_next_user), ohne
 *        dass ein Blick in die Zukunft die Zuordnung veraendert.
 * Abhängigkeiten: keine (nur uebergebene DB-Handles)
 */

const MODES = ['round_robin'];

export function isRotationMode(value) {
  return value === null || value === undefined || MODES.includes(value);
}

/**
 * Die Pool-Zeilen einer Serie, in Ablieferungsreihenfolge, mit active-Flag:
 * ein deaktiviertes Konto (#1381) ist nur auf dem Papier dabei - die Aufgabe
 * an jemanden zu haengen, der sich nicht anmelden kann, ist der stille tote
 * Zweig, den #1763 schlimmer nennt als keine Rotation. Die Zeilen selbst
 * bleiben, wie sie sind (ein deaktiviertes Mitglied kann zurueckkommen); nur
 * die Wahl ueberspringt sie.
 */
function poolRows(d, task) {
  return d.prepare(`
    SELECT p.user_id, p.position, (u.deactivated_at IS NULL) AS active
    FROM task_rotation_pool p
    JOIN users u ON u.id = p.user_id
    WHERE p.task_id = ?
    ORDER BY p.position ASC, p.user_id ASC
  `).all(task.id);
}

/**
 * Die Wahl als reine Funktion ueber geladene Zeilen (die Routes laden den
 * Pool fuer eine ganze Liste auf einmal, siehe attachRotation in
 * routes/tasks.js):
 *
 *   rows     - Pool-Zeilen {user_id, position, active} in Reihenfolge
 *   pointer  - rotation_last_position der Serie (null = noch keine Ablösung)
 *   assignee - assigned_to der laufenden Instanz (Regel fuer die erste Ablösung)
 *
 * Die nächste Position ist die erste AKTIVE Zeile mit einer Position ueber
 * dem Zeiger; ist keine uebrig, schliesst die Runde in die erste aktive
 * Zeile. Ein Zeiger ueber dem Pool (sein Mitglied ist raus, der Pool ist
 * kleiner) faellt ebenso zurueck, statt "wieder vorn" zweimal hintereinander
 * zu zeigen - die sichtbare Reihenfolge ist es, die der Zeiger schuetzt.
 * Solange die Positionen dicht sind (der Normalfall: setRotation teilt
 * 0..n-1) ist das genau (Zeiger + 1) % Poollaenge.
 *
 * Noch kein Zeiger: die Rotation hat nie abgelöst. Gehoert die laufende
 * Instanz schon der ersten Person im Pool, geht die ERSTE Ablösung an die
 * zweite - das Abhaken von Kevins Aufgabe darf nicht Kevin die naechste
 * geben (Kevin, Anna, Max - nicht Kevin, Kevin). Sonst beginnt die Runde
 * vorn.
 *
 * Zurueck: null, wenn Rotation aus ist (weniger als zwei aktive Koepfe).
 */
export function nextRotationEntry(rows, { pointer = null, assignee = null } = {}) {
  const active = rows.filter((r) => r.active);
  if (active.length < 2) return null;
  if (pointer === null || pointer === undefined) {
    return active[0].user_id === assignee ? active[1] : active[0];
  }
  return active.find((r) => r.position > pointer) ?? active[0];
}

/**
 * Wer bekommt die naechste Folgeinstanz? Zurueck: { userId, position } oder
 * null (Rotation aus / zu kleiner Pool). Der Zeiger ist die Position des
 * letzten Empfaengers - wer die Aufgabe abhakt, zaehlt nicht: Rotation folgt
 * der Serie, nicht der Person (#1763, offene Frage eins).
 */
export function pickRotationTarget(d, task) {
  if (!task.rotation_mode) return null;
  const entry = nextRotationEntry(poolRows(d, task), {
    pointer: task.rotation_last_position ?? null,
    assignee: task.assigned_to ?? null,
  });
  return entry ? { userId: entry.user_id, position: entry.position } : null;
}

/** Nur die user_id der Wahl, fuer Aufrufer, denen der Platz egal ist. */
export function pickRotationUser(d, task) {
  return pickRotationTarget(d, task)?.userId ?? null;
}

/**
 * Modus + Pool + Zeiger als Wert auf eine Aufgabe schreiben (POST/PUT/
 * Anlegen der Folgeinstanz). `null`-Werte loeschen die Rotation. Der Pool
 * ist eine Liste von user_ids (Positionen 0..n-1) oder eine Liste
 * {user_id, position}-Zeilen wie sie sind - die Folgeinstanz traegt den
 * Pool samt seiner Luecken weiter, sonst wuerde der mitgenommene Zeiger auf
 * einmal eine andere Person meinen. Der Zeiger (lastPosition) ist der
 * Bestell-Zustand, lastUser sagt nur, welchen Kopf er nennt - beide wandern
 * zusammen.
 */
export function setRotation(d, taskId, { mode = null, pool = null, lastUser = null, lastPosition = null } = {}) {
  d.prepare('UPDATE tasks SET rotation_mode = ?, rotation_last_user = ?, rotation_last_position = ? WHERE id = ?')
    .run(mode ?? null, lastUser ?? null, lastPosition ?? null, taskId);
  if (pool === null) {
    if (mode === null) d.prepare('DELETE FROM task_rotation_pool WHERE task_id = ?').run(taskId);
  } else {
    d.prepare('DELETE FROM task_rotation_pool WHERE task_id = ?').run(taskId);
    const ins = d.prepare('INSERT INTO task_rotation_pool (task_id, user_id, position) VALUES (?, ?, ?)');
    pool.forEach((entry, i) => {
      if (typeof entry === 'number') ins.run(taskId, entry, i);
      else ins.run(taskId, entry.user_id, entry.position);
    });
  }
}

/**
 * Rotation auf eine Folgeinstanz kopieren (Modus, Pool und Zeiger reisen als
 * Wert mit, #1603-Prinzip). Der Pool wandert samt Positionen - der Zeiger
 * der eben erledigten Instanz zeigt auf eine davon, und er zeigt richtig,
 * nur wenn die Zeilen unveraendert dastehen. Der frische Zeiger ist der
 * gewaehlte Platz; den setzt der Aufrufer unmittelbar danach.
 */
export function carryRotation(d, originTask, newTaskId) {
  if (!originTask?.rotation_mode) return;
  setRotation(d, newTaskId, {
    mode: originTask.rotation_mode,
    pool: poolRows(d, originTask).map((r) => ({ user_id: r.user_id, position: r.position })),
    lastUser: originTask.rotation_last_user,
    lastPosition: originTask.rotation_last_position,
  });
}
