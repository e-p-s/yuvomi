/**
 * Test: Medienzeit-Routen-Schicht (server/routes/media-time.js)
 * Zweck: End-to-End ueber den echten Router - die Suite test/test-media-time.js
 *        prueft die Service-Schicht, diese hier die HTTP-Handler: Geraet
 *        anlegen (POST /devices, Token einmalig), tracker/sync mit Sessions
 *        (idempotent ueber session_key - ein doppelter Sync zaehlt nicht
 *        doppelt), die /today-Felder (charged/exempt/unknown, quota,
 *        tracker.last_seen_at/online, state ok/exceeded/quiet), exceptions
 *        PUT + exempt-Rechnung, Punktetausch (Punkte -> Minuten,
 *        insufficient_points), Ruhezeit-Fenster und requireManager (403 member).
 * Muster: test/test-rewards-routes.js - express-App, fetch, injizierter actor.
 * Ausfuehren: node --experimental-sqlite --test test/test-media-time-routes.js
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

// ── Nutzer (IDs deterministisch ab 1: eigener Prozess je Testdatei) ──────────────
const ADMIN = { id: 1, role: 'admin' };
const DAD = { id: 2, role: 'member' };   // family_role parent - kein Admin, aber Elternteil
const KID_A = { id: 3, role: 'member' };
db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('admin','Admin','x','admin','parent')").run();
db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('dad','Dad','x','member','parent')").run();
db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('kinda','Kind A','x','member','child')").run();

function cfgSet(key, value) {
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
cfgSet('media_time_enabled', '1');

function isoAgo(minutes) {
  return new Date(Date.now() - minutes * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
/** Die Wandzeit der Haushaltszone als Fenster um JETZT (Sekundenpuffer gegen
 *  den Tagwechsel) - dasselbe Muster wie test-media-time.js, echte Uhrzeit
 *  nur fuer die Fenster, nie fuer Behauptungen ueber Zustande. */
function wallNow() {
  return svc.householdWallTime(db);
}
function windowAround(minutes = 5) {
  const [h, m] = wallNow().split(':').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  // Taguebergreifend konstruieren (23:58 => 23:53-00:03), damit die Stunde
  // nicht am Minutenpuffer zerschellt ('Invalid time value' um 23:59).
  const total = Math.max(0, h * 60 + m - minutes);
  const totalEnd = Math.min(24 * 60 - 1, h * 60 + m + minutes);
  return `${pad(Math.floor(total / 60)) % 24}:${pad(total % 60)}-${pad(Math.floor(totalEnd / 60) % 24)}:${pad(totalEnd % 60)}`;
}
function windowOutside(minutes = 5) {
  const [h, m] = wallNow().split(':').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const shift = (h * 60 + m + 12 * 60) % (24 * 60);
  const end = (shift + minutes) % (24 * 60);
  return `${pad(Math.floor(shift / 60))}:${pad(shift % 60)}-${pad(Math.floor(end / 60))}:${pad(end % 60)}`;
}

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

async function call(method, route, { actor: a = ADMIN, body, token } = {}) {
  actor = a;
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  let json = null;
  if (ct.includes('application/json')) { try { json = await res.json(); } catch { /* leer */ } }
  return { status: res.status, body: json };
}

