/**
 * Modul: Konsequenzen-Katalog (Migration 287, /rewards/consequences)
 * Zweck: Die Vorlagen hinter der Straf-Vergabe. Eltern haben ihre
 *        Standard-Faelle nicht jedes Mal frei zu tippen - ein Katalogeintrag
 *        fuellt Grund und Punkte in POST /penalty (catalog_consequence_id),
 *        freies Editieren bleibt (gesetzte reason/amount gewinnen). Pflege wie
 *        der Praemien-Katalog: Admin-only, `active` statt Loeschen.
 *        Gehalten werden zudem die zwei Absagen der Vergabe: eine unbekannte
 *        Vorlage ist 400 `rewards_consequence_not_found`, eine deaktivierte ist
 *        400 `rewards_consequence_disabled` - was die Familie ausschaltet,
 *        bucht sie nicht, auch nicht ueber eine alte Kennung.
 * Ausführen: npm run test:consequence-catalog
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: rewardsRouter } = await import('../server/routes/rewards.js');
const db = dbmod.get();

// ── Nutzer ─────────────────────────────────────────────────────────────────
db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('admin','Admin','x','admin','parent')").run();
db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('mom','Mom','x','member','mom')").run();
db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('leo','Leo','x','member','child')").run();
const id = (name) => db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
const ADMIN = { id: id('admin'), role: 'admin' };
const MOM = { id: id('mom'), role: 'member' };
const LEO = { id: id('leo'), role: 'member' };
db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(LEO.id);

const setFlag = (v) => db.prepare(
  "INSERT INTO sync_config (key, value) VALUES ('rewards_penalties_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
).run(v);

let actor = ADMIN;
const app = express();
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use(express.json());
app.use('/', rewardsRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, route, { as = ADMIN, body } = {}) {
  actor = as;
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// ── Vorlagen ───────────────────────────────────────────────────────────────
test('Migration liefert die zehn Vorlagen der Aufgabe und die Liste zeigt sie in sort_order', async () => {
  const res = await call('GET', '/consequences');
  assert.equal(res.status, 200);
  // Nicht die Zahl prueft hier, sondern die Zusage: die zehn Vorlagen der
  // Aufgabe stecken in der Tabelle, jede mit aktiven Punkten in der Spanne.
  // (Der Katalog traegt zusaetzlich die zwei Noten-Standardfaelle der Familie -
  // das zaehlt diese Suite nicht, sie prueft, dass die Vorlagen ankommen.)
  const titles = res.body.data.map((r) => r.title);
  for (const want of ['Hausaufgaben vergessen', 'Zimmer nicht aufgeraeumt', 'Unordnung im Bad',
    'Nichts abgewaschen', 'Zu spaet nach Hause gekommen', 'Luegen', 'Streit ohne Streitkultur',
    'Medienzeit ueberzogen', 'Handy beim Essen', 'Absage ohne Grund']) {
    assert.ok(titles.includes(want), `Vorlage fehlt: ${want}`);
  }
  assert.equal(titles.filter((x) => !x.startsWith('Note '))[0], 'Hausaufgaben vergessen',
    'sort_order fuehrt die Liste (die Noten-Faelle der Familie stehen vorn)');
  assert.ok(res.body.data.every((r) => r.active === 1 && r.points >= 1 && r.points <= 100));
  const orders = res.body.data.map((r) => r.sort_order);
  assert.deepEqual([...orders].sort((a, b) => a - b), orders, 'sort_order aufsteigend');
});

test('Nicht-Admin bekommt die Liste ohne all=1 (aktive Eintraege), Anlegen ist 403', async () => {
  const list = await call('GET', '/consequences', { as: MOM });
  assert.equal(list.status, 200, 'die Liste darf ein Kind nicht aussperren - die Vergabe-Oberflaeche ist offen');
  const created = await call('POST', '/consequences', { as: MOM, body: { title: 'Fremde Macht', points: 5 } });
  assert.equal(created.status, 403);
});

test('Anlegen ohne Punkte ist 400, Punkte 0 und 101 sind 400, ein sauberer Eintrag wird 201', async () => {
  const noPoints = await call('POST', '/consequences', { body: { title: 'Ohne Punkte' } });
  assert.equal(noPoints.status, 400);
  const zero = await call('POST', '/consequences', { body: { title: 'Null', points: 0 } });
  assert.equal(zero.status, 400);
  const over = await call('POST', '/consequences', { body: { title: 'Ueber der Grenze', points: 101 } });
  assert.equal(over.status, 400);
  const ok = await call('POST', '/consequences', { body: { title: 'Zahn geputzt vergessen', points: 7 } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.points, 7);
  assert.equal(ok.body.data.active, 1);
});

test('Titel leer oder 121 Zeichen ist 400', async () => {
  const empty = await call('POST', '/consequences', { body: { title: '   ', points: 5 } });
  assert.equal(empty.status, 400);
  const long = await call('POST', '/consequences', { body: { title: 'x'.repeat(121), points: 5 } });
  assert.equal(long.status, 400);
});

test('PUT bearbeitet Titel und Punkte, fehlende Felder bleiben', async () => {
  const created = await call('POST', '/consequences', { body: { title: 'Temporaer', points: 3, description: 'Notiz' } });
  const upd = await call('PUT', `/consequences/${created.body.data.id}`, { body: { points: 9 } });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.data.points, 9);
  assert.equal(upd.body.data.title, 'Temporaer', 'ein fehlender Titel veraendert nichts');
  assert.equal(upd.body.data.description, 'Notiz');
  const gone = await call('PUT', '/consequences/999999', { body: { points: 5 } });
  assert.equal(gone.status, 404);
  assert.equal(gone.body.reason, 'rewards_consequence_not_found');
});

test('Toggle deaktiviert: Liste ohne all=1 laesst den Eintrag weg, all=1 zeigt ihn', async () => {
  const created = await call('POST', '/consequences', { body: { title: 'Fenster nicht zu', points: 5 } });
  const tid = created.body.data.id;
  const flipped = await call('POST', `/consequences/${tid}/toggle`);
  assert.equal(flipped.status, 200);
  assert.equal(flipped.body.data.active, 0);
  const active = await call('GET', '/consequences');
  assert.ok(!active.body.data.some((r) => r.id === tid), 'deaktivierte Vorlage verlaesst die aktive Liste');
  const all = await call('GET', '/consequences?all=1');
  assert.ok(all.body.data.some((r) => r.id === tid), 'Admin sieht mit all=1 auch die inaktive');
});

// ── Vergabe ueber die Vorlage ──────────────────────────────────────────────
test('Vergabe mit catalog_consequence_id fuellt reason und Punkte aus dem Katalog', async () => {
  setFlag('1');
  const tpl = (await call('GET', '/consequences')).body.data.find((r) => r.title === 'Unordnung im Bad');
  const before = db.prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM reward_ledger WHERE user_id = ?').get(LEO.id).s;
  const res = await call('POST', '/penalty', { as: MOM, body: { user_id: LEO.id, catalog_consequence_id: tpl.id } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const row = db.prepare("SELECT * FROM reward_ledger WHERE user_id = ? AND type = 'penalty' ORDER BY id DESC LIMIT 1").get(LEO.id);
  assert.equal(row.reason, 'Unordnung im Bad', 'der Grund ist der Titel der Vorlage');
  assert.equal(row.delta, -tpl.points, 'die Punkte kommen als Abzug aus der Vorlage');
  assert.equal(res.body.data.balance, before - tpl.points);
});

test('Gesetzte reason/amount ueberschreiben die Vorlage (freies Editieren bleibt)', async () => {
  const tpl = (await call('GET', '/consequences')).body.data.find((r) => r.title === 'Luegen');
  const res = await call('POST', '/penalty', { as: MOM, body: { user_id: LEO.id, catalog_consequence_id: tpl.id, amount: 2, reason: 'Doppelt gehalten' } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const row = db.prepare("SELECT * FROM reward_ledger WHERE user_id = ? AND type = 'penalty' ORDER BY id DESC LIMIT 1").get(LEO.id);
  assert.equal(row.reason, 'Doppelt gehalten');
  assert.equal(row.delta, -2);
});

test('Unbekannte Vorlage ist 400 not_found, deaktivierte ist 400 disabled', async () => {
  const unknown = await call('POST', '/penalty', { body: { user_id: LEO.id, catalog_consequence_id: 999999 } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.reason, 'rewards_consequence_not_found');

  const created = await call('POST', '/consequences', { body: { title: 'Ausgeschaltet', points: 5 } });
  const tid = created.body.data.id;
  await call('POST', `/consequences/${tid}/toggle`);
  const disabled = await call('POST', '/penalty', { body: { user_id: LEO.id, catalog_consequence_id: tid } });
  assert.equal(disabled.status, 400);
  assert.equal(disabled.body.reason, 'rewards_consequence_disabled',
    'was die Familie ausschaltet, bucht sie nicht - auch nicht ueber eine alte Kennung');
});

test('DELETE loescht die Vorlage; gebuchte Konsequenzen bleiben unangetastet', async () => {
  const created = await call('POST', '/consequences', { body: { title: 'Zum Loeschen', points: 4 } });
  const tid = created.body.data.id;
  const del = await call('DELETE', `/consequences/${tid}`);
  assert.equal(del.status, 200);
  const again = await call('DELETE', `/consequences/${tid}`);
  assert.equal(again.status, 404);
  assert.equal(again.body.reason, 'rewards_consequence_not_found');
});
