/**
 * Modul: "Wer hat die Aufgabe angelegt" (Ersteller-Anzeige)
 * Zweck: Der Schalter `task_created_by_visible` ist haushaltweit, Default AUS.
 *        Diese Suite haelt beide Seiten:
 * - die Route: GET /preferences liefert den Schalter als echtes Bool (nie als
 *   '1'-String), PUT ist Admin-only und lehnt Nicht-Bool mit 400 ab, true
 *   persistiert und kommt im Echo zurueck;
 * - die Oberflaeche: die Leseansicht nennt "Angelegt von <Name>" nur, wenn der
 *   Schalter an UND `created_by` gesetzt ist - Default aus zeigt nichts, ein
 *   fehlender Ersteller zeigt nichts, und ohne Aufloesung auf einen Namen
 *   zeigt die Ansicht keinen geratenen.
 *
 * Der Anzeigeteil faehrt dasselbe `taskDetailHead`, das die Leseansicht in
 * ihren Kopf legt (Browser-Loader-Umgebung wie test-task-approval-ui.js);
 * der Schalter kommt ueber den Praeferenz-Cache, den ein Stub von
 * `/api.js` fuellt.
 *
 * Ausfuehren: npm run test:task-created-by
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'task-created-by-test-secret-min-32-chars!';

import http from 'node:http';
import express from 'express';

const { default: preferencesRouter } = await import('../server/routes/preferences.js');

// ---------------------------------------------------------
// Route: GET/PUT /preferences ueber den echten Router
// ---------------------------------------------------------
const app = express();
app.use(express.json());
const actor = { userId: 1, role: 'admin' };
app.use((req, _res, next) => {
  req.authUserId = actor.userId;
  req.authRole = actor.role;
  next();
});
app.use('/', preferencesRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function put(body, { role = 'admin' } = {}) {
  actor.role = role;
  const res = await fetch(`${base}/`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function get() {
  const res = await fetch(`${base}/`);
  return { status: res.status, body: await res.json() };
}

test.after(() => { server.close(); });

test('GET /preferences: der Schalter kommt als echtes Bool false, nicht als String', async () => {
  const { status, body } = await get();
  assert.equal(status, 200);
  assert.equal(body.data.task_created_by_visible, false,
    'Default ist aus - ein fehlender sync_config-Wert darf kein an sein');
});

test('PUT task_created_by_visible: Mitglied -> 403, Nicht-Bool -> 400, true persistiert', async () => {
  assert.equal((await put({ task_created_by_visible: true }, { role: 'member' })).status, 403,
    'schalten darf nur ein Admin');
  assert.equal((await put({ task_created_by_visible: 'ja' })).status, 400,
    'ein String ist kein Schalter');
  assert.equal((await put({ task_created_by_visible: 1 })).status, 400,
    'eine Zahl ist kein Schalter');
  const set = await put({ task_created_by_visible: true });
  assert.equal(set.status, 200);
  assert.equal(set.body.data.task_created_by_visible, true, 'die Antwort echoht den neuen Wert');
  assert.equal((await get()).body.data.task_created_by_visible, true, 'und er bleibt stehen');
  const off = await put({ task_created_by_visible: false });
  assert.equal(off.body.data.task_created_by_visible, false, 'abschalten geht ebenso');
});

// ---------------------------------------------------------
// Oberflaeche: taskDetailHead mit und ohne Schalter
// ---------------------------------------------------------
// Browser-Loader-Umgebung (dasselbe Muster wie test-task-approval-ui.js).
globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.CSS = globalThis.CSS ?? { escape: String };

test('tasks_require_approval: Default AN, Eltern schalten, Nicht-Eltern nicht', async () => {
  const { get: getDb } = await import('../server/db.js');
  const dad = getDb().prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('papapref', 'Papa', 'x', 'member', 'dad')").run().lastInsertRowid;
  const other = getDb().prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('omapref', 'Oma', 'x', 'member', 'other')").run().lastInsertRowid;
  assert.equal((await get()).body.data.tasks_require_approval, true, 'Default AN - kein Gesetz, das erst angefasst werden muss');
  actor.userId = dad;
  assert.equal((await put({ tasks_require_approval: false })).status, 200, 'ein Elternteil ohne Admin-Rolle schaltet');
  assert.equal((await get()).body.data.tasks_require_approval, false, 'persistiert, als echtes Bool zurueck');
  assert.equal((await put({ tasks_require_approval: 'ja' })).status, 400, 'Nicht-Bool bleibt 400');
  actor.userId = other;
  assert.equal((await put({ tasks_require_approval: true })).status, 403, 'Nicht-Eltern (family_role other) bleibt draussen');
  actor.userId = 1;
  await put({ tasks_require_approval: true });
});

const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();
globalThis.document.documentElement.classList = {
  toggle() {}, add() {}, remove() {}, contains() { return false; },
};
globalThis.window = globalThis.window ?? {};
globalThis.window.yuvomi = { showToast: () => {} };

const prefs = await import('/settings/preferences-cache.js');
const { __test: detail } = await import('/components/task-detail.js');

const USERS = [
  { id: 1, display_name: 'Mama', avatar_color: '#FF3B30' },
  { id: 2, display_name: 'Papa', avatar_color: '#007AFF' },
];
const aufgabe = (over = {}) => ({
  id: 7, title: 'Muell raus', status: 'open', category: 'household',
  priority: 'none', due_date: null, due_time: null,
  created_at: '2026-11-09T10:30:00Z',
  assigned_users: [], created_by: 1, ...over,
});

/** Den Praeferenz-Cache auf einen Stand setzen (wie eine echte GET-Antwort). */
const cacheWith = async (data) => {
  prefs.resetPreferencesCache();
  globalThis.__apiStub = { get: async () => ({ data }) };
  await prefs.getPreferences();
};

