/**
 * Test: Medienzeit - Eltern-Notiz am Tageskontingent (PUT /quotas/:userId/day)
 * Zweck: Die Tagesanpassung mit Pflicht-Begruendung (Migration 288) ueber den
 *        echten Router: Erhoehung (+) und Senkung (-) am HEUTIGEN Tag,
 *        /today zeigt adjusted_min + reason (das Kind sieht die Begruendung),
 *        mehrere Eintraege summieren, Validation (delta 0, fehlender Grund),
 *        requireManager (Kind darf nicht PUT), day-notes (Kind liest eigene,
 *        fremdes Kind 403), Ziel muss ein Kind sein.
 * Muster: test/test-media-time-routes.js - express-App, fetch, injizierter actor.
 * Ausfuehren: node --experimental-sqlite --test test/test-media-time-quotas.js
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
db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('admin','Admin','x','admin','parent')").run();
db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('dad','Dad','x','member','parent')").run();

function cfgSet(key, value) {
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
cfgSet('media_time_enabled', '1');

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

/** Frisches Kind mit definiertem Tageskontingent. */
let kidSeq = 0;
async function freshKid(dailyMinutes = 60) {
  const name = `MtQKid-${++kidSeq}`;
  const id = db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', 'member', 'child')")
    .run(name.toLowerCase(), name).lastInsertRowid;
  if (dailyMinutes !== null) {
    const put = await call('PUT', `/quotas/${id}`, { body: { daily_minutes: dailyMinutes } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
  }
  return { id, role: 'member' };
}

// ════════════════════════════════════════════════════════════════════════════
// Erhoehung und Senkung mit Begruendung
// ════════════════════════════════════════════════════════════════════════════

test('PUT /quotas/:userId/day — +20 mit Grund: Kontingent steigt, /today zeigt adjusted_min und reason', async () => {
  const kid = await freshKid(60);
  const res = await call('PUT', `/quotas/${kid.id}/day`, {
    body: { delta_minutes: 20, reason: 'Geburtstagsausnahme - heute darf mehr' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.delta_minutes, 20);
  assert.equal(res.body.data.adjusted_min, 20);
  assert.equal(res.body.data.quota_min, 80, '60 Basis + 20 Notiz');
  assert.equal(res.body.data.day_key, svc.mediaTimeDayKey(db), 'der Tag ist der Server-Tag, nie eine Klientenuhr');
  // Die Notiz steht als eigene Zeile in der Tabelle (Protokoll, kein Zustand).
  const row = db.prepare('SELECT * FROM media_time_quota_notes WHERE user_id = ?').get(kid.id);
  assert.equal(row.delta_minutes, 20);
  assert.equal(row.created_by, ADMIN.id, 'wer angepasst hat, steht in der Zeile');
  // Das Kind sieht die Begruendung in /today.
  const today = await call('GET', `/today?user_id=${kid.id}`);
  assert.equal(today.status, 200);
  assert.equal(today.body.data.quota_min, 80);
  assert.equal(today.body.data.adjusted_min, 20);
  assert.equal(today.body.data.reason, 'Geburtstagsausnahme - heute darf mehr');
  const own = await call('GET', `/today`, { actor: { id: kid.id, role: 'member' } });
  assert.equal(own.body.data.adjusted_min, 20, 'das Kind sieht seine Anpassung ohne Fremdblick');
});

test('PUT /quotas/:userId/day — -10: der Balken sinkt, quota_min = basis - 10', async () => {
  const kid = await freshKid(60);
  const res = await call('PUT', `/quotas/${kid.id}/day`, {
    body: { delta_minutes: -10, reason: 'Hausaufgaben half nicht - heute weniger' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.quota_min, 50, 'Basis 60 minus 10');
  assert.equal(res.body.data.remaining_min, 50, 'noch nichts verbraucht => Rest = 50');
  const today = await call('GET', `/today?user_id=${kid.id}`);
  assert.equal(today.body.data.quota_min, 50);
  assert.equal(today.body.data.adjusted_min, -10);
  // Die Basis-Zeile selbst bleibt unangetastet (adjust-Philosophie).
  const q = db.prepare('SELECT daily_minutes FROM media_time_quotas WHERE user_id = ?').get(kid.id);
  assert.equal(q.daily_minutes, 60, 'daily_minutes wird nie rueck-geschrieben');
});

test('PUT /quotas/:userId/day — zwei Eintraege selben Tages summieren, reason zeigt den letzten', async () => {
  const kid = await freshKid(60);
  const a = await call('PUT', `/quotas/${kid.id}/day`, { body: { delta_minutes: 15, reason: 'Erste Anpassung: Besuch da' } });
  assert.equal(a.status, 200);
  // Zweite Anpassung eine Sekunde spaeter (created_at hat Sekunden-Aufloesung -
  // der id-Nachschlag sichert die Reihenfolge in quotaNoteReasons).
  const later = new Date(Date.now() + 1500).toISOString().replace(/\.\d{3}Z$/, 'Z');
  db.prepare(`
    INSERT INTO media_time_quota_notes (user_id, day_key, delta_minutes, reason, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(kid.id, svc.mediaTimeDayKey(db), -5, 'Zweite Anpassung: Besuch frueher weg', DAD.id, later);
  const today = await call('GET', `/today?user_id=${kid.id}`);
  assert.equal(today.body.data.adjusted_min, 10, '15 - 5: beide Eintraege zaehlen');
  assert.equal(today.body.data.quota_min, 70);
  assert.equal(today.body.data.reason, 'Zweite Anpassung: Besuch frueher weg', 'der neueste Eintrag erklaert den Stand');
});

// ════════════════════════════════════════════════════════════════════════════
// Validierung
// ════════════════════════════════════════════════════════════════════════════

test('PUT /quotas/:userId/day — reason-Pflicht: fehlender oder zu kurzer Grund => 400', async () => {
  const kid = await freshKid();
  const missing = await call('PUT', `/quotas/${kid.id}/day`, { body: { delta_minutes: 10 } });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.reason, 'media_time_bad_request');
  const short = await call('PUT', `/quotas/${kid.id}/day`, { body: { delta_minutes: 10, reason: 'ab' } });
  assert.equal(short.status, 400, 'unter 3 Zeichen ist keine Begruendung');
  const long = await call('PUT', `/quotas/${kid.id}/day`, { body: { delta_minutes: 10, reason: 'x'.repeat(301) } });
  assert.equal(long.status, 400, 'ueber 300 Zeichen nimmt die Route nicht');
  const notes = db.prepare('SELECT COUNT(*) AS n FROM media_time_quota_notes WHERE user_id = ?').get(kid.id).n;
  assert.equal(notes, 0, 'eine abgelehnte Anpassung hinterlaesst keine Zeile');
});

test('PUT /quotas/:userId/day — delta 0 (und ausser Spanne) => 400', async () => {
  const kid = await freshKid();
  const zero = await call('PUT', `/quotas/${kid.id}/day`, { body: { delta_minutes: 0, reason: 'nichts aendern' } });
  assert.equal(zero.status, 400);
  assert.equal(zero.body.reason, 'media_time_bad_request');
  const over = await call('PUT', `/quotas/${kid.id}/day`, { body: { delta_minutes: 1441, reason: 'ganz viel' } });
  assert.equal(over.status, 400, 'ueber 1440 (ein ganzer Tag) geht nicht');
  const under = await call('PUT', `/quotas/${kid.id}/day`, { body: { delta_minutes: -1441, reason: 'alles weg' } });
  assert.equal(under.status, 400);
});

// ════════════════════════════════════════════════════════════════════════════
// Berechtigungen
// ════════════════════════════════════════════════════════════════════════════

test('PUT /quotas/:userId/day — Kind darf nicht anpassen (requireManager): 403', async () => {
  const kid = await freshKid();
  const asKid = await call('PUT', `/quotas/${kid.id}/day`, {
    actor: { id: kid.id, role: 'member' },
    body: { delta_minutes: 60, reason: 'ich mache mir mehr' },
  });
  assert.equal(asKid.status, 403);
  assert.equal(asKid.body.reason, 'media_time_forbidden');
  const asDad = await call('PUT', `/quotas/${kid.id}/day`, {
    actor: DAD, body: { delta_minutes: 10, reason: 'Vater erlaubt zehn mehr' },
  });
  assert.equal(asDad.status, 200, 'ein Elternteil ohne Admin darf anpassen');
});

test('PUT /quotas/:userId/day — Ziel muss ein Kind sein: Erwachsener => 403 not_a_child', async () => {
  const grown = db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('gross','Gross','x','member','dad')").run().lastInsertRowid;
  const res = await call('PUT', `/quotas/${grown}/day`, { body: { delta_minutes: 10, reason: 'Erwachsener hat kein Kontingent' } });
  assert.equal(res.status, 403, 'dasselbe childRefusal-Muster wie PUT /quotas/:userId');
  assert.equal(res.body.reason, 'media_time_not_a_child');
  const missing = await call('PUT', '/quotas/999999/day', { body: { delta_minutes: 10, reason: 'gibt es nicht' } });
  assert.equal(missing.status, 404);
});

test('PUT /quotas/:userId/day — Haushaltsschalter aus => 403 media_time_disabled', async () => {
  const kid = await freshKid();
  cfgSet('media_time_enabled', '0');
  try {
    const res = await call('PUT', `/quotas/${kid.id}/day`, { body: { delta_minutes: 10, reason: 'Schalter aus' } });
    assert.equal(res.status, 403);
    assert.equal(res.body.reason, 'media_time_disabled');
  } finally {
    cfgSet('media_time_enabled', '1');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /quotas/:userId/day-notes (Transparenz fuer das Kind)
// ════════════════════════════════════════════════════════════════════════════

test('GET /quotas/:userId/day-notes — Kind liest eigene Eintraege inkl. Grund des Elternteils', async () => {
  const kid = await freshKid();
  const put = await call('PUT', `/quotas/${kid.id}/day`, {
    body: { delta_minutes: -20, reason: 'Schule ging unter - heute frueher Schluss' },
  });
  assert.equal(put.status, 200);
  const res = await call('GET', `/quotas/${kid.id}/day-notes`, { actor: { id: kid.id, role: 'member' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.items.length, 1);
  const item = res.body.data.items[0];
  assert.equal(item.reason, 'Schule ging unter - heute frueher Schluss', 'das Kind sieht, warum');
  assert.equal(item.delta_minutes, -20);
  assert.equal(item.created_by, ADMIN.id, 'und wer es war');
  assert.equal(item.day_key, svc.mediaTimeDayKey(db));
  assert.ok(item.created_at, 'der Zeitpunkt steht an der Zeile');
});

test('GET /quotas/:userId/day-notes — fremdes Kind => 403, Elter liest jedes Kind', async () => {
  const kidA = await freshKid();
  const kidB = await freshKid();
  const other = await call('GET', `/quotas/${kidB.id}/day-notes`, { actor: { id: kidA.id, role: 'member' } });
  assert.equal(other.status, 403);
  assert.equal(other.body.reason, 'media_time_forbidden');
  const asParent = await call('GET', `/quotas/${kidB.id}/day-notes`, { actor: DAD });
  assert.equal(asParent.status, 200);
  assert.deepEqual(asParent.body.data.items, []);
});

test('GET /quotas/:userId/day-notes — letzte 30, neueste zuerst', async () => {
  const kid = await freshKid();
  const dayKey = svc.mediaTimeDayKey(db);
  const insert = db.prepare(`
    INSERT INTO media_time_quota_notes (user_id, day_key, delta_minutes, reason, created_by, created_at)
    VALUES (?, ?, 1, ?, ?, ?)
  `);
  const base = Date.now();
  for (let i = 0; i < 34; i++) {
    const stamp = new Date(base + i * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    insert.run(kid.id, dayKey, `Notiz Nummer ${i + 1}`, DAD.id, stamp);
  }
  const res = await call('GET', `/quotas/${kid.id}/day-notes`, { actor: DAD });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.items.length, 30, 'die Route liefert hoechstens 30');
  assert.equal(res.body.data.items[0].reason, 'Notiz Nummer 34', 'neueste zuerst');
});
