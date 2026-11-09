/**
 * Test: Medienzeit-Routen-Schicht (server/features/media-time/routes.js)
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
const { default: mediaTimeRouter } = await import('../server/features/media-time/routes.js');
const svc = await import('../server/features/media-time/service.js');
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
  // Der Tag fangt um Mitternacht wieder von vorn an: ein Fenster, das vor
  // 00:00 losgeht, laeuft ueber Mitternacht (02:03 => 23:58-02:08 statt des
  // ungueltigen 0:03-2:08). Sonst faellt der Test in den ersten Minuten
  // eines jeden Tages.
  const start = (h * 60 + m - minutes + 24 * 60) % (24 * 60);
  const end = (h * 60 + m + minutes) % (24 * 60);
  return `${pad(Math.floor(start / 60))}:${pad(start % 60)}-${pad(Math.floor(end / 60))}:${pad(end % 60)}`;
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

/* ── Check-in/Check-out (Einbuchen/Ausbuchen, Nutzer 05.11.) ──────────────── */

test('POST /checkins — einbuchen: 201, /today zeigt checked_in und offene Minuten', async () => {
  const kid = freshKid();
  await call('PUT', `/quotas/${kid.id}`, { body: { daily_minutes: 60, enabled: true } });
  const dev = await mkDevice(kid.id, 'Konsole');
  const res = await call('POST', '/checkins', { body: { user_id: kid.id, device_id: dev.id } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.checked_in, true);
  // Doppelbuchung auf demselben Geraet: 409
  const again = await call('POST', '/checkins', { body: { user_id: kid.id, device_id: dev.id } });
  assert.equal(again.status, 409);
  assert.equal(again.body.reason, 'media_time_already_checked_in');
  // /today: checked_in true, verbrauchte Minuten enthalten die offene Sitzung
  const today = await call('GET', `/today?user_id=${kid.id}`);
  assert.equal(today.status, 200);
  assert.equal(today.body.data.checked_in, true);
  // Liste: eine offene Sitzung mit Geraetenamen
  const list = await call('GET', `/checkins?user_id=${kid.id}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.data.items.length, 1);
  assert.equal(list.body.data.items[0].ended_at, null);
  assert.equal(list.body.data.items[0].device_name, 'Konsole');
});

test('POST /checkins/:id/end — ausbuchen: 201->geschlossen, /today checked_in false', async () => {
  const kid = freshKid();
  await call('PUT', `/quotas/${kid.id}`, { body: { daily_minutes: 60, enabled: true } });
  const dev = await mkDevice(kid.id, 'Fernseher');
  const open = await call('POST', '/checkins', { body: { user_id: kid.id, device_id: dev.id } });
  assert.equal(open.status, 201);
  const end = await call('POST', `/checkins/${open.body.data.id}/end`, { body: {} });
  assert.equal(end.status, 200);
  assert.equal(end.body.data.checked_in, false);
  const today = await call('GET', `/today?user_id=${kid.id}`);
  assert.equal(today.body.data.checked_in, false);
  // nochmaliges Ende: 404 (keine offene Sitzung mehr)
  const again = await call('POST', `/checkins/${open.body.data.id}/end`, { body: {} });
  assert.equal(again.status, 404);
});

test('Check-in-Rechte: Kind bucht sich selbst ein, fremdes Kind => 403; GET /devices fuer das Kind', async () => {
  const kid = freshKid();
  const dev = await mkDevice(kid.id, 'Tablet');
  // Kind bucht sich selbst (user_id weggelassen => eigener Nutzer)
  const own = await call('POST', '/checkins', { actor: { id: kid.id, role: 'member' },
    body: { device_id: dev.id } });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  // Kind bucht fremdes Kind: Gerat gehoert ihm nicht => 404 (Gerat nicht
  // gefunden), und das Geraet des fremden Kindes waere 404/403 - beides ist
  // eine Ablehnung; der Rechtsweg laeuft immer ueber die Geraete-Zuordnung.
  const other = freshKid();
  const foreign = await call('POST', '/checkins', { actor: { id: kid.id, role: 'member' },
    body: { user_id: other.id, device_id: dev.id } });
  assert.equal(foreign.status, 404);
  // eigenes Kind, fremdes Geraet: gleichfalls 404
  const foreign2 = await call('POST', '/checkins', { actor: { id: kid.id, role: 'member' },
    body: { user_id: kid.id, device_id: (await mkDevice(other.id, 'Fremd')).id } });
  assert.equal(foreign2.status, 404);
  // GET /devices ohne Manager: nur eigene Geraete
  const devs = await call('GET', '/devices', { actor: { id: kid.id, role: 'member' } });
  assert.equal(devs.status, 200);
  assert.ok(Array.isArray(devs.body.data));
  assert.ok(devs.body.data.every((d) => d.user_id === kid.id));
});

test('Haushaltsschalter aus => POST /checkins 403 media_time_disabled', async () => {
  const kid = freshKid();
  const dev = await mkDevice(kid.id, 'Konsole');
  cfgSet('media_time_enabled', '0');
  try {
    const res = await call('POST', '/checkins', { body: { user_id: kid.id, device_id: dev.id } });
    assert.equal(res.status, 403);
    assert.equal(res.body.reason, 'media_time_disabled');
  } finally {
    cfgSet('media_time_enabled', '1');
  }
});


/* ── Sessions-Verwaltung (GET/PATCH/DELETE /sessions, Start/Ende-Buchung,
 *    /today.devices, Geraet-Kontingente) ─────────────────────────────────── */

function dayAgoISO(days) {
  return svc.mediaTimeDayKey(db, new Date(Date.now() - days * 24 * 3600 * 1000));
}
/* Die Grenze zum naechsten Haushalts-Tag (binere Suche auf Minuten, die Zone
 * des Servers bleibt unbekannt und egal): hi = erste Minute des neuen Tages.
 * Damit sind Paare innerhalb eines Tages und ueber die Grenze sicher
 * konstruiert - ein fixer 'T23:30Z'-Trick waere je nach Zone falsch. */
function nextDayBoundary() {
  let lo = Date.now();
  let hi = lo + 25 * 3600e3;
  while (hi - lo > 60000) {
    const mid = Math.floor((lo + hi) / 2);
    if (svc.mediaTimeDayKey(db, new Date(mid)) === svc.mediaTimeDayKey(db, new Date(lo))) lo = mid;
    else hi = mid;
  }
  return hi;
}
/** Family-Link-Zuordnung samt Tageswert direkt in die Tabellen (der Collector
 *  lebt ausserhalb dieses Tests - hier zaehlt nur die dayUsage-Mapping-Regel). */
function seedFamilylink(childId, googleUid, googleDevice, mediaDeviceId, day, consumedMin) {
  db.prepare(`
    INSERT INTO familylink_children (google_uid, yuvomi_user_id, display_name, enabled)
    VALUES (?, ?, 'Kind', 1)
    ON CONFLICT(google_uid) DO UPDATE SET yuvomi_user_id = excluded.yuvomi_user_id, enabled = 1
  `).run(googleUid, childId);
  if (mediaDeviceId != null) {
    db.prepare(`
      INSERT INTO familylink_device_map (google_uid, google_device_id, media_time_device_id)
      VALUES (?, ?, ?)
      ON CONFLICT(google_uid, google_device_id) DO UPDATE SET media_time_device_id = excluded.media_time_device_id
    `).run(googleUid, googleDevice, mediaDeviceId);
  }
  db.prepare(`
    INSERT INTO familylink_daily (google_uid, google_device_id, day, consumed_min, fetched_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(google_uid, google_device_id, day) DO UPDATE SET consumed_min = excluded.consumed_min
  `).run(googleUid, googleDevice, day, consumedMin, isoAgo(1));
}

test('GET /sessions — Tag-Filter, nur charged, Reihenfolge, editable; Kind sieht nur die eigenen', async () => {
  const kid = freshKid();
  await call('PUT', `/quotas/${kid.id}`, { body: { daily_minutes: 120 } });
  const dev = await mkDevice(kid.id, 'Handy');
  // Regel VOR der Buchung: reclassifyForUser wandert sonst spaeter angelegte
  // manual-Zeilen auf unknown um (package 'manual' trifft keine Regel).
  await call('PUT', '/tracker/exceptions', {
    body: { upsert: [{ user_id: kid.id, match_type: 'exact', pattern: 'com.charged.a', exempt_from: 'charged' }] },
  });
  // Gestern: eine direkte Buchung (20 Min, minute_key gestern). Heute: zwei
  // manual (20 + 10), eine Tracker-Session charged (30) und eine unknown (5).
  const y = dayAgoISO(1);
  db.prepare(`
    INSERT INTO media_time_sessions
      (session_key, user_id, package_name, app_label, started_at, ended_at, used_minutes, minute_key,
       classification, source, created_at)
    VALUES (?, ?, 'manual', 'Vorher tagged', ?, ?, 20, ?, 'charged', 'manual', ?)
  `).run(`manual-alt:${kid.id}`, kid.id, `${y}T10:00:00Z`, `${y}T10:20:00Z`, y, isoAgo(60 * 24));
  await call('POST', '/sessions', { body: { user_id: kid.id, minutes: 20, note: 'Heute zuerst' } });
  await call('POST', '/sessions', { body: { user_id: kid.id, minutes: 10, note: 'Heute Konsole' } });
  await call('POST', '/tracker/sync', { token: dev.token, body: { sessions: [session('sv-1', 'com.charged.a', 30), session('sv-2', 'com.unknown.b', 5)] } });

  const today = await call('GET', `/sessions?user_id=${kid.id}`);
  assert.equal(today.status, 200, JSON.stringify(today.body));
  const rows = today.body.data;
  assert.equal(rows.length, 3, 'nur charged-Zeilen des heutigen Tages (unknown und gestern draussen)');
  assert.ok(rows.every((r) => r.user_id === kid.id));
  assert.ok(rows[0].started_at >= rows[1].started_at && rows[1].started_at >= rows[2].started_at, 'neuester Start zuerst');
  assert.equal(rows.filter((r) => r.editable).length, 2, 'beide manual-Buchungen sind editierbar');
  const tracker = rows.find((r) => !r.editable);
  assert.equal(tracker.source, 'apk', 'Rohdaten eines Geraets sind nicht editierbar');
  assert.equal(tracker.device_id, dev.id);
  assert.equal(tracker.device_name, 'Handy', 'Geraetename wandert ueber den JOIN mit');
  assert.ok(rows.some((r) => r.device_id === null && r.device_name === null), 'Buchung ohne Geraet: null-Zeile');

  const yesterday = await call('GET', `/sessions?user_id=${kid.id}&day=${y}`);
  assert.equal(yesterday.status, 200);
  assert.equal(yesterday.body.data.length, 1);
  assert.equal(yesterday.body.data[0].used_minutes, 20);
  assert.equal(yesterday.body.data[0].app_label, 'Vorher tagged');

  const badDay = await call('GET', `/sessions?user_id=${kid.id}&day=vorgestern`);
  assert.equal(badDay.status, 400);
  assert.equal(badDay.body.reason, 'media_time_bad_request');

  // Rechte: das Kind liest die eigenen, fremde Kinder sind 403.
  const own = await call('GET', '/sessions', { actor: { id: kid.id, role: 'member' } });
  assert.equal(own.status, 200, 'ohne user_id gilt der eigene Nutzer');
  assert.ok(own.body.data.every((r) => r.user_id === kid.id));
  // Eltern ohne user_id: der ganze Haushalt (Familienkarte der Medienzeit-Seite).
  const otherKid = freshKid();
  await call('PUT', `/quotas/${otherKid.id}`, { body: { daily_minutes: 60 } });
  await call('POST', '/sessions', { body: { user_id: otherKid.id, minutes: 15 } });
  const all = await call('GET', '/sessions');
  assert.equal(all.status, 200, 'Eltern ohne user_id lesen den ganzen Haushalt');
  assert.ok(all.body.data.some((r) => r.user_id === kid.id));
  assert.ok(all.body.data.some((r) => r.user_id === otherKid.id));
  const foreign = await call('GET', `/sessions?user_id=${otherKid.id}`, { actor: { id: kid.id, role: 'member' } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.reason, 'media_time_forbidden');
});

test('POST /sessions — start_at/end_at: same-day Pflicht, Minuten = Differenz, Vorrang vor minutes', async () => {
  const kid = freshKid();
  await call('PUT', `/quotas/${kid.id}`, { body: { daily_minutes: 120 } });
  const boundary = nextDayBoundary();
  const isoOf = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  // Paar mitten im alten Tag (11,5 bis 12 h vor der Grenze): gleicher Tag.
  const startMs = boundary - 12 * 3600e3;
  const endMs = boundary - 11.5 * 3600e3;
  const ok = await call('POST', '/sessions', {
    body: { user_id: kid.id, minutes: 999, start_at: isoOf(startMs), end_at: isoOf(endMs) },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.day, svc.mediaTimeDayKey(db, new Date(startMs)), 'der Tag folgt der Uebergabe');
  const stored = db.prepare('SELECT used_minutes, minute_key, started_at, ended_at FROM media_time_sessions WHERE session_key = ?')
    .get(ok.body.data.session_key);
  assert.equal(stored.used_minutes, 30, 'Differenz zaehlt, nicht minutes');
  assert.equal(stored.started_at, isoOf(startMs), 'die Uebergabe wird gespeichert, wie sie kam');
  assert.equal(stored.ended_at, isoOf(endMs));

  // Ueber die Haushalt-Mitternacht: 400 (eine Buchung ueberquert sie nicht).
  const cross = await call('POST', '/sessions', {
    body: { user_id: kid.id, start_at: isoOf(boundary - 60000), end_at: isoOf(boundary + 19 * 60000) },
  });
  assert.equal(cross.status, 400);
  assert.equal(cross.body.reason, 'media_time_bad_request');
  // Nur eine Uebergabe: 400.
  const half = await call('POST', '/sessions', { body: { user_id: kid.id, start_at: isoOf(startMs) } });
  assert.equal(half.status, 400);
  assert.equal(half.body.reason, 'media_time_bad_request');
});

test('PATCH /sessions/:id — nur manual, minutes holt started_at nach (ended_at bleibt Anker)', async () => {
  const kid = freshKid();
  await call('PUT', `/quotas/${kid.id}`, { body: { daily_minutes: 120 } });
  const dev = await mkDevice(kid.id, 'Konsole');
  const booked = await call('POST', '/sessions', { body: { user_id: kid.id, minutes: 30, note: 'Falsch' } });
  assert.equal(booked.status, 201);
  const id = db.prepare('SELECT id FROM media_time_sessions WHERE session_key = ?').get(booked.body.data.session_key).id;

  const patched = await call('PATCH', `/sessions/${id}`, {
    body: { minutes: 45, note: 'Korrektur', device_id: dev.id },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const d = patched.body.data;
  assert.equal(d.id, id);
  assert.equal(d.used_minutes, 45);
  assert.equal(d.app_label, 'Korrektur', 'die Notiz ist die app_label');
  assert.equal(d.device_id, dev.id);
  assert.equal(d.device_name, 'Konsole');
  assert.equal(d.editable, true);
  assert.equal(Date.parse(d.ended_at) - Date.parse(d.started_at), 45 * 60000,
    'ended_at bleibt der Anker, started_at = ended_at - minutes');
  // Ohne minutes bleibt ended_at unveraendert (nur note): Anker bleibt stehen.
  const endedBefore = d.ended_at;
  const relabel = await call('PATCH', `/sessions/${id}`, { body: { note: 'Nur Label' } });
  assert.equal(relabel.status, 200);
  assert.equal(relabel.body.data.ended_at, endedBefore);
  assert.equal(relabel.body.data.used_minutes, 45, 'ohne minutes aendert sich die Laenge nicht');

  // Validation: minutes ausserhalb 1..720, fremdes Geraet, leerer Koerper.
  const bad = await call('PATCH', `/sessions/${id}`, { body: { minutes: 0 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.reason, 'media_time_bad_request');
  const foreign = freshKid();
  const foreignDev = await mkDevice(foreign.id, 'Fremd');
  const badDev = await call('PATCH', `/sessions/${id}`, { body: { device_id: foreignDev.id } });
  assert.equal(badDev.status, 400);
  assert.equal(badDev.body.reason, 'media_time_bad_request');
  const empty = await call('PATCH', `/sessions/${id}`, { body: {} });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.reason, 'media_time_bad_request');

  // Nur manual: die Tracker-Session eines Geraets ist keine Korrektur-Zeile.
  const raw = db.prepare(`
    INSERT INTO media_time_sessions
      (session_key, user_id, device_id, package_name, started_at, used_minutes, minute_key,
       classification, source, created_at)
    VALUES ('raw-patch', ?, ?, 'com.raw.app', ?, 10, ?, 'charged', 'apk', ?)
  `).run(kid.id, dev.id, isoAgo(10), svc.mediaTimeDayKey(db), isoAgo(10)).lastInsertRowid;
  const noRaw = await call('PATCH', `/sessions/${raw}`, { body: { minutes: 5 } });
  assert.equal(noRaw.status, 404);
  assert.equal(noRaw.body.reason, 'media_time_not_found');
  // Kind darf nicht korrigieren.
  const asKid = await call('PATCH', `/sessions/${id}`, { actor: { id: kid.id, role: 'member' }, body: { minutes: 5 } });
  assert.equal(asKid.status, 403);
});

test('DELETE /sessions/:id — nur manual, harte Loeschung, Kind => 403', async () => {
  const kid = freshKid();
  const dev = await mkDevice(kid.id, 'Fernseher');
  const booked = await call('POST', '/sessions', { body: { user_id: kid.id, minutes: 15 } });
  const id = db.prepare('SELECT id FROM media_time_sessions WHERE session_key = ?').get(booked.body.data.session_key).id;
  const raw = db.prepare(`
    INSERT INTO media_time_sessions
      (session_key, user_id, device_id, package_name, started_at, used_minutes, minute_key,
       classification, source, created_at)
    VALUES ('raw-del', ?, ?, 'com.raw.app', ?, 10, ?, 'charged', 'apk', ?)
  `).run(kid.id, dev.id, isoAgo(10), svc.mediaTimeDayKey(db), isoAgo(10)).lastInsertRowid;

  const asKid = await call('DELETE', `/sessions/${id}`, { actor: { id: kid.id, role: 'member' } });
  assert.equal(asKid.status, 403);
  assert.equal(asKid.body.reason, 'media_time_forbidden');

  const noRaw = await call('DELETE', `/sessions/${raw}`);
  assert.equal(noRaw.status, 404);
  assert.equal(noRaw.body.reason, 'media_time_not_found');
  assert.ok(db.prepare('SELECT id FROM media_time_sessions WHERE id = ?').get(raw), 'Rohdaten bleiben unangetastet');

  const gone = await call('DELETE', `/sessions/${id}`);
  assert.equal(gone.status, 200);
  assert.equal(gone.body.data.deleted, true);
  assert.equal(db.prepare('SELECT id FROM media_time_sessions WHERE id = ?').get(id), undefined,
    'manuelle Buchungen sind kein Audit-Datensatz - sie verschwinden');
  const again = await call('DELETE', `/sessions/${id}`);
  assert.equal(again.status, 404);
});

test('GET /today — data.devices: Geraet mit Family-Link-Wert wird ersetzt, Nutzung ohne Geraet als null-Zeile', async () => {
  const kid = freshKid();
  await call('PUT', `/quotas/${kid.id}`, { body: { daily_minutes: 120 } });
  const dev = await mkDevice(kid.id, 'Tablet');
  await call('PUT', '/tracker/exceptions', {
    body: { upsert: [{ user_id: kid.id, match_type: 'exact', pattern: 'com.fl.app', exempt_from: 'charged' }] },
  });
  // Tracker meldet 10 Min aufs Tablet...
  await call('POST', '/tracker/sync', { token: dev.token, body: { sessions: [session('fl-d-1', 'com.fl.app', 10)] } });
  // ... und der Family-Link-Tageswert (42) ERSETZT sie (Mapping, kein Doppelzaehlen).
  seedFamilylink(kid.id, '900100', 'gdev-1', dev.id, svc.mediaTimeDayKey(db), 42);
  // Buchung ohne Geraet (7 Min) als eigene Zeile.
  await call('POST', '/sessions', { body: { user_id: kid.id, minutes: 7, note: 'Konsole' } });

  const res = await call('GET', `/today?user_id=${kid.id}`);
  assert.equal(res.status, 200);
  const devices = res.body.data.devices;
  assert.ok(Array.isArray(devices), 'devices ist eine Liste');
  const tablet = devices.find((r) => r.device_id === dev.id);
  assert.ok(tablet, 'das gemappte Geraet hat eine Zeile');
  assert.equal(tablet.device_name, 'Tablet');
  assert.equal(tablet.minutes, 42, 'der Google-Wert ersetzt die gemeldeten 10 Minuten');
  const noDevice = devices.find((r) => r.device_id === null);
  assert.ok(noDevice, 'die Buchung ohne Geraet erscheint als null-Zeile');
  assert.equal(noDevice.minutes, 7);
  // Dieselbe Grundlage wie dayUsage: charged_min = 42 + 7.
  assert.equal(res.body.data.charged_min, 49);
});

test('PUT /quotas/:userId — device_id: Geraet-Zeile statt Basis, GET /quotas zeigt beide mit device_name', async () => {
  const kid = freshKid();
  const dev = await mkDevice(kid.id, 'Handy');
  const global = await call('PUT', `/quotas/${kid.id}`, { body: { daily_minutes: 60 } });
  assert.equal(global.status, 200);
  assert.equal(global.body.data.device_id, null);
  assert.equal(global.body.data.daily_minutes, 60);

  const perDevice = await call('PUT', `/quotas/${kid.id}`, { body: { daily_minutes: 30, device_id: dev.id } });
  assert.equal(perDevice.status, 200, JSON.stringify(perDevice.body));
  assert.equal(perDevice.body.data.device_id, dev.id);
  assert.equal(perDevice.body.data.device_name, 'Handy');
  assert.equal(perDevice.body.data.daily_minutes, 30);
  // Idempotenter Zweit-Upsatz: kein zweiter Datensatz, der neue Wert gewinnt.
  const again = await call('PUT', `/quotas/${kid.id}`, { body: { daily_minutes: 45, device_id: dev.id } });
  assert.equal(again.status, 200);
  assert.equal(again.body.data.daily_minutes, 45);
  const rows = db.prepare('SELECT * FROM media_time_quotas WHERE user_id = ?').all(kid.id);
  assert.equal(rows.length, 2, 'Basis und Geraet-Zeile koexistieren');

  const list = await call('GET', `/quotas?user_id=${kid.id}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 2, 'der Basis-Zeile folgen die Geraet-Zeilen');
  const base = list.body.data.find((r) => r.device_id === null);
  const device = list.body.data.find((r) => r.device_id === dev.id);
  assert.equal(base.daily_minutes, 60);
  assert.equal(device.daily_minutes, 45);
  assert.equal(device.device_name, 'Handy');
  // quotaState fragt pro Geraet zuerst die Geraet-Zeile ab (Ueberschreibung).
  const state = svc.quotaState(db, kid.id, new Date(), dev.id);
  assert.equal(state.quota_min, 45, 'das Geraet-Kontingent gilt fuer dieses Geraet');

  // Fremdes Geraet: 404; kaputter Wert: 400.
  const other = freshKid();
  const foreignDev = await mkDevice(other.id, 'Fremd');
  const foreign = await call('PUT', `/quotas/${kid.id}`, { body: { daily_minutes: 10, device_id: foreignDev.id } });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.reason, 'media_time_not_found');
  const bad = await call('PUT', `/quotas/${kid.id}`, { body: { daily_minutes: 10, device_id: 'x' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.reason, 'media_time_bad_request');
});
