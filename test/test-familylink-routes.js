/**
 * Test: Family-Link-Routen (server/routes/media-time.js, familylink-Block)
 * Zweck: Die HTTP-Schicht der Istzeit-Einspeisung - usage (Kind nur fuer sich,
 * Eltern fuer alle, Tag-Format 400), mapping (Elternrecht, uid-Format,
 * Geraet-fremdes-Kind 404, null loescht), ingest-Knopf: ein Lauf ohne
 * Collector-Sitzion liefert status login_noetig und schreibt keine Zeile.
 * Muster: test/test-media-time-routes.js - express-App, fetch, injizierter actor.
 * Ausfuehren: node --experimental-sqlite --test test/test-familylink-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: mediaTimeRouter } = await import('../server/routes/media-time.js');
const svc = await import('../server/services/media-time.js');
const db = dbmod.get();

const ADMIN = { id: 1, role: 'admin' };
const DAD = { id: 2, role: 'member' };
db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('admin','Admin','x','admin','parent')").run();
db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('dad','Dad','x','member','parent')").run();

function cfgSet(key, value) {
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
cfgSet('media_time_enabled', '1');
// Der ingest-Test ruft den echten Collector NICHT auf: ein Kommando, das immer
// scheitert, prueft die Spec-Regel (login_noetig statt 0er-Snapshot).
cfgSet('familylink_ingest_command', 'false');

let actor = ADMIN;
const app = express();
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use(express.json());
app.use('/', mediaTimeRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, route, { actor: a = ADMIN, body } = {}) {
  actor = a;
  const headers = {};
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  let json = null;
  if (ct.includes('application/json')) { try { json = await res.json(); } catch { /* leer */ } }
  return { status: res.status, body: json };
}