/** Der Text des synthetischen Ersteller-Kommentars, oder null. */
function creatorText(task, ctx) {
  const row = detail.createdByCommentRow(task, ctx);
  if (!row) return null;
  // mini-dom sammelt Kinder in childNodes (kein firstChild).
  return (row.childNodes ?? [])[0]?.textContent ?? row.firstChild?.textContent;
}

test('Default aus: weder Kopf noch Kommentar nennen den Ersteller', () => {
  const head = detail.taskDetailHead(aufgabe(), { users: USERS, showCreatedBy: false });
  assert.deepEqual(head.facts, [], 'ohne Schalter bleibt der Kopf frei von Ersteller-Text');
  assert.equal(creatorText(aufgabe(), { users: USERS, showCreatedBy: false }), null,
    'ohne Schalter zeigt auch der Kommentar nichts');
});

test('Schalter an: der erste Kommentar nennt Name und Zeit', () => {
  const text = creatorText(aufgabe({ created_by: 2 }), { users: USERS, showCreatedBy: true });
  assert.ok(text, 'mit Schalter zeichnet die Ansicht den Kommentar');
  assert.ok(text.startsWith('tasks.createdByComment'),
    'der Stub-t() liefert Schluessel plus Werte - gemessen wird die Loesung, nicht der Text');
  assert.ok(text.includes('Papa'), 'der Name des Anlegenden loest sich auf');
});

test('Der Kopf nennt den Ersteller nie - der Kommentar ist der einzige Ort', () => {
  const head = detail.taskDetailHead(aufgabe({ created_by: 2 }), { users: USERS, showCreatedBy: true });
  assert.deepEqual(head.facts, [], 'Kopf und Kommentar doppelt waere Rauschen');
});

test('created_by fehlt: nichts zu zeigen, auch mit Schalter an', () => {
  assert.equal(creatorText(aufgabe({ created_by: null }), { users: USERS, showCreatedBy: true }), null,
    'eine Aufgabe ohne Ersteller nennt keinen');
});

test('ohne Aufloesung kein Name: die Ansicht raet nicht', () => {
  assert.equal(creatorText(aufgabe({ created_by: 99 }), { users: USERS, showCreatedBy: true }), null,
    'ein erfundener Name waere schlimmer als keiner');
});

test('der Schalter kommt aus dem Praeferenz-Cache, wenn der ctx ihn nicht setzt', async () => {
  await cacheWith({ task_created_by_visible: true });
  assert.ok(creatorText(aufgabe(), { users: USERS }), 'Cache an -> Anzeige an');

  await cacheWith({ task_created_by_visible: false });
  assert.equal(creatorText(aufgabe(), { users: USERS }), null, 'Cache aus -> Anzeige aus');

  // Kein Cache ueberhaupt: die Richtung des Defaults (aus), nicht ein geratenes An.
  prefs.resetPreferencesCache();
  assert.equal(creatorText(aufgabe(), { users: USERS }), null, 'ohne Antwort bleibt es beim Default aus');
});

test('savePreferences zieht den Cache nach (Speichern im Blatt wirkt sofort)', async () => {
  prefs.resetPreferencesCache();
  globalThis.__apiStub = {
    get: async () => ({ data: { task_created_by_visible: false } }),
    put: async (_url, body) => ({ data: body }),
  };
  await prefs.getPreferences();
  assert.equal(prefs.cachedPreference('task_created_by_visible'), false);
  await prefs.savePreferences({ task_created_by_visible: true });
  assert.equal(prefs.cachedPreference('task_created_by_visible'), true,
    'der Nutzer hat soeben geschaltet - die naechste Aufgabe zeigt den Namen');
});
