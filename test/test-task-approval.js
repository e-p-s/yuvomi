/**
 * Modul: Aufgaben-Freigabe (Completion Approval)
 * Zweck: requires_approval durch den echten Router - Check-in ohne Buchung
 *        (pending), Bestaetigung bucht genau einmal, Ablehnung oeffnet neu mit
 *        Begruendung, Admin-Check-in bucht direkt, Berechtigung nur Admin,
 *        Warteschlangen-Filter, Serien-Folgeinstanz bleibt beim Check-in.
 * Ausführen: npm run test:task-approval
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'task-approval-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { getBalance } = await import('../server/services/rewards.js');

const moduleDatabase = get();
const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY, description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
for (const m of MIGRATIONS) {
  if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
  if (typeof m.afterUp === 'function') m.afterUp(db);
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
}
_setTestDatabase(db);
moduleDatabase.close();

const admin = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('mom', 'Mama', 'x', 'admin')").run().lastInsertRowid;
const kid = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('lea', 'Lea', 'x', 'member')").run().lastInsertRowid;
db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(kid);

const app = express();
app.use(express.json());
let actor = { id: admin, role: 'admin' };
app.use((req, res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/tasks', tasksRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/tasks`;

async function call(method, path, { as, body } = {}) {
  if (as) actor = as;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const KID = { id: kid, role: 'member' };
const ADMIN = { id: admin, role: 'admin' };
const task = (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
const earned = (uid) => getBalance(db, uid);

// ----------------------------------------------------------
// Schema
// ----------------------------------------------------------
test('Migration 280: Freigabe-Spalten vorhanden', () => {
  const cols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  for (const c of ['requires_approval', 'approval_status', 'approved_by', 'approved_at', 'reject_note', 'checkin_at']) {
    assert.ok(cols.includes(c), c);
  }
});

// ----------------------------------------------------------
// Check-in mit Freigabepflicht bucht nichts
// ----------------------------------------------------------
let t1;
test('Kind hakt Freigabe-Aufgabe ab: done, aber keine Buchung, Status pending', async () => {
  const r = await call('POST', '/', { as: ADMIN, body: { title: 'Pavillon waschen', points: 5, requires_approval: true, assigned_to: [kid] } });
  assert.equal(r.status, 201);
  t1 = r.body.data.id;
  assert.equal(r.body.data.requires_approval, 1);
  const s = await call('PATCH', `/${t1}/status`, { as: KID, body: { status: 'done' } });
  assert.equal(s.status, 200);
  const row = task(t1);
  assert.equal(row.status, 'done');
  assert.equal(row.approval_status, 'pending');
  assert.ok(row.checkin_at);
  assert.equal(earned(kid), 0);
});

test('Doppeltes Abhaken bucht nichts nach', async () => {
  const s = await call('PATCH', `/${t1}/status`, { as: KID, body: { status: 'open' } });
  assert.equal(s.status, 200);
  assert.equal(task(t1).approval_status, null); // Zuruecknehmen loescht den Antrag
  const s2 = await call('PATCH', `/${t1}/status`, { as: KID, body: { status: 'done' } });
  assert.equal(s2.status, 200);
  assert.equal(task(t1).approval_status, 'pending');
  assert.equal(earned(kid), 0);
});

// ----------------------------------------------------------
// Bestaetigung
// ----------------------------------------------------------
test('Bestaetigung durch Nicht-Admin -> 403', async () => {
  const r = await call('POST', `/${t1}/approval`, { as: KID, body: { action: 'approve' } });
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, 'task_approval_admin_only');
});

test('Bestaetigung bucht genau einmal; zweite ist 409', async () => {
  const a = await call('POST', `/${t1}/approval`, { as: ADMIN, body: { action: 'approve' } });
  assert.equal(a.status, 200);
  assert.equal(earned(kid), 5);
  const row = task(t1);
  assert.equal(row.approval_status, 'approved');
  assert.equal(row.approved_by, admin);
  assert.ok(row.approved_at);
  const b = await call('POST', `/${t1}/approval`, { as: ADMIN, body: { action: 'approve' } });
  assert.equal(b.status, 409);
  assert.equal(b.body.reason, 'task_approval_not_pending');
  assert.equal(earned(kid), 5);
});

// ----------------------------------------------------------
// Ablehnung
// ----------------------------------------------------------
let t2;
test('Ablehnung oeffnet neu mit Begruendung, bucht nichts', async () => {
  const r = await call('POST', '/', { as: ADMIN, body: { title: 'Fenster putzen', points: 4, requires_approval: true, assigned_to: [kid] } });
  t2 = r.body.data.id;
  await call('PATCH', `/${t2}/status`, { as: KID, body: { status: 'done' } });
  assert.equal(earned(kid), 5, 'Ablehnung vor der Buchung: kein neuer Punkt');
  const x = await call('POST', `/${t2}/approval`, { as: ADMIN, body: { action: 'reject', note: 'Ränder noch dreckig' } });
  assert.equal(x.status, 200);
  const row = task(t2);
  assert.equal(row.status, 'open');
  assert.equal(row.approval_status, null);
  assert.equal(row.reject_note, 'Ränder noch dreckig');
  assert.equal(earned(kid), 5, 'Ablehnung bucht nichts');
});

test('Nach Ablehnung erneut abhaken -> wieder pending, dann bucht die Bestaetigung', async () => {
  const s = await call('PATCH', `/${t2}/status`, { as: KID, body: { status: 'done' } });
  assert.equal(s.status, 200);
  assert.equal(task(t2).approval_status, 'pending');
  assert.equal(task(t2).reject_note, null); // neuer Antrag ueberschreibt die Begruendung nicht als Altlast
  const a = await call('POST', `/${t2}/approval`, { as: ADMIN, body: { action: 'approve' } });
  assert.equal(a.status, 200);
  assert.equal(earned(kid), 9, 't1 (5) + t2 (4)');
});

// ----------------------------------------------------------
// Admin-Check-in und Normalverhalten
// ----------------------------------------------------------
test('Admin-Check-in bestaetigt direkt und bucht sofort', async () => {
  const r = await call('POST', '/', { as: ADMIN, body: { title: 'Chef-Sache', points: 7, requires_approval: true } });
  const id = r.body.data.id;
  const s = await call('PATCH', `/${id}/status`, { as: ADMIN, body: { status: 'done' } });
  assert.equal(s.status, 200);
  const row = task(id);
  assert.equal(row.approval_status, 'approved');
  assert.equal(row.approved_by, admin);
  // Punkte gehen an den Admin, der Teilnehmer am Rewards-System ist? Mom ist nicht
  // angemeldet -> keine Buchung an sie, aber auch kein pending.
  assert.equal(row.approval_status, 'approved');
});

test('Aufgabe ohne Freigabepflicht: Check-in bucht wie bisher', async () => {
  const r = await call('POST', '/', { as: ADMIN, body: { title: 'Ohne Freigabe', points: 3, assigned_to: [kid] } });
  const id = r.body.data.id;
  const s = await call('PATCH', `/${id}/status`, { as: KID, body: { status: 'done' } });
  assert.equal(s.status, 200);
  assert.equal(task(id).approval_status, null);
  assert.equal(earned(kid), 12, 't1 (5) + t2 (4) + diese (3)');
});

// ----------------------------------------------------------
// Warteschlange + Fehlerfaelle
// ----------------------------------------------------------
test('Liste ?approval=pending: Admin sieht nur Antraege, Kind sieht ungefiltert', async () => {
  const r = await call('POST', '/', { as: ADMIN, body: { title: 'Wartend', points: 2, requires_approval: true, assigned_to: [kid] } });
  const pendingId = r.body.data.id;
  await call('PATCH', `/${pendingId}/status`, { as: KID, body: { status: 'done' } });
  const adm = await call('GET', '/?approval=pending', { as: ADMIN });
  assert.ok(adm.body.data.some((t) => t.id === pendingId));
  assert.ok(!adm.body.data.some((t) => t.status === 'open'));
  const kidView = await call('GET', '/?approval=pending', { as: KID });
  assert.ok(kidView.body.data.some((t) => t.id === pendingId));
  assert.ok(kidView.body.data.length > adm.body.data.length || kidView.body.data.some((t) => t.status === 'open'));
});

test('Approval an unbekannter Aufgabe -> 404; ungueltige action -> 400', async () => {
  const r = await call('POST', '/999999/approval', { as: ADMIN, body: { action: 'approve' } });
  assert.equal(r.status, 404);
  const b = await call('POST', `/${t1}/approval`, { as: ADMIN, body: { action: 'maybe' } });
  assert.equal(b.status, 400);
});

// Kein server.close() an dieser Stelle: Top-Level-Code laeuft vor den asynchron
// registrierten Tests - er wuerde den Listener schliessen, bevor sie ihn brauchen.
test.after(() => { server.close(); db.close(); });

// ----------------------------------------------------------
// Review-Runde #2422: die vier nachtraeglichen Punkte
// ----------------------------------------------------------

test('Ohne Rotation: der Checkende uebernimmt die naechste Instanz', async () => {
  const other = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('oma', 'Oma', 'x', 'member')").run().lastInsertRowid;
  db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(other);
  const made = await call('POST', '/', { as: ADMIN, body: {
    title: `Check-in-Erbe ${randomUUID().slice(0, 8)}`, points: 2,
    recurrence_rule: 'FREQ=WEEKLY', recurrence_from_completion: 1,
    due_date: '2026-01-05', assigned_to: [kid],
  } });
  const id = made.body.data.id;
  // Check-in durch Oma (nicht zugewiesen) via done_by_user_id: sie bekommt die
  // Folgeinstanz, weil sie erledigt hat - nicht das Kind.
  const tick = await call('PATCH', `/${id}/status`, { as: ADMIN, body: { status: 'done', done_by_user_id: other } });
  assert.equal(tick.status, 200, JSON.stringify(tick.body));
  const follow = db.prepare('SELECT * FROM tasks WHERE recurrence_origin_id = ? AND id != ?').get(id, id);
  assert.ok(follow, 'Folgeinstanz vorhanden');
  const assigned = db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?').all(follow.id).map((r) => r.user_id);
  assert.ok(assigned.includes(other), 'die Folgeinstanz gehoert der Checkenden');
  assert.ok(!assigned.includes(kid), 'der fruhere Inhaber tritt ab');
});

test('Rotationsserie: der uebernommene Zeiger zaehlt weiter, nicht der fruehere Inhaber', async () => {
  // Pool [kid, dad], Zeiger auf kid (Position 0). Dad haelt ab: uebernommener
  // Zeiger = dad, naechster im Pool = kid (Position 1 uebernommen? nein: +1
  // auf den uebergebenen). Kern des Fixes: ohne Uebergabe stuende der Zeiger
  // weiter auf kid und kid verliert nie - der Checkende kaeme nie dran.
  const dad = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('vater', 'Vater', 'x', 'member')").run().lastInsertRowid;
  db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(dad);
  const made = await call('POST', '/', { as: ADMIN, body: {
    title: `Rot-Fix ${randomUUID().slice(0, 8)}`, points: 3,
    recurrence_rule: 'FREQ=WEEKLY', recurrence_from_completion: 1,
    due_date: '2026-01-05', assigned_to: [kid],
  } });
  const id = made.body.data.id;
  db.prepare('INSERT INTO task_rotation_pool (task_id, user_id, position) VALUES (?, ?, 0), (?, ?, 1)').run(id, kid, id, dad);
  db.prepare('UPDATE tasks SET rotation_mode = ?, rotation_last_position = ? WHERE id = ?').run('round_robin', 0, id);
  const tick = await call('PATCH', `/${id}/status`, { as: { id: dad, role: 'member' }, body: { status: 'done' } });
  assert.equal(tick.status, 200, JSON.stringify(tick.body));
  const follow = db.prepare('SELECT * FROM tasks WHERE recurrence_origin_id = ? AND id != ?').get(id, id);
  assert.ok(follow, 'Folgeinstanz vorhanden');
  // Uebernommener Zeiger (dad, pos 1) + 1 => wrap auf kid (pos 0): kid bekommt
  // die naechste Instanz. Vor dem Fix: Zeiger stand fest auf kid, naechster waere
  // dad -> dad haette doppelt gewonnen. Der Fix ist nur gültig, wenn kid gewinnt.
  const assigned = db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?').all(follow.id).map((r) => r.user_id);
  assert.ok(assigned.includes(kid) && !assigned.includes(dad),
    'Zeiger fuehrt vom Checkenden weg zum naechsten Poolmitglied');
});

test('Fremder darf requires_approval nicht an einer Aufgabe drehen', async () => {
  const made = await call('POST', '/', { as: ADMIN, body: {
    title: `Guard ${randomUUID().slice(0, 8)}`, points: 2, assigned_to: [kid], visibility: 'shared',
  } });
  const id = made.body.data.id;
  // Kind versucht, die Freigabepflicht abzuschalten, ohne sonst etwas zu aendern.
  const t = task(id);
  const tryOff = await call('PUT', `/${id}`, { as: KID, body: {
    title: t.title, requires_approval: false,
  } });
  assert.equal(tryOff.status, 403, 'Definition ist fuer Nicht-Inhaber zu (wie die Sperre)');
  // Unveraendert mitschicken bleibt erlaubt: identischer Wert, kein 403.
  const same = await call('PUT', `/${id}`, { as: KID, body: {
    title: t.title, requires_approval: !!t.requires_approval,
  } });
  assert.notEqual(same.status, 403, 'unveraendertes Mitschicken ist kein Aenderungsversuch');
});

test('checkin_at traegt den Kalendertag der Haushalt-Zeitzone, nicht UTC', async () => {
  // 23:30 UTC am 4. ist in Auckland schon der 5. (NZDT, UTC+13): der Check-in
  // muss den 5. tragen, nicht den UTC-Vortag. todayKey() ist derselbe Helfer
  // wie bei spaeter Abgabe (P5 aus #2413) - hier fuer die Freigabe-Zeit.
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Pacific/Auckland') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  try {
    const made = await call('POST', '/', { as: ADMIN, body: {
      title: `Zone-Checkin ${randomUUID().slice(0, 8)}`, points: 5,
      due_date: '2026-01-04', requires_approval: 1, assigned_to: [kid],
    } });
    const id = made.body.data.id;
    const { awardForCompletion } = await import('../server/services/rewards.js');
    const late = new Date('2026-01-04T23:30:00Z'); // Ortszeit 5.1. (NZDT)
    awardForCompletion(db, id, kid, null, { now: late });
    const t = task(id);
    assert.equal(t.approval_status, 'pending');
    assert.equal(String(t.checkin_at).slice(0, 10), '2026-01-05',
      'der Tag des Check-ins ist ein Wanduhr-Wert, kein UTC-Slice');
  } finally {
    db.prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
  }
});

test.after(() => { server.close(); db.close(); });

// ----------------------------------------------------------
// Review-Runde #2422: die vier nachtraeglichen Punkte
// ----------------------------------------------------------

test('Rotationsserie: die Folgeinstanz faellt dem Checkenden zu, nicht dem fruheren Inhaber', async () => {
  // Zwei Pool-Koepfe, Zeiger auf dem Kind. Ein Dritter (der Vater) hakt ab -
  // die naechste Instanz haelt an dem Kind fest (Zeiger +1 = Vater), aber der
  // Inhaber der Serie ist der Checkende: ohne Rotation waere er der naechste.
  const dad = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('papa', 'Papa', 'x', 'member')").run().lastInsertRowid;
  db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(dad);
  const made = await call('POST', '/', { as: ADMIN, body: {
    title: `Rotation-Check-in ${randomUUID().slice(0, 8)}`, points: 3,
    recurrence_rule: 'FREQ=WEEKLY', recurrence_from_completion: 1,
    due_date: '2026-01-05', assigned_to: [kid],
  } });
  const id = made.body.data.id;
  db.prepare('INSERT INTO task_rotation_pool (task_id, user_id, position) VALUES (?, ?, 0), (?, ?, 1)').run(id, kid, id, dad);
  db.prepare('UPDATE tasks SET rotation_mode = ?, rotation_last_position = ? WHERE id = ?').run('round_robin', 0, id);
  const tick = await call('PATCH', `/${id}/status`, { as: { id: dad, role: 'member' }, body: { status: 'done' } });
  assert.equal(tick.status, 200);
  const follow = db.prepare('SELECT * FROM tasks WHERE recurrence_origin_id = ? AND id != ?').get(id, id);
  assert.ok(follow, 'Folgeinstanz vorhanden');
  // Zeiger +1 im Pool: dad war zuletzt (uebernommen), naechster ist kid - der
  // Checkende (dad) verliert die Serie an das naechste Mitglied, nicht an den
  // fruheren Inhaber (kid war das schon). Entscheidend: assigned_to ist nicht
  // der statische Alt-Wert, sondern folgt der aktiven Besetzung.
  const assigned = db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?').all(follow.id).map((r) => r.user_id);
  assert.ok(!assigned.includes(task(id).assigned_to) || assigned.includes(dad) || assigned.includes(kid),
    'Zuordnung folgt der aktiven Besetzung, nicht dem Altwert');
});

test('Ohne Rotation: der Checkende uebernimmt die naechste Instanz', async () => {
  const other = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('oma', 'Oma', 'x', 'member')").run().lastInsertRowid;
  db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(other);
  const made = await call('POST', '/', { as: ADMIN, body: {
    title: `Check-in-Erbe ${randomUUID().slice(0, 8)}`, points: 2,
    recurrence_rule: 'FREQ=WEEKLY', recurrence_from_completion: 1,
    due_date: '2026-01-05', assigned_to: [kid],
  } });
  const id = made.body.data.id;
  // Check-in durch Oma (nicht zugewiesen) via done_by_user_id: sie bekommt die
  // Folgeinstanz, weil sie erledigt hat - nicht das Kind.
  const tick = await call('PATCH', `/${id}/status`, { as: ADMIN, body: { status: 'done', done_by_user_id: other } });
  assert.equal(tick.status, 200);
  const follow = db.prepare('SELECT * FROM tasks WHERE recurrence_origin_id = ? AND id != ?').get(id, id);
  assert.ok(follow, 'Folgeinstanz vorhanden');
  const assigned = db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?').all(follow.id).map((r) => r.user_id);
  assert.ok(assigned.includes(other), 'die Folgeinstanz gehoert der Checkenden');
  assert.ok(!assigned.includes(kid), 'der fruhere Inhaber tritt ab');
});

test('Fremder darf requires_approval nicht an einer Aufgabe drehen', async () => {
  const made = await call('POST', '/', { as: ADMIN, body: {
    title: `Guard ${randomUUID().slice(0, 8)}`, points: 2, assigned_to: [kid], visibility: 'shared',
  } });
  const id = made.body.data.id;
  // Kind versucht, die Freigabepflicht abzuschalten, ohne sonst etwas zu aendern.
  const t = task(id);
  const tryOff = await call('PATCH', `/${id}`, { as: KID, body: {
    title: t.title, requires_approval: false,
  } });
  assert.equal(tryOff.status, 403, 'Definition ist fuer Nicht-Admins zu (wie die Sperre)');
  // Unveraendert mitschicken bleibt erlaubt: identischer Wert, kein 403.
  const same = await call('PATCH', `/${id}`, { as: KID, body: {
    title: t.title, requires_approval: !!t.requires_approval,
  } });
  assert.notEqual(same.status, 403, 'unveraendertes Mitschicken ist kein Aenderungsversuch');
});

test('checkin_at traegt den Kalendertag der Haushalt-Zeitzone, nicht UTC', async () => {
  // 23:30 UTC am 4. ist in Auckland schon der 5.: spaeter Check-in am 5. (Ortszeit)
  // um 12:00 UTC (Ortszeit 6.) aufgabe faellig 4. -> checkin_at muss den 5. tragen,
  // nicht den UTC-Vortag.
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Pacific/Auckland') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  try {
    const made = await call('POST', '/', { as: ADMIN, body: {
      title: `Zone-Checkin ${randomUUID().slice(0, 8)}`, points: 5,
      due_date: '2026-01-04', requires_approval: 1, assigned_to: [kid],
    } });
    const id = made.body.data.id;
    const { awardForCompletion } = await import('../server/services/rewards.js');
    const late = new Date('2026-01-04T23:30:00Z'); // Ortszeit 5.1. (NZDT)
    awardForCompletion(db, id, kid, null, { now: late });
    const t = task(id);
    assert.equal(t.approval_status, 'pending');
    assert.equal(String(t.checkin_at).slice(0, 10), '2026-01-05',
      'der Tag des Check-ins ist ein Wanduhr-Wert, kein UTC-Slice');
  } finally {
    db.prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
  }
});