let kidSeq = 0;
function freshKid() {
  const name = `FlKid-${++kidSeq}`;
  const id = db.prepare(
    "INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', 'member', 'child')"
  ).run(name.toLowerCase(), name).lastInsertRowid;
  return { id, role: 'member' };
}
async function mkDevice(childId, name) {
  const res = await call('POST', '/devices', { body: { user_id: childId, name } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data.id;
}

const UID = '4001234567';
const kidA = freshKid();
const kidB = freshKid();
const devA = await mkDevice(kidA.id, 'A-Handy');

// ════════════════════════════════════════════════════════════════════════════

test('PUT /familylink/mapping - Mitglied ohne Elternrolle darf nicht zuordnen (403)', async () => {
  const member = { id: db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('flmember','M','x','member','other')").run().lastInsertRowid, role: 'member' };
  const res = await call('PUT', '/familylink/mapping', { actor: member, body: { user_id: kidA.id, google_uid: UID } });
  assert.equal(res.status, 403);
});

test('PUT /familylink/mapping - uid-Format, Geraet-fremdes-Kind, Erfolg, Loeschen', async () => {
  const bad = await call('PUT', '/familylink/mapping', { body: { user_id: kidA.id, google_uid: 'abc' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.reason, 'media_time_bad_request');
  const foreign = await call('PUT', '/familylink/mapping', {
    body: { user_id: kidA.id, google_uid: UID, devices: [{ google_device_id: 'gdev-1', media_time_device_id: devA }] },
  });
  assert.equal(foreign.status, 200, 'das Geraet gehoert zum Kind: Zuordnung okay');
  const strangerDev = await mkDevice(kidB.id, 'B-Handy');
  const wrongChild = await call('PUT', '/familylink/mapping', {
    body: { user_id: kidA.id, google_uid: UID, devices: [{ google_device_id: 'gdev-x', media_time_device_id: strangerDev }] },
  });
  assert.equal(wrongChild.status, 404);
  assert.equal(wrongChild.body.reason, 'media_time_not_found');
  const read = await call('GET', `/familylink/mapping?user_id=${kidA.id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.data.mapped, true);
  assert.equal(read.body.data.devices[0].media_time_device_id, devA);
  const cleared = await call('PUT', '/familylink/mapping', { body: { user_id: kidA.id, google_uid: null } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.data.mapped, false);
  const again = await call('GET', `/familylink/mapping?user_id=${kidA.id}`);
  assert.equal(again.body.data.mapped, false);
});

test('GET /familylink/mapping - Kind liest sich selbst, nicht das andere (403)', async () => {
  const res = await call('GET', `/familylink/mapping?user_id=${kidB.id}`, { actor: kidA });
  assert.equal(res.status, 403);
  const self = await call('GET', '/familylink/mapping', { actor: kidA });
  assert.equal(self.status, 200);
});

test('GET /familylink/usage - Tag-Format 400, sonst Antwort ohne Null-Behauptung', async () => {
  const bad = await call('GET', '/familylink/usage?day=morgen');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.reason, 'media_time_bad_request');
  const res = await call('GET', '/familylink/usage', { actor: kidA });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.mapped, false);
  assert.equal(res.body.data.devices.length, 0);
});

test('POST /familylink/ingest - Lauf ohne Collector-Sitzion: login_noetig, keine Zeile', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM familylink_daily').get().n;
  const res = await call('POST', '/familylink/ingest', { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.ok, false);
  assert.equal(res.body.data.status, 'login_noetig');
  assert.equal(res.body.data.written, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM familylink_daily').get().n, before,
    '401 schreibt nie 0er-Snapshots (Spec-Regel)');
});

test('GET /settings - familylink-Felder sind vorhanden (Schalter + Status)', async () => {
  const res = await call('GET', '/settings');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.data.familylink_ingest_enabled, 'boolean');
  assert.equal(res.body.data.familylink_status, 'login_noetig');
});

test('PUT /settings - Schalter speichert, Nicht-Boolean 400', async () => {
  const ok = await call('PUT', '/settings', { body: { familylink_ingest_enabled: true } });
  assert.equal(ok.status, 200);
  const read = await call('GET', '/settings');
  assert.equal(read.body.data.familylink_ingest_enabled, true);
  const bad = await call('PUT', '/settings', { body: { familylink_ingest_enabled: 'ja' } });
  assert.equal(bad.status, 400);
});

test('GET /today - familylink-Block ohne Zuordnung: mapped false, keine Null-Zeit', async () => {
  const dayKey = svc.mediaTimeDayKey(db);
  const res = await call('GET', `/today?user_id=${kidB.id}`, { actor: DAD });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.familylink.mapped, false);
  assert.equal(res.body.data.familylink.devices.length, 0);
  assert.ok(dayKey.length === 10);
});

test('POST /familylink/token + /familylink/report — Fluss: Token 401/401/200/400', async () => {
  const t = await call('POST', '/familylink/token', { body: {} });
  assert.equal(t.status, 200);
  const token = t.body.data.token;
  assert.ok(String(token).startsWith('flk_'), 'Token-Format');
  const post = (tok, body) => fetch(`${baseUrl}/familylink/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(tok ? { 'x-familylink-token': tok } : {}) },
    body: JSON.stringify(body),
  });
  const noTok = await post(null, { date: '2026-11-05', children: [] });
  assert.equal(noTok.status, 401);
  const badTok = await post('flk_falsch', { date: '2026-11-05', children: [] });
  assert.equal(badTok.status, 401);
  await call('PUT', '/familylink/mapping', { body: { user_id: kidB.id, google_uid: '5001234567', devices: [] } });
  const ok = await post(token, {
    date: '2026-11-05',
    children: [{ userId: '5001234567', name: 'Verworfen', devices: [
      { id: 'gd-1', consumed_min: 20, allowed_min: 60, remaining_min: 40 },
    ] }],
  });
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal(j.data.written, 1);
  const childRow = db.prepare(
    'SELECT display_name FROM familylink_children WHERE google_uid = ?'
  ).get('5001234567');
  assert.notEqual(childRow.display_name, 'Verworfen', 'der Google-Name aus dem Push wird nicht gespeichert');
  const broken = await post(token, { date: 'morgen', children: [] });
  assert.equal(broken.status, 400);
  assert.equal((await broken.json()).reason, 'media_time_bad_request');
});

test('POST /familylink/token — Mitglied ohne Elternrolle 403', async () => {
  const member = { id: db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('fltok','T','x','member','other')").run().lastInsertRowid, role: 'member' };
  const res = await call('POST', '/familylink/token', { actor: member, body: {} });
  assert.equal(res.status, 403);
});