/** Frisches Kind mit Geraet und definiertem Punkte-Saldo. */
let kidSeq = 0;
function freshKid(startPoints = 0) {
  const name = `MtKid-${++kidSeq}`;
  const id = db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', 'member', 'child')")
    .run(name.toLowerCase(), name).lastInsertRowid;
  if (startPoints) {
    db.prepare("INSERT INTO reward_ledger (user_id, delta, type, reason, created_by, unit) VALUES (?, ?, 'bonus', 'seed', ?, 'points')")
      .run(id, startPoints, ADMIN.id);
  }
  return { id, role: 'member' };
}
async function mkDevice(childId, name = 'Phone') {
  const res = await call('POST', '/devices', { body: { user_id: childId, name } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.data.id, token: res.body.data.token };
}
/** Session-Objekt fuer tracker/sync (foreground_ms -> Minuten). */
function session(key, pkg, minutes, extra = {}) {
  return { session_key: key, package: pkg, started_at: isoAgo(minutes), foreground_ms: minutes * 60000, ...extra };
}

// ════════════════════════════════════════════════════════════════════════════
// Geraete anlegen und Geräte-Token
// ════════════════════════════════════════════════════════════════════════════

test('POST /devices — Token nur einmal; Sync ohne/falsches Token => 401 device_required', async () => {
  const kid = freshKid();
  const dev = await mkDevice(kid.id);
  assert.match(dev.token, /^mt_/, 'der Klartext traegt das Praefix und steht nur in dieser Antwort');
  const row = db.prepare('SELECT device_token_hash FROM media_time_devices WHERE id = ?').get(dev.id);
  assert.ok(!row.device_token_hash.includes(dev.token), 'in der Zeile steht nur der Hash');
  const noToken = await call('POST', '/tracker/sync', { body: { sessions: [] } });
  assert.equal(noToken.status, 401);
  assert.equal(noToken.body.reason, 'media_time_device_required');
  const badToken = await call('POST', '/tracker/sync', { body: { sessions: [] }, token: 'mt_falsch' });
  assert.equal(badToken.status, 401);
  assert.equal(badToken.body.reason, 'media_time_device_required');
  const member = await call('POST', '/devices', { actor: { id: kid.id, role: 'member' }, body: { user_id: kid.id, name: 'X' } });
  assert.equal(member.status, 403, 'ein Nicht-Elter legt kein Geraet an');
  assert.equal(member.body.reason, 'media_time_forbidden');
});

test('POST /tracker/sync — Gerate-Token scope: fremdes Token kann keinem anderen Kind unterschieben', async () => {
  const kidA = freshKid();
  const kidB = freshKid();
  const dev = await mkDevice(kidA.id);
  const res = await call('POST', '/tracker/sync', {
    actor: { id: kidB.id, role: 'member' },
    token: dev.token,
    body: { sessions: [session('sc-1', 'com.a.app', 10)] },
  });
  assert.equal(res.status, 200);
  // Der actor ist Kid B - das Gerat haelt sich an Kid A (die Gerate-Zeile
  // entscheidet, wessen Kontingent gilt).
  const usedA = db.prepare("SELECT COALESCE(SUM(used_minutes),0) AS m FROM media_time_sessions WHERE user_id = ?").get(kidA.id).m;
  const usedB = db.prepare("SELECT COALESCE(SUM(used_minutes),0) AS m FROM media_time_sessions WHERE user_id = ?").get(kidB.id).m;
  assert.equal(usedA, 10, 'die Session liegt beim Geraet-Kind');
  assert.equal(usedB, 0, 'der eingeloggte Fremde bekommt nichts unterschoben');
});

test('tracker/sync — Idempotenz ueber session_key: doppelter Sync zaehlt nicht doppelt', async () => {
  const kid = freshKid();
  const dev = await mkDevice(kid.id);
  const body = { sessions: [session('id-1', 'com.idem.app', 20)] };
  const first = await call('POST', '/tracker/sync', { token: dev.token, body });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.accepted, 1);
  const second = await call('POST', '/tracker/sync', { token: dev.token, body });
  assert.equal(second.status, 200);
  assert.equal(second.body.data.accepted, 1, 'Nachmeldung ist kein Fehler');
  const rows = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(used_minutes),0) AS m FROM media_time_sessions WHERE user_id = ?").get(kid.id);
  assert.equal(rows.n, 1, 'es bleibt EINE Zeile');
  assert.equal(rows.m, 20, 'der Stand zaehlt nicht doppelt');
  // Hoherer Stand gewinnt (Heartbeat-Update), nicht die Summe.
  const third = await call('POST', '/tracker/sync', {
    token: dev.token, body: { sessions: [session('id-1', 'com.idem.app', 25)] },
  });
  assert.equal(third.status, 200);
  const after = db.prepare("SELECT used_minutes AS m FROM media_time_sessions WHERE user_id = ?").get(kid.id).m;
  assert.equal(after, 25);
});

