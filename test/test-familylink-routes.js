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
const { familylinkReportRouter } = await import('../server/routes/familylink-report.js');
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
app.use('/', familylinkReportRouter);
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

test('GET/PUT /settings - media_time_countdown_mode: Default beides, drei Werte, Unbekanntes 400, Kind 403', async () => {
  const fresh = await call('GET', '/settings');
  assert.equal(fresh.body.data.media_time_countdown_mode, 'beides', 'ohne Konfig-Zeile gilt der Default');
  for (const mode of ['ticker', 'balken', 'beides']) {
    const ok = await call('PUT', '/settings', { body: { media_time_countdown_mode: mode } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.media_time_countdown_mode, mode, 'die PUT-Antwort zeigt gleich den neuen Stand');
    const read = await call('GET', '/settings');
    assert.equal(read.body.data.media_time_countdown_mode, mode);
  }
  const bad = await call('PUT', '/settings', { body: { media_time_countdown_mode: 'digital' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.reason, 'media_time_bad_request');
  const after = await call('GET', '/settings');
  assert.equal(after.body.data.media_time_countdown_mode, 'beides', 'ein abgelehnter Schreibsatz aendert nichts');
  const forbidden = await call('PUT', '/settings', { actor: kidB, body: { media_time_countdown_mode: 'ticker' } });
  assert.equal(forbidden.status, 403, 'die Anzeige stellt das Elternteil ein');
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
  const post = (tok, body) => fetch(`${baseUrl}/media-time/familylink/report`, {
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

// ════════════════════════════════════════════════════════════════════════════
// Status-Report des Sammlers (abgelaufene Google-Sitzung) + Settings-Zeitmarken
// ════════════════════════════════════════════════════════════════════════════

async function freshReportToken() {
  const t = await call('POST', '/familylink/token', { body: {} });
  assert.equal(t.status, 200);
  return t.body.data.token;
}
function postReport(tok, body) {
  return fetch(`${baseUrl}/media-time/familylink/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(tok ? { 'x-familylink-token': tok } : {}) },
    body: JSON.stringify(body),
  });
}
const flSvc = await import('../server/services/familylink.js');
const statusRow = () => db.prepare(
  'SELECT value FROM sync_config WHERE key = ?').get(flSvc.FAMILYLINK_STATUS_KEYS.status)?.value ?? null;

test('POST /familylink/report - reiner Status-Report: login_noetig setzt den Status, ok setzt ihn zurueck', async () => {
  const token = await freshReportToken();
  const dead = await postReport(token, { status: 'login_noetig' });
  assert.equal(dead.status, 200);
  assert.deepEqual((await dead.json()).data, { status: 'login_noetig' });
  assert.equal(statusRow(), 'login_noetig', 'derselbe Statuspfad wie der lokale Lauf');
  const back = await postReport(token, { status: 'ok' });
  assert.equal(back.status, 200);
  assert.equal((await back.json()).data.status, 'ok');
  assert.equal(statusRow(), 'ok');
  // Ein reiner Status-Report schreibt keine Tageszeile (Spec-Regel: nie eine Null).
  const res = await postReport(token, { status: 'vielleicht' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).reason, 'media_time_bad_request');
  assert.equal(statusRow(), 'ok', 'ein abgelehnter Statuswert aendert nichts');
});

test('POST /familylink/report - Status-Report ohne/passenden Token: 401 wie beim Report', async () => {
  const token = await freshReportToken();
  const noTok = await postReport(null, { status: 'login_noetig' });
  assert.equal(noTok.status, 401);
  const badTok = await postReport('flk_falsch', { status: 'login_noetig' });
  assert.equal(badTok.status, 401);
  assert.equal((await badTok.json()).reason, 'media_time_unauthenticated');
  const ok = await postReport(token, { status: 'login_noetig' });
  assert.equal(ok.status, 200, 'mit Token nimmt die Route auch den reinen Status');
});

test('GET /settings - familylink_status_at und familylink_last_report_at zeigen die Zeiten', async () => {
  const token = await freshReportToken();
  await postReport(token, { status: 'login_noetig' });
  const settings = async () => (await call('GET', '/settings')).body.data;
  const afterStatus = await settings();
  assert.match(String(afterStatus.familylink_status_at),
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'die Statusmarke ist ein ISO-Moment');
  const lastBefore = afterStatus.familylink_last_report_at;
  await postReport(token, { status: 'ok' });
  const afterOk = await settings();
  assert.equal(afterOk.familylink_last_report_at, lastBefore,
    'ein reiner Statuslauf bewegt familylink_last_report_at nicht (nur echte Zeilen tun das)');
  await call('PUT', '/familylink/mapping', { body: { user_id: kidB.id, google_uid: '5001234567', devices: [] } });
  const pushed = await postReport(token, {
    date: '2026-11-06',
    children: [{ userId: '5001234567', name: 'Verworfen', devices: [
      { id: 'gd-ts', consumed_min: 5, allowed_min: 60, remaining_min: 55 },
    ] }],
  });
  assert.equal(pushed.status, 200);
  const afterPush = await settings();
  const newest = db.prepare('SELECT MAX(fetched_at) AS at FROM familylink_daily').get().at;
  assert.equal(afterPush.familylink_last_report_at, newest,
    'familylink_last_report_at ist MAX(fetched_at) aus familylink_daily');
  assert.equal(afterPush.familylink_status, 'ok', 'ein Report mit children setzt ok (bisheriger Weg)');
  assert.ok(String(afterPush.familylink_status_at) >= String(afterStatus.familylink_status_at),
    'die Statusmarke folgt der letzten Statussetzung');
});

// ════════════════════════════════════════════════════════════════════════════
// Fernlogin-Sitzung (POST /familylink/login-session) — Collector-Fetch mockt
 // der exportierte Hook des Dienstes (Muster holidays.js __setFetchImpl)
// ════════════════════════════════════════════════════════════════════════════

const flLogin = await import('../server/services/familylink-login.js');

test('POST /familylink/login-session - Konfiguration fehlt: 503 familylink_not_configured', async () => {
  delete process.env.FAMILYLINK_COLLECTOR_BASE;
  delete process.env.FAMILYLINK_LOGIN_SECRET;
  const res = await call('POST', '/familylink/login-session', { body: {} });
  assert.equal(res.status, 503);
  assert.equal(res.body.reason, 'media_time_familylink_not_configured');
});

test('POST /familylink/login-session - Kind ohne Elternrolle: 403 vor jeder Collector-Anfrage', async () => {
  process.env.FAMILYLINK_COLLECTOR_BASE = 'http://collector.invalid:9334/';
  process.env.FAMILYLINK_LOGIN_SECRET = 'test-login-secret';
  let touched = false;
  flLogin.__setFetchImpl(async () => { touched = true; return { ok: true }; });
  const res = await call('POST', '/familylink/login-session', { actor: kidB, body: {} });
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, 'media_time_forbidden');
  assert.equal(touched, false, 'die Absage fällt vor dem Collector-Ruf');
});

test('POST /familylink/login-session - Collector nicht erreichbar: 502 collector_unreachable', async () => {
  flLogin.__resetLoginSession();
  flLogin.__setFetchImpl(async () => { throw new Error('ECONNREFUSED'); });
  const res = await call('POST', '/familylink/login-session', { body: {} });
  assert.equal(res.status, 502);
  assert.equal(res.body.reason, 'media_time_familylink_collector_unreachable');
});

test('POST /familylink/login-session - Erfolg: Viewer-URL + Ablauf, Doppelstart storniert die alte Sitzung', async () => {
  const calls = [];
  flLogin.__setFetchImpl(async (url, opts) => {
    calls.push({ url, method: opts?.method, auth: opts?.headers?.authorization });
    return { ok: true, status: 200 };
  });
  const first = await call('POST', '/familylink/login-session', { body: {} });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const data = first.body.data;
  assert.match(data.viewer_url, /^http:\/\/collector\.invalid:9334\/login\/view\?t=[0-9a-f]{64}$/,
    'Base ohne SchrägstrichRest, Token ist 32 Byte hex');
  assert.match(String(data.expires_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const ttlMin = (new Date(data.expires_at).getTime() - Date.now()) / 60_000;
  assert.ok(ttlMin > 8 && ttlMin <= 10.5, `Ablauf liegt ~10 Minuten voraus (ist ${ttlMin.toFixed(1)})`);
  assert.ok(!JSON.stringify(first.body).includes('test-login-secret'),
    'das Collector-Geheimnis verlässt den Server nie in der Antwort');
  assert.deepEqual(calls.map((c) => c.url), ['http://collector.invalid:9334/login/start'],
    'erste Sitzung: kein Cancel vor dem Start');
  assert.equal(calls[0].auth, 'Bearer test-login-secret');
  // Doppelstart: die alte Sitzung wird storniert und durch eine neue ersetzt.
  const second = await call('POST', '/familylink/login-session', { body: {} });
  assert.equal(second.status, 200);
  assert.notEqual(second.body.data.viewer_url, data.viewer_url, 'neues Token');
  assert.deepEqual(calls.slice(1).map((c) => c.url), [
    'http://collector.invalid:9334/login/cancel',
    'http://collector.invalid:9334/login/start',
  ], 'Cancel (best effort) vor dem neuen Start');
  // Aufraeumen: Hook und Zustand zurueck, env wieder leer fuer folgende Suites.
  flLogin.__setFetchImpl(null);
  flLogin.__resetLoginSession();
  delete process.env.FAMILYLINK_COLLECTOR_BASE;
  delete process.env.FAMILYLINK_LOGIN_SECRET;
});

// ════════════════════════════════════════════════════════════════════════════
// Auto-Login (POST /familylink/login) — der Collector fuellt den Google-Login
// selbst aus; der Fetch des Dienstes wird gemockt (Muster login-session oben).
// Contract: ok/otp_needed/bad_code/challenge als 200 {data:{state}}, bad_password
// und geschlossene pending als 422, Collector tot 502, env fehlt 503.
// ════════════════════════════════════════════════════════════════════════════

const AUTO_SECRET = 'auto-login-secret';
const PW = 'Geheim!Niemals-in-einer-Antwort';

function autoEnv(on = true) {
  if (on) {
    process.env.FAMILYLINK_COLLECTOR_BASE = 'http://collector.invalid:9334';
    process.env.FAMILYLINK_LOGIN_SECRET = AUTO_SECRET;
  } else {
    delete process.env.FAMILYLINK_COLLECTOR_BASE;
    delete process.env.FAMILYLINK_LOGIN_SECRET;
  }
}
/** Mockt den Collector: autoResult je Aufruf, startOk fuer den Viewer-Pfad. */
function mockCollector(...autoResults) {
  const calls = [];
  flLogin.__setFetchImpl(async (url, opts) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null, auth: opts?.headers?.authorization });
    if (url.endsWith('/login/start') || url.endsWith('/login/cancel')) return { ok: true, status: 200 };
    const r = autoResults.length ? autoResults.shift() : 'ok';
    if (r === 'throw') throw new Error('ECONNREFUSED');
    if (r === 'notok') return { ok: false, status: 500 };
    return { ok: true, status: 200, json: async () => ({ result: r }) };
  });
  return calls;
}
function assertNoSecrets(body, password) {
  const text = JSON.stringify(body) ?? '';
  if (password) assert.ok(!text.includes(password), 'das Passwort erscheint in keiner Antwort');
  assert.ok(!text.includes(AUTO_SECRET), 'das Collector-Geheimnis verlaesst den Server nie');
}

test('POST /familylink/login - env fehlt: 503 familylink_not_configured (vor jedem Collector-Ruf)', async () => {
  autoEnv(false);
  const calls = mockCollector('ok');
  const res = await call('POST', '/familylink/login', { actor: DAD, body: { email: 'mutti@example.org', password: PW } });
  assert.equal(res.status, 503);
  assert.equal(res.body.reason, 'media_time_familylink_not_configured');
  assert.equal(calls.length, 0, 'ohne Konfiguration fallt die Absage vor dem Collector-Ruf');
});

test('POST /familylink/login - Formfehler: 400 ohne Collector-Ruf (weder/noch, code mit email)', async () => {
  autoEnv();
  const calls = mockCollector('ok');
  const empty = await call('POST', '/familylink/login', { body: {} });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.reason, 'media_time_bad_request');
  const onlyEmail = await call('POST', '/familylink/login', { body: { email: 'mutti@example.org' } });
  assert.equal(onlyEmail.status, 400);
  const mixed = await call('POST', '/familylink/login', { body: { email: 'mutti@example.org', password: PW, code: '123456' } });
  assert.equal(mixed.status, 400);
  const badCode = await call('POST', '/familylink/login', { body: { code: 'zu lang!!' } });
  assert.equal(badCode.status, 400);
  assert.equal(calls.length, 0);
});

test('POST /familylink/login - Kind ohne Elternrolle: 403 vor dem Collector-Ruf', async () => {
  const calls = mockCollector('ok');
  const res = await call('POST', '/familylink/login', { actor: kidB, body: { email: 'mutti@example.org', password: PW } });
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, 'media_time_forbidden');
  assert.equal(calls.length, 0);
});

test('POST /familylink/login - Erfolg: state ok, familylink_email bleibt, das Passwort nirgends', async () => {
  const calls = mockCollector('ok');
  const res = await call('POST', '/familylink/login', { actor: DAD, body: { email: 'FamilienVerwalter@Example.ORG', password: PW } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data, { state: 'ok' });
  assertNoSecrets(res.body, PW);
  assert.equal(calls[0].url, 'http://collector.invalid:9334/login/auto');
  assert.equal(calls[0].auth, `Bearer ${AUTO_SECRET}`);
  // Der Collector braucht beides — durchgereicht, gespeichert wird nur die Adresse.
  assert.equal(calls[0].body.password, PW, 'zum Collector geht das Passwort durch');
  assert.equal(statusRow(), 'ok', 'ein Erfolg setzt den lokalen Status zurueck');
  const settings = await call('GET', '/settings');
  assert.equal(settings.body.data.familylink_email, 'FamilienVerwalter@Example.ORG');
});

test('POST /familylink/login - otp_needed: 200 {state:otp_needed}, pending bleibt offen', async () => {
  const calls = mockCollector('otp_needed');
  const res = await call('POST', '/familylink/login', { actor: DAD, body: { email: 'mutti@example.org', password: PW } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { state: 'otp_needed' });
  assertNoSecrets(res.body, PW);
  assert.equal(statusRow(), 'ok', 'ein offenes OTP ist noch kein neuer Status');
});

test('POST /familylink/login - code-Pfad: bad_code erlaubt erneut, dann ok (email bleibt vorgemerkt)', async () => {
  const calls = mockCollector('bad_code', 'ok');
  const first = await call('POST', '/familylink/login', { actor: DAD, body: { code: '111222' } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.data, { state: 'bad_code' });
  const second = await call('POST', '/familylink/login', { actor: DAD, body: { code: '111222' } });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.data, { state: 'ok' });
  assert.equal(calls[0].body.code, '111222');
  assert.ok(!('email' in calls[0].body) && !('password' in calls[0].body));
  const settings = await call('GET', '/settings');
  assert.equal(settings.body.data.familylink_email, 'FamilienVerwalter@Example.ORG',
    'ein Code-Erfolg ueberschreibt die vorgemerkte Adresse nicht');
});

test('POST /familylink/login - challenge: 200 mit viewer_url und expires_at (Viewer-Pfad wiederverwendet)', async () => {
  flLogin.__resetLoginSession();
  mockCollector('challenge');
  const res = await call('POST', '/familylink/login', { actor: DAD, body: { email: 'mutti@example.org', password: PW } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.state, 'challenge');
  assert.match(res.body.data.viewer_url, /^http:\/\/collector\.invalid:9334\/login\/view\?t=[0-9a-f]{64}$/);
  assert.match(String(res.body.data.expires_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assertNoSecrets(res.body, PW);
});

test('POST /familylink/login - bad_password: 422 reason bad_credentials (Antwort ohne Passwort)', async () => {
  mockCollector('bad_password');
  const res = await call('POST', '/familylink/login', { body: { email: 'mutti@example.org', password: PW } });
  assert.equal(res.status, 422);
  assert.equal(res.body.reason, 'media_time_familylink_bad_credentials');
  assertNoSecrets(res.body, PW);
});

test('POST /familylink/login - keine pending (code nach Ablauf): 422 login_expired', async () => {
  mockCollector('no_pending');
  const res = await call('POST', '/familylink/login', { body: { code: '654321' } });
  assert.equal(res.status, 422);
  assert.equal(res.body.reason, 'media_time_familylink_login_expired');
});

test('POST /familylink/login - Collector tot: 502 (Wurf wie Nicht-2xx)', async () => {
  mockCollector('throw');
  const thrown = await call('POST', '/familylink/login', { body: { code: '654321' } });
  assert.equal(thrown.status, 502);
  assert.equal(thrown.body.reason, 'media_time_familylink_collector_unreachable');
  mockCollector('notok');
  const notok = await call('POST', '/familylink/login', { body: { code: '654321' } });
  assert.equal(notok.status, 502);
  assert.equal(notok.body.reason, 'media_time_familylink_collector_unreachable');
});

test('notifyFamilylinkLoginNeeded - Eltern/Admins erhalten die deutsche Meldung, Kinder nicht', async () => {
  const sent = [];
  const r = await flSvc.notifyFamilylinkLoginNeeded(db, {
    push: async (userId, payload) => { sent.push({ userId, payload }); return 1; },
    channelStore: { listEnabledChannelsForUser: () => [] },
  });
  assert.ok(r.recipients >= 2, 'Admin und Eltern sind Empfaenger');
  const ids = new Set(sent.map((s) => s.userId));
  assert.ok(ids.has(ADMIN.id), 'der Admin erhaelt die Meldung');
  assert.ok(ids.has(DAD.id), 'der Vater erhaelt die Meldung');
  assert.ok(!ids.has(kidA.id) && !ids.has(kidB.id), 'Kinder koennen nichts anmelden — keine Meldung');
  for (const s of sent) {
    assert.equal(s.payload.title, 'Family-Link-Verbindung abgelaufen');
    assert.equal(s.payload.body, 'Bitte in den Medienzeit-Regeln erneut anmelden.');
    assert.equal(s.payload.url, '/media-time');
  }
});

test('POST /familylink/report - Wechsel ok -> login_noetig (Route nimmt an; Statuspfad wie bisher)', async () => {
  // Der Melde-Haenger ist fire-and-forget; geprueft wird hier die Annahme der
  // Route (der Versand selbst im Service-Test oben).
  const token = await freshReportToken();
  setStatusOk();
  const res = await postReport(token, { status: 'login_noetig' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.status, 'login_noetig');
});
function setStatusOk() {
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('familylink_status', 'ok')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run();
}

// ════════════════════════════════════════════════════════════════════════════
// GET /familylink/usage?kind=apps (A2, App-Liste des Tages)
// ════════════════════════════════════════════════════════════════════════════

test('GET /familylink/usage?kind=apps - Eltern sehen die Liste, Kind nicht (403), Tag-Format 400', async () => {
  db.prepare(`
    INSERT INTO familylink_children (google_uid, yuvomi_user_id, display_name, enabled)
    VALUES (?, ?, NULL, 1)
    ON CONFLICT(google_uid) DO UPDATE SET yuvomi_user_id = excluded.yuvomi_user_id
  `).run(UID, kidA.id);
  db.prepare(`
    INSERT INTO familylink_app_usage (day, google_uid, pkg, name, minutes, fetched_at) VALUES
      ('2026-11-06', ?, 'com.small', 'Small', 4, '2026-11-06T10:00:00Z'),
      ('2026-11-06', ?, 'com.big', 'Big', 90, '2026-11-06T10:00:00Z')
  `).run(UID, UID);
  const ok = await call('GET', '/familylink/usage?kind=apps&day=2026-11-06', { actor: DAD });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.day, '2026-11-06');
  assert.deepEqual(ok.body.data.items.map((i) => i.pkg), ['com.big', 'com.small'], 'minutes DESC');
  assert.equal(ok.body.data.items[0].yuvomi_user_id, kidA.id);
  assert.equal(ok.body.data.items[0].google_uid, UID);
  const denied = await call('GET', '/familylink/usage?kind=apps', { actor: kidB });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.reason, 'media_time_forbidden');
  const badDay = await call('GET', '/familylink/usage?kind=apps&day=06.11.', { actor: DAD });
  assert.equal(badDay.status, 400);
  assert.equal(badDay.body.reason, 'media_time_bad_request');
  const today = await call('GET', '/familylink/usage?kind=apps', { actor: DAD });
  assert.equal(today.status, 200);
  assert.match(today.body.data.day, /^\d{4}-\d{2}-\d{2}$/, 'ohne Tag: das heutige Datum');
  // Die Bestandsform (Gerate-Aggregat) bleibt unverandert erreichbar:
  const legacy = await call('GET', `/familylink/usage?user_id=${kidA.id}`, { actor: DAD });
  assert.equal(legacy.status, 200);
  assert.ok('devices' in legacy.body.data, 'usage ohne kind liefert wie bisher das Geraete-Bild');
});

// Aufraeumen fuer folgende Suites (Muster oben).
flLogin.__setFetchImpl(null);
flLogin.__resetLoginSession();
autoEnv(false);
