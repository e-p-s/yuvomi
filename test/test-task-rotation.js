/**
 * Modul: Tasks-Rotation-Test
 * Zweck: Rotation fuer wiederkehrende Serien (Migration 272). Unit: die drei
 *        Strategien sind deterministisch und der Pool unter zwei Koepfen ist
 *        Aus. Integration: Abhaken einer rotierenden Serie haengt die
 *        Folgeinstanz an das naechste Mitglied — Modus und Pool reisen als Wert
 *        mit (#1603-Prinzip), ohne Rotation bleibt das Verhalten exakt das
 *        bisherige (Assignment-Kopie).
 * Ausführen: node --test test/test-task-rotation.js
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';

const { MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { pickRotationUser, setRotation } = await import('../server/services/task-rotation.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');

const DAY = 86400000;
const dayKey = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  return db;
}

const db = buildTestDb();
_setTestDatabase(db);
const uid = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', '$2b$12$x', 'admin')`).run().lastInsertRowid;
function mkUser(name) {
  return db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, '$2b$12$x', 'member')`).run(name, name).lastInsertRowid;
}
const u2 = mkUser('zwei');
const u3 = mkUser('drei');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = uid;
  req.session = { userId: uid, role: 'admin' };
  next();
});
app.use('/api/v1/tasks', tasksRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/tasks`;
test.after(() => server.close());

async function call(method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function insertTask(fields) {
  const cols = Object.keys(fields);
  return db.prepare(
    `INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).run(...cols.map((c) => fields[c])).lastInsertRowid;
}

function insertRecurringSeries(title, mode, pool) {
  const id = insertTask({
    title, category: 'Haushalt', priority: 'medium', status: 'open',
    due_date: dayKey(0), assigned_to: pool[0], created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  setRotation(db, id, { mode, pool });
  db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, pool[0]);
  return id;
}

function completeTask(id) {
  return call('PATCH', `/${id}/status`, { status: 'done' });
}

function openFollowup(title) {
  return db.prepare(
    `SELECT t.* FROM tasks t
     WHERE t.title = ? AND t.status = 'open' AND t.parent_task_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM task_completions c WHERE c.task_id = t.id)
     ORDER BY t.id DESC LIMIT 1`,
  ).get(title);
}

// --------------------------------------------------------
// Unit: pickRotationUser
// --------------------------------------------------------

test('round_robin: Reihenfolge folgt dem Pool, letzte Empfaengerin zaehlt', () => {
  const id = insertRecurringSeries('rr-basis', 'round_robin', [uid, u2, u3]);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  // Noch keine letzte Empfaengerin: erste im Pool.
  assert.equal(pickRotationUser(db, task), uid);
  const mitLetztem = { ...task, rotation_last_user: u2 };
  assert.equal(pickRotationUser(db, mitLetztem), u3);
  // Am Pool-Ende wieder von vorn.
  assert.equal(pickRotationUser(db, { ...task, rotation_last_user: u3 }), uid);
});

test('round_robin: letzter Nutzer nicht mehr im Pool -> wieder vorn', () => {
  const id = insertRecurringSeries('rr-draussen', 'round_robin', [uid, u2]);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  assert.equal(pickRotationUser(db, { ...task, rotation_last_user: u3 }), uid);
});

test('Pool unter zwei Mitgliedern: keine Rotation (null)', () => {
  const id = insertRecurringSeries('klein', 'round_robin', [uid]);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  assert.equal(pickRotationUser(db, task), null);
});

test('Modus null: Rotation aus, egal welcher Pool', () => {
  const id = insertRecurringSeries('aus', null, [uid, u2]);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  assert.equal(pickRotationUser(db, task), null);
});

test('least_assigned: die Entlastete gewinnt, Gleichstand bricht die Pool-Position', () => {
  const id = insertRecurringSeries('la-basis', 'least_assigned', [u2, u3]);
  // u2 traegt zwei offene Fremd-Aufgaben, u3 keine.
  for (let i = 0; i < 2; i++) {
    const t = insertTask({ title: `Fremd ${i}`, status: 'open', due_date: dayKey(1), created_by: uid });
    db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(t, u2);
  }
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  assert.equal(pickRotationUser(db, task), u3);
  // Aufgabe nur in task_assignments (ohne assigned_to) zaehlt ebenfalls.
  const t = insertTask({ title: 'Fremd nur-assigned', status: 'open', due_date: dayKey(1), created_by: uid });
  db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(t, u3);
  assert.equal(pickRotationUser(db, task), u3, 'u3 jetzt 1 vs u2 2 -> immer noch u3');
});

test('least_recent: zuletzt Erledigter wird uebersprungen, ohne Historie gewinnt die Position', () => {
  const id = insertRecurringSeries('lr-basis', 'least_recent', [uid, u2]);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  // U2 hat gerade eben erledigt, u3 nie.
  db.prepare(`INSERT INTO task_completions (task_id, series_id, user_id, completed_at)
    VALUES (?, ?, ?, '2026-10-29T09:00:00Z')`).run(id, id, u2);
  assert.equal(pickRotationUser(db, task), uid);
});

// --------------------------------------------------------
// Integration: Abhaken mit Rotation
// --------------------------------------------------------

test('round_robin ueber zwei Abhak-Runden: 1 -> 2 -> 3', async () => {
  const first = insertRecurringSeries('Muell rotierend', 'round_robin', [uid, u2, u3]);
  await completeTask(first);
  const f1 = db.prepare(
    `SELECT * FROM tasks WHERE title = 'Muell rotierend' AND status = 'open'
     AND recurrence_origin_id = ?`).get(first);
  assert.ok(f1, 'erste Folgeinstanz fehlt');
  assert.equal(f1.assigned_to, uid, 'erster Empfaenger = erster im Pool (kein letzter gesetzt)');
  assert.equal(f1.rotation_last_user, uid);
  assert.deepEqual(
    db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ? ORDER BY user_id').all(f1.id)
      .map((r) => r.user_id),
    [uid], 'Rotation setzt genau einen Empfaenger');
  assert.equal(f1.rotation_mode, 'round_robin', 'Modus reist als Wert mit');
  assert.deepEqual(
    db.prepare('SELECT user_id FROM task_rotation_pool WHERE task_id = ? ORDER BY position')
      .all(f1.id).map((r) => r.user_id),
    [uid, u2, u3], 'Pool reist als Wert mit');

  await completeTask(f1.id);
  const f2 = db.prepare(
    `SELECT * FROM tasks WHERE title = 'Muell rotierend' AND status = 'open'
     AND recurrence_origin_id = ?`).get(f1.id);
  assert.ok(f2);
  assert.equal(f2.assigned_to, u2);
  await completeTask(f2.id);
  const f3 = db.prepare(
    `SELECT * FROM tasks WHERE title = 'Muell rotierend' AND status = 'open'
     AND recurrence_origin_id = ?`).get(f2.id);
  assert.equal(f3.assigned_to, u3);
});

test('ohne Rotation: Assignment-Kopie wie bisher (Regression)', async () => {
  const id = insertRecurringSeries('ohne rotation', null, [uid, u2]);
  await completeTask(id);
  const f = db.prepare(
    `SELECT * FROM tasks WHERE title = 'ohne rotation' AND status = 'open'
     AND recurrence_origin_id = ?`).get(id);
  assert.ok(f);
  assert.equal(f.assigned_to, uid);
  assert.equal(f.rotation_mode, null);
  assert.equal(f.rotation_pool ?? null, null, 'attachRotation: null wenn keine Rotation');
});

// --------------------------------------------------------
// API: Validierung
// --------------------------------------------------------

test('POST ohne Regel, aber mit Modus -> 400', async () => {
  const res = await call('POST', '/', {
    title: 'kaputt', rotation_mode: 'round_robin', rotation_pool: [uid, u2],
  });
  assert.equal(res.status, 400);
});

test('POST Modus ohne Pool -> 400; fremde user_id im Pool -> 400', async () => {
  const r1 = await call('POST', '/', {
    title: 'p1', is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY', rotation_mode: 'round_robin',
  });
  assert.equal(r1.status, 400);
  const r2 = await call('POST', '/', {
    title: 'p2', is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
    rotation_mode: 'round_robin', rotation_pool: [uid, 9999],
  });
  assert.equal(r2.status, 400);
});

test('POST gueltig: Modus + Pool erreichbar, PUT-tausch behaelt Modus', async () => {
  const res = await call('POST', '/', {
    title: 'put-tausch', is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
    rotation_mode: 'round_robin', rotation_pool: [uid, u2],
  });
  assert.equal(res.status, 201);
  const task = res.body.data;
  assert.equal(task.rotation_mode, 'round_robin');
  assert.deepEqual(task.rotation_pool, [uid, u2]);
  const upd = await call('PUT', `/${task.id}`, {
    title: 'put-tausch', rotation_pool: [u2, u3],
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.data.rotation_mode, 'round_robin', 'Pool-Tausch(loescht den Modus nicht');
  assert.deepEqual(upd.body.data.rotation_pool, [u2, u3]);
  const off = await call('PUT', `/${task.id}`, { title: 'put-tausch', rotation_mode: null });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.rotation_mode, null);
  assert.equal(off.body.data.rotation_pool, null, 'Modus null loescht auch den Pool');
});

test('Rotation-Felder in der Liste: t.* + attachRotation', async () => {
  const res = await call('GET', '/?status=open&limit=100');
  assert.equal(res.status, 200);
  const withRot = res.body.data.find((t) => t.rotation_mode === 'round_robin');
  assert.ok(withRot, 'Liste liefert rotierende Aufgabe mit Modus');
  assert.ok(Array.isArray(withRot.rotation_pool));
});