test('tracker/sync — unbekannte Pakete bleiben unknown (fail-open), yuvomi-Paket hart exempt', async () => {
  const kid = freshKid();
  const dev = await mkDevice(kid.id);
  const res = await call('POST', '/tracker/sync', {
    token: dev.token,
    body: {
      sessions: [
        session('cls-1', 'com.unbekannt.app', 15),
        session('cls-2', svc.YUVOMI_PACKAGE, 5),
        session('cls-3', null, 3),
      ],
    },
  });
  assert.equal(res.status, 200);
  const today = await call('GET', `/today?user_id=${kid.id}`);
  assert.equal(today.status, 200);
  assert.equal(today.body.data.unknown_min, 18, 'unbekannt + paketlos: sichtbar, nie still abgezogen');
  assert.equal(today.body.data.exempt_min, 5, 'das Yuvomi-Paket ist hart ausgenommen');
  assert.equal(today.body.data.charged_min, 0, 'ohne Regel zieht nichts ab');
});

// ════════════════════════════════════════════════════════════════════════════
// exceptions PUT + exempt-Rechnung
// ════════════════════════════════════════════════════════════════════════════

test('PUT /tracker/exceptions — exempt-Rechnung wandert, Rohwerte bleiben', async () => {
  const kid = freshKid();
  const dev = await mkDevice(kid.id);
  await call('POST', '/tracker/sync', { token: dev.token, body: { sessions: [session('ex-1', 'com.exempt.app', 30)] } });
  const before = await call('GET', `/today?user_id=${kid.id}`);
  assert.equal(before.body.data.unknown_min, 30);
  const put = await call('PUT', '/tracker/exceptions', {
    body: { upsert: [{ user_id: kid.id, match_type: 'exact', pattern: 'com.exempt.app', exempt_from: 'quota' }] },
  });
  assert.equal(put.status, 200);
  assert.ok(put.body.data.version > 0, 'die Version steigt fuer den Klienten-Cache');
  const after = await call('GET', `/today?user_id=${kid.id}`);
  assert.equal(after.body.data.exempt_min, 30, 'die Neueklassifikation rechnet die Zeile um');
  assert.equal(after.body.data.unknown_min, 0);
  const raw = db.prepare("SELECT used_minutes, started_at FROM media_time_sessions WHERE user_id = ?").get(kid.id);
  assert.equal(raw.used_minutes, 30, 'der Rohwert bleibt, wie gemeldet');
  // Ruecknahme wandert zurueck auf unknown (fail-open).
  const ruleId = db.prepare('SELECT id FROM media_time_app_exceptions WHERE pattern = ?').get('com.exempt.app').id;
  await call('PUT', '/tracker/exceptions', { body: { revoke: [ruleId] } });
  const revoked = await call('GET', `/today?user_id=${kid.id}`);
  assert.equal(revoked.body.data.unknown_min, 30, 'zurueckgenommene Regel => wieder unknown');
});

test('PUT /tracker/exceptions — requireManager: member 403, Elternpfad erlaubt; Nicht-Kind => 403', async () => {
  const kid = freshKid();
  const member = await call('PUT', '/tracker/exceptions', {
    actor: { id: kid.id, role: 'member' },
    body: { upsert: [{ user_id: kid.id, match_type: 'exact', pattern: 'com.x', exempt_from: 'quota' }] },
  });
  assert.equal(member.status, 403);
  assert.equal(member.body.reason, 'media_time_forbidden');
  const grown = db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('gross','Gross','x','member','dad')").run().lastInsertRowid;
  const notChild = await call('PUT', '/tracker/exceptions', {
    body: { upsert: [{ user_id: grown, match_type: 'exact', pattern: 'com.x', exempt_from: 'quota' }] },
  });
  assert.equal(notChild.status, 403);
  assert.equal(notChild.body.reason, 'media_time_not_a_child');
});

// ════════════════════════════════════════════════════════════════════════════
// /today Antwortfelder
// ════════════════════════════════════════════════════════════════════════════

