/**
 * Modul: Aufgaben von Kindern tragen keine Punkte (Haushalt-Regel)
 * Zweck: Punkte darf nur setzen, wer Eltern-/Admin-Rolle hat. Ein Kind kann
 *        Aufgaben anlegen und bearbeiten - der Punktwert bleibt 0, auch wenn
 *        der Body einen Wert mitschickt und auch beim Bearbeiten. Spaetere
 *        Punkte vergibt ein Elternteil. Durchsetzung liegt auf dem Router,
 *        nicht nur im Dialog (dasselbe Muster wie test-task-lock.js).
 * Ausführen: npm run test:child-task-points
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'child-task-points-test-secret-min-32-chars!';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');

const moduleDatabase = get();
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

function applyMigration(database, migration) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(database);
  database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

function buildMigratedDatabase(migrations) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) applyMigration(database, migration);
  return database;
}

function seedUser(prefix, { role = 'member', family_role = 'other' } = {}) {
  return db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
    VALUES (?, ?, 'hash', '#007AFF', ?, ?)
  `).run(`${prefix}-${randomUUID()}`, prefix, role, family_role).lastInsertRowid;
}

const DAD   = seedUser('dad',   { family_role: 'dad' });
const CHILD = seedUser('kind',  { family_role: 'child' });
const ADMIN = seedUser('admin', { role: 'admin' });

const asDad   = { id: DAD,   role: 'member' };
const asChild = { id: CHILD, role: 'member' };
const asAdmin = { id: ADMIN, role: 'admin'  };

let actor = asDad;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/api/v1/tasks', tasksRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/tasks`;

test.after(() => { server.close(); db.close(); });

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

// ---- Anlegen ----

test('Kind legt an: Punkte bleiben 0, auch mit Punkten im Body', async () => {
  const mit = await call('POST', '/', { as: asChild, body: { title: 'Zimmer', points: 5 } });
  assert.equal(mit.status, 201);
  assert.equal(mit.body.data.points, 0, 'ein Punktewert im Body darf keinem Kind Punkte geben');
  const ohne = await call('POST', '/', { as: asChild, body: { title: 'Muell' } });
  assert.equal(ohne.body.data.points, 0, 'auch der Haushalts-Standard gilt fuer Kinder nicht');
});

test('Elter legt an: Punkte bleiben moeglich (Standard und explizit)', async () => {
  const expl = await call('POST', '/', { as: asDad, body: { title: 'Werkstatt', points: 7 } });
  assert.equal(expl.status, 201);
  assert.equal(expl.body.data.points, 7);
});

test('Admin legt an: Punkte moeglich (Admin ist kein Kind)', async () => {
  const r = await call('POST', '/', { as: asAdmin, body: { title: 'Rasen', points: 3 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.points, 3);
});

test('Kind legt Subtask an: auch dort 0 Punkte', async () => {
  const vater = await call('POST', '/', { as: asDad, body: { title: 'Auto', points: 10 } });
  assert.equal(vater.body.data.points, 10);
  const sub = await call('POST', '/', {
    as: asChild,
    body: { title: 'Saugen', parent_task_id: vater.body.data.id, points: 4 },
  });
  assert.equal(sub.status, 201);
  assert.equal(sub.body.data.points, 0);
});

// ---- Bearbeiten ----

test('Kind bearbeitet die eigene Aufgabe: Punkte bleiben 0', async () => {
  const angelegt = await call('POST', '/', { as: asChild, body: { title: 'Fahrrad' } });
  const id = angelegt.body.data.id;
  const patch = await call('PUT', `/${id}`, { as: asChild, body: { points: 9 } });
  assert.equal(patch.status, 200, '400-Grund: ' + JSON.stringify(patch.body));
  assert.equal(patch.body.data.points, 0, 'Punkte nachtraeglich setzen darf ein Kind nicht');
});

test('Elter punktet nachtraegig: das bleibt der Weg zu Punkten', async () => {
  const angelegt = await call('POST', '/', { as: asChild, body: { title: 'Vorlesen' } });
  const id = angelegt.body.data.id;
  const patch = await call('PUT', `/${id}`, { as: asDad, body: { points: 9 } });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.data.points, 9);
});

// ---- Meta fuer die Oberflaeche ----

test('meta/options: points_editable zeigt der Oberflaeche die Regel', async () => {
  const kind = await call('GET', '/meta/options', { as: asChild });
  assert.equal(kind.status, 200);
  assert.equal(kind.body.points_editable, false);
  const vater = await call('GET', '/meta/options', { as: asDad });
  assert.equal(vater.body.points_editable, true);
});

// ---- Migration 294: rueckwirkend ----

test('Migration 294 nullt Punkte bestehender Kind-Aufgaben (Rueckblick)', () => {
  const mig = MIGRATIONS.find((m) => m.version === 294);
  assert.ok(mig, 'Migration 294 fehlt');
  db.prepare(`
    INSERT INTO tasks (title, status, points, created_by)
    VALUES ('Alt', 'open', 5, ?)
  `).run(CHILD);
  const before = db.prepare('SELECT points FROM tasks WHERE title = ?').get('Alt').points;
  assert.equal(before, 5, 'aufgebaut wird vor der Regel, zum Beweis');
  mig.up(db);
  assert.equal(db.prepare('SELECT points FROM tasks WHERE title = ?').get('Alt').points, 0,
    'bestehende Kind-Aufgaben fallen auf 0 - die Regel gilt fuer den ganzen Haushalt');
  // Elternaufgabe bleibt unberuehrt.
  db.prepare(`
    INSERT INTO tasks (title, status, points, created_by)
    VALUES ('Vaters Alt', 'open', 5, ?)
  `).run(DAD);
  mig.up(db);
  assert.equal(db.prepare('SELECT points FROM tasks WHERE title = ?').get('Vaters Alt').points, 5);
});
