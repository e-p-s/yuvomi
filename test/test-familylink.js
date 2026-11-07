/**
 * Test: Family-Link-Istzeit (server/services/familylink.js)
 * Zweck: Einbau-Spec (HANDOVER.md, Migration 291) als Pruefstein - der Ingest
 *        schreibt nur zugeordnete Kinder, ein Fehlerlauf (401/kein JSON) setzt
 *        den Status login_noetig und schreibt NIE 0er-Snapshots, und die
 *        Google-Istzeit ersetzt in dayUsage die Session-Minuten des gemappten
 *        Geraets (zahlend, nie zusatzlich - kein Doppelzaehlen).
 * Muster: test/test-media-time.js - echter SQLite-Schema-Pfad in memory.
 * Ausfuehren: node --experimental-sqlite --test test/test-familylink.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

const dbmod = await import('../server/db.js');
const svc = await import('../server/services/media-time.js');
const fl = await import('../server/services/familylink.js');
const db = dbmod.get();

const UID = '9001234567';

function kid(name) {
  return db.prepare(
    "INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', 'member', 'child')"
  ).run(name.toLowerCase(), name).lastInsertRowid;
}
function device(userId, name) {
  return db.prepare(
    "INSERT INTO media_time_devices (user_id, name, platform, device_token_hash) VALUES (?, ?, 'android', ?)"
  ).run(userId, name, `tok-${name}-${userId}`).lastInsertRowid;
}
function session(userId, deviceId, dayKey, minutes) {
  db.prepare(`
    INSERT INTO media_time_sessions (session_key, user_id, device_id, started_at, ended_at,
      used_minutes, minute_key, kind, system_component, classification)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'foreground', 0, 'charged')
  `).run(`s-${userId}-${deviceId}-${dayKey}-${minutes}`, userId, deviceId,
    `${dayKey}T08:00:00Z`, `${dayKey}T09:00:00Z`, minutes, dayKey);
}
function mapChild(childId, uid) {
  db.prepare(`
    INSERT INTO familylink_children (google_uid, yuvomi_user_id, display_name, enabled)
    VALUES (?, ?, NULL, 1)
    ON CONFLICT(google_uid) DO UPDATE SET yuvomi_user_id = excluded.yuvomi_user_id
  `).run(uid, childId);
}
function mapDevice(uid, gDevId, deviceId) {
  db.prepare(`
    INSERT INTO familylink_device_map (google_uid, google_device_id, media_time_device_id)
    VALUES (?, ?, ?)
    ON CONFLICT(google_uid, google_device_id) DO UPDATE SET media_time_device_id = excluded.media_time_device_id
  `).run(uid, gDevId, deviceId);
}
function report(day, entries) {
  return { date: day, children: entries };
}
const dailyCount = () => db.prepare('SELECT COUNT(*) AS n FROM familylink_daily').get().n;

const dayKey = svc.mediaTimeDayKey(db);

// ════════════════════════════════════════════════════════════════════════════
// Ingest
// ════════════════════════════════════════════════════════════════════════════

test('ingest - nur zugeordnete Kinder; Geraete ohne Link als Zeile mit null-Link', () => {
  const mapped = kid('FlMapped');
  const orphan = kid('FlOrphan');
  const devId = device(mapped, 'FlPhone');
  mapChild(mapped, UID);
  mapDevice(UID, 'gdev-linked', devId);
  const r = fl.ingestFamilylinkReport(db, report(dayKey, [
    { name: 'Versteckt', userId: UID, downtime: '20:00-06:30', devices: [
      { id: 'gdev-linked', consumed_min: 30, allowed_min: 60, remaining_min: 30 },
      { id: 'gdev-unlinked', consumed_min: 5, allowed_min: 60, remaining_min: 55 },
    ] },
    { name: 'Fremd', userId: '7777777777', devices: [
      { id: 'x', consumed_min: 99, allowed_min: 60, remaining_min: 0 },
    ] },
  ]));
  assert.equal(r.written, 2, 'zwei Zeilen fuer das zugeordnete Kind');
  assert.equal(r.errors, 0);
  const linked = db.prepare(
    'SELECT * FROM familylink_daily WHERE google_device_id = ?'
  ).get('gdev-linked');
  assert.equal(linked.consumed_min, 30);
  assert.equal(linked.downtime, '20:00-06:30');
  const unlinked = db.prepare(
    'SELECT * FROM familylink_daily WHERE google_device_id = ?'
  ).get('gdev-unlinked');
  assert.ok(unlinked, 'Gerät ohne Link bekommt eine Zeile (zum Zuordnen in der UI)');
  const mapRow = db.prepare(
    'SELECT media_time_device_id FROM familylink_device_map WHERE google_device_id = ?'
  ).get('gdev-unlinked');
  assert.equal(mapRow, undefined, 'kein erfundener Link');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM familylink_daily WHERE google_uid = ?').get('7777777777').n, 0,
    'ein fremdes Google-Konto schreibt nichts');
  const nameRow = db.prepare('SELECT display_name FROM familylink_children WHERE google_uid = ?').get(UID);
  assert.equal(nameRow.display_name, null, 'der Google-Name bleibt nicht stehen (Spec: keine Kind-Namen)');
});

test('ingest - Report ohne gueltiges Datum oder ohne children wirft', () => {
  assert.throws(() => fl.ingestFamilylinkReport(db, { children: [] }));
  assert.throws(() => fl.ingestFamilylinkReport(db, { date: 'heute', children: [] }));
});

test('runFamilylinkIngest - Fehlerlauf setzt login_noetig und schreibt keine Zeile', async () => {
  const before = dailyCount();
  const r = await fl.runFamilylinkIngest(db, { runner: async () => ({ ok: false }) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'login_noetig');
  assert.equal(r.written, 0);
  assert.equal(dailyCount(), before, 'kein 0er-Snapshot (Spec-Regel)');
  assert.equal(fl.familylinkStatus(db), 'login_noetig');
  const r2 = await fl.runFamilylinkIngest(db, {
    runner: async () => { throw new Error('401'); },
  });
  assert.equal(r2.status, 'login_noetig');
  assert.equal(dailyCount(), before, 'auch der Wurf schreibt keine Zeile');
});

test('runFamilylinkIngest - Erfolg schreibt und setzt Status ok', async () => {
  const r = await fl.runFamilylinkIngest(db, {
    runner: async () => ({ ok: true, report: report(dayKey, [
      { userId: UID, devices: [{ id: 'gdev-linked', consumed_min: 45, allowed_min: 60, remaining_min: 15 }] },
    ]) }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'ok');
  assert.equal(r.written, 1);
  assert.equal(fl.familylinkStatus(db), 'ok');
});

// ════════════════════════════════════════════════════════════════════════════
// dayUsage: Google-Istzeit ersetzt die Session-Minuten des gemappten Gerets
// ════════════════════════════════════════════════════════════════════════════

test('dayUsage - gemapptes Gerat: Google-Minuten zahlen, Sessions nicht doppelt', () => {
  const childId = db.prepare(
    'SELECT yuvomi_user_id AS id FROM familylink_children WHERE google_uid = ?'
  ).get(UID).id;
  const devId = db.prepare(
    'SELECT media_time_device_id AS id FROM familylink_device_map WHERE google_device_id = ?'
  ).get('gdev-linked').id;
  session(childId, devId, dayKey, 10);
  const u = svc.dayUsage(db, childId, dayKey);
  assert.equal(u.familylink_min, 45, 'die Auskunft ueber die Quelle');
  assert.equal(u.charged_min, 45, '10 Session-Minuten werden durch 45 Google-Minuten ersetzt, nicht addiert');
});

test('dayUsage - ohne Google-Zeile bleibt die Session die Auskunft', () => {
  const childId = kid('FlNoGoogle');
  const devId = device(childId, 'FlNoGooglePhone');
  session(childId, devId, dayKey, 12);
  const u = svc.dayUsage(db, childId, dayKey);
  assert.equal(u.charged_min, 12);
  assert.equal(u.familylink_min, 0);
});

test('dayUsage - Kind ohne Zuordnung sieht nie Google-Werte', () => {
  const childId = kid('FlUnmapped');
  const other = db.prepare('SELECT google_uid FROM familylink_children LIMIT 1').get().google_uid;
  const before = dailyCount();
  const u = svc.dayUsage(db, childId, dayKey);
  assert.equal(u.familylink_min, 0);
  assert.ok(!db.prepare(
    'SELECT 1 FROM familylink_daily WHERE google_uid = ? AND day = ?'
  ).all(other, dayKey).some(() => false), 'Bestand unveraendert lesbar');
  assert.equal(dailyCount(), before);
});

// ════════════════════════════════════════════════════════════════════════════
// familylinkUsage
// ════════════════════════════════════════════════════════════════════════════

test('familylinkUsage - ohne Zuordnung mapped:false, mit Zuordnung Geraete mit google_device_id', () => {
  const childId = db.prepare('SELECT yuvomi_user_id AS id FROM familylink_children WHERE google_uid = ?').get(UID).id;
  const un = fl.familylinkUsage(db, kid('FlUsageFree'), dayKey);
  assert.equal(un.mapped, false);
  assert.equal(un.devices.length, 0);
  const use = fl.familylinkUsage(db, childId, dayKey);
  assert.equal(use.mapped, true);
  assert.equal(use.status, 'ok');
  assert.ok(use.devices.some((d) => d.google_device_id === 'gdev-unlinked' && d.media_time_device_id === null),
    'Gemeldete, aber nicht verlinkte Geraete sind sichtbar (Zuordnungs-UI)');
  const linked = use.devices.find((d) => d.google_device_id === 'gdev-linked');
  assert.equal(linked.consumed_min, 45);
});

test('dayUsage — Kind ohne eigenes Geraet: Google-Summe ist der Verbrauch', () => {
  const childId = kid('FlPhoneOnly');
  mapChild(childId, '5555559999');
  const day = dayKey;
  db.prepare(`
    INSERT INTO familylink_daily (google_uid, google_device_id, day, consumed_min, fetched_at)
    VALUES ('5555559999', 'gd-a', ?, 25, '2026-11-05T10:00:00Z'),
           ('5555559999', 'gd-b', ?, 10, '2026-11-05T10:00:00Z')
  `).run(day, day);
  const u = svc.dayUsage(db, childId, day);
  assert.equal(u.charged_min, 35, 'zwei Geraete ohne Link: Summe zahlend');
  assert.equal(u.familylink_min, 35);
});