test('GET /today — charged/exempt/unknown, quota, tracker online/last_seen', async () => {
  const kid = freshKid();
  await call('PUT', `/quotas/${kid.id}`, { body: { daily_minutes: 60 } });
  const dev = await mkDevice(kid.id);
  await call('POST', '/tracker/sync', {
    token: dev.token,
    body: {
      sessions: [session('td-1', 'com.game.a', 25), session('td-2', 'com.unbekannt.b', 10)],
      inventory_delta: [{ package: 'com.game.a', version_name: '1.2' }],
    },
  });
  // Regel: com.game.a ist abziehbar (Eltern-Bestaetigung 'Ja, abziehen').
  await call('PUT', '/tracker/exceptions', {
    body: { upsert: [{ user_id: kid.id, match_type: 'exact', pattern: 'com.game.a', exempt_from: 'charged' }] },
  });
  const res = await call('GET', `/today?user_id=${kid.id}`);
  assert.equal(res.status, 200);
  const d = res.body.data;
  assert.equal(d.charged_min, 25);
  assert.equal(d.unknown_min, 10);
  assert.equal(d.exempt_min, 0);
  assert.equal(d.quota_min, 60);
  assert.equal(d.remaining_min, 35);
  assert.equal(d.state, 'ok');
  assert.equal(d.tracker.online, true, 'frischer Sync => online');
  assert.ok(d.tracker.last_seen_at, 'der letzte Kontakt ist lesbar');
  const inv = await call('GET', `/devices/${dev.id}/inventory`);
  assert.equal(inv.body.data.items[0].package_name, 'com.game.a', 'das Paket-Inventar wandert mit');
});

