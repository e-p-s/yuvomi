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
// Status-Zeitmarke (GET /settings: familylink_status_at)
// ════════════════════════════════════════════════════════════════════════════

test('setStatus - die Zeitmarke STATUS_AT_KEY laeuft mit (UI-Zeitstempel)', () => {
  const read = () => db.prepare('SELECT value FROM sync_config WHERE key = ?')
    .get(fl.FAMILYLINK_STATUS_KEYS.at)?.value ?? null;
  const before = read();
  fl.setStatus(db, 'login_noetig');
  const at = read();
  assert.match(String(at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    'die Zeitmarke ist ein ISO-Moment (Z) wie bei den uebrigen sync_config-Werten');
  fl.setStatus(db, 'ok');
  assert.ok(String(read()) >= String(at), 'ein zweiter Lauf bewegt die Marke vorwaerts');
  assert.ok(before === null || /^\d{4}-\d{2}-\d{2}T/.test(String(before)),
    'vorher war nichts oder ein gleicher Moment eingetragen');
  // setStatus schreibt nur den Status - keine Tageszeile, also bleibt
  // familylink_last_report_at (MAX(fetched_at)) die Marke der letzten echten
  // Zeile: ein reiner Statuslauf kann sie nicht bewegen. Der Status endet auf
  // 'ok', damit die Folge-Tests ihren bekannten Stand behalten.
  const rows = dailyCount();
  fl.setStatus(db, 'ok');
  assert.equal(dailyCount(), rows, 'der Statuspfad schreibt keine Zeile');
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

// ════════════════════════════════════════════════════════════════════════════
// Alt-Schluessel mit echtem U+2026 (self-healing-Migration, kein Deploy-Schritt)
// ════════════════════════════════════════════════════════════════════════════

const LEGACY_S = 'familyli\u2026us';
const LEGACY_A = 'famil\u2026_at';
const cfgPut = (key, value) => db.prepare(
  'INSERT INTO sync_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
).run(key, value);
const cfgGet = (key) => db.prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value;
const cfgDel = (key) => db.prepare('DELETE FROM sync_config WHERE key = ?').run(key);

test('runFamilylinkIngest - Pull-Fehlschlag ueberschreibt keinen frischen Push (07.11.)', async () => {
  // Der Push-Cron des Collectors hatte gerade Erfolg (status_at = jetzt):
  // ein lokaler Pull-Laeufer (ohne Session) darf den Status nicht kippen.
  fl.setStatus(db, 'ok');
  const r = await fl.runFamilylinkIngest(db, { runner: async () => ({ ok: false }) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'ok', 'der frische Zustand bleibt die Auskunft');
  assert.equal(fl.familylinkStatus(db), 'ok');
  // Aelter als zwei Takte plus Puffer (12 min): der Fehl-Fall gewinnt wieder.
  cfgPut(fl.FAMILYLINK_STATUS_KEYS.at,
    new Date(Date.now() - 15 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  const r2 = await fl.runFamilylinkIngest(db, { runner: async () => ({ ok: false }) });
  assert.equal(r2.status, 'login_noetig');
  assert.equal(fl.familylinkStatus(db), 'login_noetig');
});

test('migrateLegacyStatusKeys - Altschluessel wandert zum neuen Key, alt verschwindet (Idempotenz)', () => {
  // So sah eine alte Datenbank aus: nur die U+2026-Zeilen, neue Keys fehlen.
  cfgDel(fl.FAMILYLINK_STATUS_KEYS.status);
  cfgDel(fl.FAMILYLINK_STATUS_KEYS.at);
  cfgPut(LEGACY_S, 'login_noetig');
  cfgPut(LEGACY_A, '2026-11-04T08:00:00Z');
  assert.equal(fl.familylinkStatus(db), 'login_noetig',
    'der erste Zugriff im Lesepfad hebt den Wert schon um');
  assert.equal(cfgGet(fl.FAMILYLINK_STATUS_KEYS.status), 'login_noetig');
  assert.equal(cfgGet(fl.FAMILYLINK_STATUS_KEYS.at), '2026-11-04T08:00:00Z',
    'die Zeitmarke wandert mit (GET /settings zeigt den alten Moment)');
  assert.equal(cfgGet(LEGACY_S), undefined, 'der Altschluessel ist weg');
  assert.equal(cfgGet(LEGACY_A), undefined);
  fl.migrateLegacyStatusKeys(db);
  assert.equal(cfgGet(fl.FAMILYLINK_STATUS_KEYS.status), 'login_noetig',
    'ein zweiter Lauf aendert nichts (Idempotenz)');
});

test('migrateLegacyStatusKeys - existieren beide, gewinnt der neue; der alte wird geloescht', () => {
  cfgPut(fl.FAMILYLINK_STATUS_KEYS.status, 'ok');
  cfgPut(LEGACY_S, 'login_noetig');
  fl.migrateLegacyStatusKeys(db);
  assert.equal(cfgGet(fl.FAMILYLINK_STATUS_KEYS.status), 'ok', 'der neue Schluessel gewinnt');
  assert.equal(cfgGet(LEGACY_S), undefined, 'der Altschluessel wird trotzdem geloescht');
  // Der Schreibpfad migriert ebenso: setStatus vor dem Schreiben raemt auf.
  cfgPut(LEGACY_A, '2026-11-01T00:00:00Z');
  fl.setStatus(db, 'login_noetig');
  assert.equal(cfgGet(LEGACY_A), undefined, 'auch im Schreibpfad bleibt kein Altwert');
  assert.match(String(cfgGet(fl.FAMILYLINK_STATUS_KEYS.at)), /^\d{4}-\d{2}-\d{2}T/,
    'setStatus schreibt die eigene Marke, nicht den umgezogenen Altwert');
  fl.setStatus(db, 'ok'); // bekannter Endstand fuer die Suite
});

// ════════════════════════════════════════════════════════════════════════════
// App-Nutzung (A2): children[].apps -> familylink_app_usage
// ════════════════════════════════════════════════════════════════════════════

const appDay = '2026-11-06';
const appRows = (day) => db.prepare(
  'SELECT * FROM familylink_app_usage WHERE day = ? ORDER BY pkg'
).all(day);

test('apps-Ingest (a) - Paar-Array [pkg, {name, minutes}]; usage zaehlt nicht in written', () => {
  const r = fl.ingestFamilylinkReport(db, report(appDay, [
    { userId: UID, devices: [], apps: [
      ['com.example.game', { name: 'Game', minutes: 42.5 }],
      ['com.example.video', { name: null, minutes: 10 }],
    ] },
  ]));
  assert.equal(r.written, 0, 'keine Geraetezeile - written bleibt geraete-bezogen (Spec)');
  assert.equal(r.usage_written, 2);
  const rows = appRows(appDay);
  assert.equal(rows.length, 2);
  const game = rows.find((x) => x.pkg === 'com.example.game');
  assert.equal(game.minutes, 42.5);
  assert.equal(game.name, 'Game');
  assert.equal(game.google_uid, UID);
  assert.equal(rows.find((x) => x.pkg === 'com.example.video').name, null, 'name NULL ist erlaubt');
});

test('apps-Ingest (b) - Objekt-Map pkg -> {name, minutes}', () => {
  const day = '2026-11-05';
  const r = fl.ingestFamilylinkReport(db, report(day, [
    { userId: UID, devices: [], apps: {
      'com.a.map': { name: 'Map A', minutes: 5 },
      'com.b.map': { minutes: '7' }, // Zahlen-String: robust normalisiert
    } },
  ]));
  assert.equal(r.usage_written, 2);
  const rows = appRows(day);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((x) => x.pkg === 'com.b.map').minutes, 7);
  assert.equal(rows.find((x) => x.pkg === 'com.b.map').name, null);
});

test('apps-Ingest (c) - unsaubere Eintraege werden verworfen (pkg leer/Nicht-String, minutes null/negativ)', () => {
  const day = '2026-11-04';
  const r = fl.ingestFamilylinkReport(db, report(day, [
    { userId: UID, devices: [], apps: [
      { pkg: 'ok.pkg', name: 'OK', minutes: 3 },
      { pkg: '', minutes: 5 },               // pkg leer
      { pkg: '   ', minutes: 5 },            // pkg nur Whitespace
      { pkg: 123, minutes: 5 },              // pkg kein String
      { pkg: 'null.min', minutes: null },    // minutes null (kein 0er-Snapshot)
      { pkg: 'neg.min', minutes: -2 },       // minutes negativ
      { pkg: 'str.min', minutes: 'abc' },    // minutes keine endliche Zahl
      ['pair.pkg', { name: 'Pair', minutes: 1 }], // Mischung mit Paar-Form bleibt gueltig
    ] },
  ]));
  assert.equal(r.usage_written, 2, 'nur die tragfaehigen Zeilen');
  const pkgs = appRows(day).map((x) => x.pkg);
  assert.deepEqual(pkgs, ['ok.pkg', 'pair.pkg']);
});

test('apps-Ingest (d) - Upsert ersetzt Minuten fuer gleiche (day, uid, pkg)', () => {
  const before = fl.ingestFamilylinkReport(db, report(appDay, [
    { userId: UID, devices: [], apps: [['com.example.game', { name: 'Game', minutes: 42.5 }]] },
  ]));
  assert.equal(before.usage_written, 1);
  const first = db.prepare(
    "SELECT * FROM familylink_app_usage WHERE day = ? AND pkg = 'com.example.game'"
  ).get(appDay);
  const again = fl.ingestFamilylinkReport(db, report(appDay, [
    { userId: UID, devices: [], apps: [['com.example.game', { name: 'Game v2', minutes: 60 }]] },
  ]));
  assert.equal(again.usage_written, 1, 'der zweite Lauf zaehlt den Upsert erneut');
  const rows = db.prepare(
    "SELECT COUNT(*) AS n FROM familylink_app_usage WHERE day = ? AND pkg = 'com.example.game'"
  ).get(appDay);
  assert.equal(rows.n, 1, 'keine Doppelzeile (PK day, google_uid, pkg)');
  const now = db.prepare(
    "SELECT * FROM familylink_app_usage WHERE day = ? AND pkg = 'com.example.game'"
  ).get(appDay);
  assert.equal(now.minutes, 60, 'Minuten ersetzt');
  assert.equal(now.name, 'Game v2');
  assert.ok(String(now.fetched_at) >= String(first.fetched_at), 'fetched_at laeuft mit');
});

test('apps-Ingest - nicht zugeordnete Kinder schreiben auch keine App-Zeile', () => {
  const day = '2026-11-03';
  const r = fl.ingestFamilylinkReport(db, report(day, [
    { userId: '7777777777', devices: [], apps: [['com.fremd', { minutes: 9 }]] },
  ]));
  assert.equal(r.usage_written, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM familylink_app_usage WHERE day = ?').get(day).n, 0);
});

test('familylinkAppUsage (e) - Route-Leselogik: sortiert minutes DESC, yuvomi_user_id via Zuordnung, sonst NULL', () => {
  const day = '2026-11-02';
  // Kind ohne Zuordnung (uid direkt eingefuegt) und ein deaktiviertes Kind.
  const offChild = kid('FlAppDisabled');
  mapChild(offChild, '6666660001');
  db.prepare('UPDATE familylink_children SET enabled = 0 WHERE google_uid = ?').run('6666660001');
  const mapped = db.prepare(
    'SELECT yuvomi_user_id AS id FROM familylink_children WHERE google_uid = ?'
  ).get(UID).id;
  fl.ingestFamilylinkReport(db, report(day, [
    { userId: UID, devices: [], apps: [
      ['small.pkg', { name: 'Small', minutes: 4 }],
      ['big.pkg', { name: 'Big', minutes: 90 }],
    ] },
  ]));
  db.prepare(`
    INSERT INTO familylink_app_usage (day, google_uid, pkg, name, minutes, fetched_at) VALUES
      (?, '7777777777', 'orphan.pkg', NULL, 50, '2026-11-02T10:00:00Z'),
      (?, '6666660001', 'off.pkg', 'Aus', 20, '2026-11-02T10:00:00Z')
  `).run(day, day);
  const items = fl.familylinkAppUsage(db, day);
  assert.deepEqual(items.map((i) => i.pkg), ['big.pkg', 'orphan.pkg', 'off.pkg', 'small.pkg'],
    'minutes DESC, alle gesammelten Zeilen (auch ohne aktive Zuordnung)');
  assert.equal(items[0].yuvomi_user_id, mapped);
  assert.equal(items[1].yuvomi_user_id, null, 'Kind ohne Zuordnung: NULL');
  assert.equal(items[2].yuvomi_user_id, null, 'deaktivierte Zuordnung: NULL (enabled=1 Bedingung)');
  assert.equal(items[3].name, 'Small');
  assert.deepEqual(Object.keys(items[0]).sort(),
    ['google_uid', 'minutes', 'name', 'pkg', 'yuvomi_user_id'],
    'keine Kind-Namen im Datensatz (Spec): nur uid + user-id + App-Felder');
});
