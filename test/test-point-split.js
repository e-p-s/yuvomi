/**
 * Modul: Teilung der Punkte bei mehreren Zustaendigen (Haushalt-Regel 2026-11-10)
 * Zweck: Mehrere Zustaendige teilen sich den Punktwert moeglichst gleich - der
 *        Rest geht in Zuweisungsreihenfolge nach vorn. Eine einzelne Person
 *        und die benannt erledigende Person erhalten den vollen Wert.
 *        Wiedereroeffnen nimmt genau die gebuchten Teilbetrage zurueck.
 * Ausführen: npm run test:point-split
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'point-split-test-secret-min-32-chars!!';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { syncTaskRewards, getBalance } = await import('../server/services/rewards.js');

const moduleDatabase = get();
const database = new Database(':memory:');
database.pragma('foreign_keys = ON');
database.exec(`
  CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )
`);
for (const migration of MIGRATIONS) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(database);
  database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}
_setTestDatabase(database);
moduleDatabase.close();
const db = database;

function seedUser(prefix, family_role) {
  return db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
    VALUES (?, ?, 'hash', '#007AFF', 'member', ?)
  `).run(`${prefix}-${randomUUID()}`, prefix, family_role).lastInsertRowid;
}
const DAD = seedUser('vater', 'dad');
const KIM = seedUser('kim', 'child');
const FINN = seedUser('finn', 'child');
db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1), (?, 1)').run(KIM, FINN);

let seq = 1000;
function makeTask(points, assignees, title) {
  const id = ++seq;
  db.prepare(`INSERT INTO tasks (id, title, points, status, created_by) VALUES (?, ?, ?, 'open', ?)`)
    .run(id, title || `T${id}`, points, DAD);
  for (const uid of assignees)
    db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, uid);
  return id;
}
const complete = (id, day, doneBy = null) =>
  syncTaskRewards(db, id, 'open', 'done', DAD, doneBy, { completedOn: day });
const reopen = (id) => syncTaskRewards(db, id, 'done', 'open', DAD);
const bal = (uid) => getBalance(db, uid);

test('5 Punkte, zwei Zustaendige: 3 + 2 (Rest in Zuweisungsreihenfolge nach vorn)', () => {
  const a = makeTask(5, [KIM, FINN]);
  complete(a, '2031-01-01');
  assert.equal(bal(KIM), 3);
  assert.equal(bal(FINN), 2);
});

test('4 Punkte, zwei Zustaendige: glatt 2 + 2', () => {
  const a = makeTask(4, [KIM, FINN], 'glatt');
  const k = bal(KIM); const f = bal(FINN);
  complete(a, '2031-01-02');
  assert.equal(bal(KIM) - k, 2);
  assert.equal(bal(FINN) - f, 2);
});

test('Eine zugewiesene Person erhaelt den vollen Wert', () => {
  const a = makeTask(7, [KIM], 'solo');
  const k = bal(KIM);
  complete(a, '2031-01-03');
  assert.equal(bal(KIM) - k, 7);
});

test('Benannt erledigende Person erhaelt den vollen Wert, der andere geht leer aus', () => {
  const a = makeTask(6, [KIM, FINN], 'benannt');
  const k = bal(KIM); const f = bal(FINN);
  complete(a, '2031-01-04', FINN);
  assert.equal(bal(FINN) - f, 6);
  assert.equal(bal(KIM), k);
});

test('Wiedereroeffnen nimmt genau die gebuchten Teilbetrage zurueck', () => {
  const a = makeTask(5, [KIM, FINN], 'teilung-reversal');
  complete(a, '2031-01-06');
  const k = bal(KIM); const f = bal(FINN);
  reopen(a);
  assert.equal(bal(KIM), k - 3);
  assert.equal(bal(FINN), f - 2);
});