test('GET /today — exceeded: quota_min ueberschritten', async () => {
  const kid = freshKid();
  await call('PUT', `/quotas/${kid.id}`, { body: { daily_minutes: 10 } });
  const dev = await mkDevice(kid.id);
  await call('PUT', '/tracker/exceptions', {
    body: { upsert: [{ user_id: kid.id, match_type: 'exact', pattern: 'com.ueber.app', exempt_from: 'charged' }] },
  });
  await call('POST', '/tracker/sync', { token: dev.token, body: { sessions: [session('exd-1', 'com.ueber.app', 40)] } });
  const res = await call('GET', `/today?user_id=${kid.id}`);
  assert.equal(res.body.data.state, 'exceeded');
  assert.equal(res.body.data.remaining_min, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// Punktetausch (Punkte -> Minuten)
// ════════════════════════════════════════════════════════════════════════════

test('POST /purchase — Punkte -> Minuten; credit erhoht das Kontingent des Tages', async () => {
  const kid = freshKid(100);
  await call('PUT', `/quotas/${kid.id}`, { body: { daily_minutes: 30 } });
  await call('PUT', '/settings', { body: { exchange: { points: 10, minutes: 15 } } });
  const res = await call('POST', '/purchase', { actor: { id: kid.id, role: 'member' }, body: { user_id: kid.id, quantity: 1 } });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.minutes, 15);
  assert.equal(res.body.data.points_spent, 10);
  assert.equal(res.body.data.quota.quota_min, 45, '30 Basis + 15 gekauft');
  const bal = db.prepare("SELECT COALESCE(SUM(delta),0) AS b FROM reward_ledger WHERE user_id = ? AND unit = 'points'").get(kid.id).b;
  assert.equal(bal, 90, 'die Punkte sind ueber das Ledger abgebucht');
  const purchases = await call('GET', `/purchases?user_id=${kid.id}`);
  assert.equal(purchases.body.data.items.length, 1, 'der Kauf steht als eigene Historienzeile');
});

test('POST /purchase — insufficient_points: 400 mit reason; exchange_off: 400', async () => {
  const kid = freshKid(5);
  await call('PUT', `/quotas/${kid.id}`, { body: { daily_minutes: 30 } });
  await call('PUT', '/settings', { body: { exchange: { points: 10, minutes: 15 } } });
  const poor = await call('POST', '/purchase', { actor: { id: kid.id, role: 'member' }, body: { user_id: kid.id } });
  assert.equal(poor.status, 400);
  assert.equal(poor.body.reason, 'media_time_insufficient_points');
  const bal = db.prepare("SELECT COALESCE(SUM(delta),0) AS b FROM reward_ledger WHERE user_id = ? AND unit = 'points'").get(kid.id).b;
  assert.equal(bal, 5, 'bei Absage bleibt der Saldo unangetastet');
  await call('PUT', '/settings', { body: { exchange: null } });
  const off = await call('POST', '/purchase', { actor: { id: kid.id, role: 'member' }, body: { user_id: kid.id } });
  assert.equal(off.status, 400);
  assert.equal(off.body.reason, 'media_time_exchange_off');
});

test('POST /purchase — ohne Kontingent => 400 no_quota; harter Cap => 400 cap_reached', async () => {
  const kid = freshKid(100);
  await call('PUT', '/settings', { body: { exchange: { points: 10, minutes: 15 } } });
  const noQuota = await call('POST', '/purchase', { actor: { id: kid.id, role: 'member' }, body: { user_id: kid.id } });
  assert.equal(noQuota.status, 400);
  assert.equal(noQuota.body.reason, 'media_time_no_quota');
  await call('PUT', `/quotas/${kid.id}`, { body: { daily_minutes: 30, max_daily_minutes: 40 } });
  const capped = await call('POST', '/purchase', { actor: { id: kid.id, role: 'member' }, body: { user_id: kid.id, quantity: 2 } });
  assert.equal(capped.status, 400);
  assert.equal(capped.body.reason, 'media_time_cap_reached', 'hartes Cap (Default) ist Endstation');
});

// ════════════════════════════════════════════════════════════════════════════
// Ruhezeit (globale Haushalt-Ruhezeit, Signal)
// ════════════════════════════════════════════════════════════════════════════

test('PUT /quiet-hours — range validiert; /today und GET /quiet-hours zeigen state quiet', async () => {
  const bad = await call('PUT', '/quiet-hours', { body: { range: '25:00-06:00' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.reason, 'media_time_bad_request');
  const bad2 = await call('PUT', '/quiet-hours', { body: { range: 'abends' } });
  assert.equal(bad2.status, 400);
  const window = windowAround(5);
  const put = await call('PUT', '/quiet-hours', { body: { range: window } });
  assert.equal(put.status, 200);
  assert.equal(put.body.data.range, window);
  const g = await call('GET', '/quiet-hours');
  assert.equal(g.body.data.enabled, true);
  assert.equal(g.body.data.active_now, true);
  const kid = freshKid();
  await call('PUT', `/quotas/${kid.id}`, { body: { daily_minutes: 60 } });
  const today = await call('GET', `/today?user_id=${kid.id}`);
  assert.equal(today.body.data.state, 'quiet', 'innerhalb des Fensters zeigt /today quiet');
  assert.equal(today.body.data.quiet_active, true);
  // Ausserhalb des Fensters ist dasselbe Kind nicht ruhig.
  await call('PUT', '/quiet-hours', { body: { range: windowOutside(5) } });
  const outside = await call('GET', `/today?user_id=${kid.id}`);
  assert.equal(outside.body.data.state, 'ok');
  await call('PUT', '/quiet-hours', { body: { range: null } });
  const off = await call('GET', '/quiet-hours');
  assert.equal(off.body.data.enabled, false);
});

// ════════════════════════════════════════════════════════════════════════════
// requireManager und Haushaltsschalter
// ════════════════════════════════════════════════════════════════════════════

test('requireManager — PUT /quotas/* ist Eltern/Admin; Kind => 403 media_time_forbidden', async () => {
  const kid = freshKid();
  const asKid = await call('PUT', `/quotas/${kid.id}`, { actor: { id: kid.id, role: 'member' }, body: { daily_minutes: 30 } });
  assert.equal(asKid.status, 403);
  assert.equal(asKid.body.reason, 'media_time_forbidden');
  const asDad = await call('PUT', `/quotas/${kid.id}`, { actor: DAD, body: { daily_minutes: 30 } });
  assert.equal(asDad.status, 200, 'ein Elternteil ohne Admin darf das Kontingent seines Kindes setzen');
});

test('Haushaltsschalter aus — tracker/sync => 403 media_time_disabled; PUT /preferences-Stil bleibt unberuehrt', async () => {
  const kid = freshKid();
  const dev = await mkDevice(kid.id);
  cfgSet('media_time_enabled', '0');
  try {
    const res = await call('POST', '/tracker/sync', { token: dev.token, body: { sessions: [session('off-1', 'com.off.app', 5)] } });
    assert.equal(res.status, 403);
    assert.equal(res.body.reason, 'media_time_disabled');
  } finally {
    cfgSet('media_time_enabled', '1');
  }
  const back = await call('POST', '/tracker/sync', { token: dev.token, body: { sessions: [session('off-1', 'com.off.app', 5)] } });
  assert.equal(back.status, 200, 'wieder an, nimmt der Sync die Session an');
});
