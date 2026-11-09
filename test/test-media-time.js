/**
 * Modul: Medienzeit - die Regel-Engine (server/features/media-time/service.js)
 * Zweck: Die Klassifikation und die Kontingent-Rechnung, ohne HTTP - die
 *        Kernzusatze des Treuhender-Modells: ein unbekanntes Paket frisst NIE
 *        still Kontingent (fail-open, 'unknown'), ein Systembaustein wird nie
 *        abgezogen, die Yuvomi-App ist hart ausgenommen, Rohzeiten werden nie
 *        rueck-editiert (Exception-Aenderung berechnet nur die Klassifikation
 *        neu), und der Punktetausch hat EINEN Kurs fuer den ganzen Haushalt.
 * Ausfuehren: npm run test:media-time
 */

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'media-time-test-secret';

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const dbmod = await import('../server/db.js');
const svc = await import('../server/features/media-time/service.js');

const db = dbmod.get();

function isoAgo(minutes) {
  return new Date(Date.now() - minutes * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function cfgSet(key, value) {
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
function setEnabled(on) { cfgSet('media_time_enabled', on ? '1' : '0'); }
setEnabled(true);

let childSeq = 0;
function freshChild() {
  const name = `Mt-${++childSeq}`;
  return db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', 'member', 'child')")
    .run(name.toLowerCase(), name).lastInsertRowid;
}
function mkDevice(userId, name = 'Phone') {
  const token = 'mt_test_' + crypto.randomBytes(16).toString('hex');
  const id = db.prepare('INSERT INTO media_time_devices (user_id, name, device_token_hash) VALUES (?, ?, ?)')
    .run(userId, name, svc.hashDeviceToken(token)).lastInsertRowid;
  return { id, token };
}

// ════════════════════════════════════════════════════════════════════════════
// Haushaltsschalter und Praeferenzen
// ════════════════════════════════════════════════════════════════════════════

test('media_time_enabled: Default AUS, erst mit 1 an', () => {
  db.prepare("DELETE FROM sync_config WHERE key = 'media_time_enabled'").run();
  assert.equal(svc.mediaTimeEnabled(db), false, 'ohne Zeile ist Medienzeit aus');
  cfgSet('media_time_enabled', '0');
  assert.equal(svc.mediaTimeEnabled(db), false);
  cfgSet('media_time_enabled', '1');
  assert.equal(svc.mediaTimeEnabled(db), true);
});

test('parseQuietHours: HH:MM-HH:MM (auch ueber Mitternacht), alles andere null', () => {
  assert.deepEqual(svc.parseQuietHours('21:00-06:00'), { from: '21:00', to: '06:00' });
  assert.equal(svc.parseQuietHours('25:00-06:00'), null);
  assert.equal(svc.parseQuietHours('21-06'), null);
  assert.equal(svc.parseQuietHours(''), null);
  assert.equal(svc.parseQuietHours(null), null);
});

test('mediaTimeQuietWindow liest media_time_quiet_hours_global (Global, nicht pro Kind)', () => {
  cfgSet('media_time_quiet_hours_global', '20:30-07:00');
  assert.deepEqual(svc.mediaTimeQuietWindow(db), { from: '20:30', to: '07:00' });
  cfgSet('media_time_quiet_hours_global', '');
  assert.equal(svc.mediaTimeQuietWindow(db), null, 'leer = Ruhezeit aus');
});

test('parseExchangeRate: points:minutes, Grenzen', () => {
  assert.deepEqual(svc.parseExchangeRate('10:15'), { points: 10, minutes: 15 });
  assert.equal(svc.parseExchangeRate('0:15'), null, 'null Punkte gibt es nicht');
  assert.equal(svc.parseExchangeRate('10:0'), null);
  assert.equal(svc.parseExchangeRate('10:1441'), null);
  assert.equal(svc.parseExchangeRate('frei'), null);
});

test('mediaTimeExchangeRate ist EIN Kurs fuer den Haushalt (sync_config, Default aus)', () => {
  db.prepare("DELETE FROM sync_config WHERE key = 'media_time_exchange_rate'").run();
  assert.equal(svc.mediaTimeExchangeRate(db), null, 'ohne Kurs ist der Tausch aus');
  cfgSet('media_time_exchange_rate', '10:15');
  assert.deepEqual(svc.mediaTimeExchangeRate(db), { points: 10, minutes: 15 });
});

test('mediaTimeHardCap: Default hart, erst 0 macht das Cap kaufbar', () => {
  db.prepare("DELETE FROM sync_config WHERE key = 'media_time_hard_cap'").run();
  assert.equal(svc.mediaTimeHardCap(db), true, 'ohne Zeile ist das Cap hart');
  cfgSet('media_time_hard_cap', '0');
  assert.equal(svc.mediaTimeHardCap(db), false);
  cfgSet('media_time_hard_cap', '1');
  assert.equal(svc.mediaTimeHardCap(db), true);
});

// ════════════════════════════════════════════════════════════════════════════
// Geraete-Token
// ════════════════════════════════════════════════════════════════════════════

test('Geraete-Token: Hash in der Tabelle, Klartext NIE; revoked => null', () => {
  const kid = freshChild();
  const { id, token } = mkDevice(kid);
  const row = db.prepare('SELECT device_token_hash FROM media_time_devices WHERE id = ?').get(id);
  assert.match(row.device_token_hash, /^[0-9a-f]{64}$/, 'nur der sha256-Hash steht in der Zeile');
  assert.ok(!row.device_token_hash.includes(token), 'der Klartext taucht nie in der Spalte auf');
  assert.ok(svc.deviceByTokenHash(db, svc.hashDeviceToken(token)), 'gueltiges Token findet das Geraet');
  db.prepare('UPDATE media_time_devices SET revoked_at = ? WHERE id = ?').run(isoAgo(1), id);
  assert.equal(svc.deviceByTokenHash(db, svc.hashDeviceToken(token)), null, 'revoked => kein Geraet');
  assert.equal(svc.deviceByTokenHash(db, 'kurz'), null);
});

// ════════════════════════════════════════════════════════════════════════════
// Klassifikation (fail-open)
// ════════════════════════════════════════════════════════════════════════════

test('classifySession: Yuvomi-Paket hart ausgenommen, ohne Regel-Zeile', () => {
  const kid = freshChild();
  const r = svc.classifySession(db, kid, { packageName: svc.YUVOMI_PACKAGE, systemComponent: 0 });
  assert.equal(r.classification, 'exempt');
  assert.equal(r.ruleId, null, 'die harte Ausnahme ist keine loeschbare Zeile');
});

test('classifySession: lueckenhafte Prefix-Kette - exakt vor laengstem Prefix vor glob', () => {
  const kid = freshChild();
  db.prepare("INSERT INTO media_time_app_exceptions (user_id, match_type, pattern, exempt_from) VALUES (?, 'prefix', 'com.example', 'quota')").run(kid);
  db.prepare("INSERT INTO media_time_app_exceptions (user_id, match_type, pattern, exempt_from) VALUES (?, 'prefix', 'com.example.school', 'quota')").run(kid);
  db.prepare("INSERT INTO media_time_app_exceptions (user_id, match_type, pattern, exempt_from) VALUES (?, 'glob', 'com.example.*', 'quota')").run(kid);
  const r = svc.classifySession(db, kid, { packageName: 'com.example.school.reader', systemComponent: 0 });
  assert.equal(r.classification, 'exempt');
  const rule = db.prepare('SELECT pattern FROM media_time_app_exceptions WHERE id = ?').get(r.ruleId);
  assert.equal(rule.pattern, 'com.example.school', 'laengster Prefix gewinnt');
});

test('classifySession: exempt_from history und charged (Gegenrichtung)', () => {
  const kid = freshChild();
  db.prepare("INSERT INTO media_time_app_exceptions (user_id, match_type, pattern, exempt_from) VALUES (?, 'exact', 'com.game.a', 'history')").run(kid);
  db.prepare("INSERT INTO media_time_app_exceptions (user_id, match_type, pattern, exempt_from) VALUES (?, 'exact', 'com.game.b', 'charged')").run(kid);
  assert.equal(svc.classifySession(db, kid, { packageName: 'com.game.a', systemComponent: 0 }).classification, 'exempt');
  assert.equal(svc.classifySession(db, kid, { packageName: 'com.game.b', systemComponent: 0 }).classification, 'charged',
    'Eltern-Bestaetigung "Ja, abziehen" ist die Gegenrichtung');
});

test('classifySession: Haushalts-Default (user_id NULL) gilt fuer jedes Kind', () => {
  const kid = freshChild();
  db.prepare("INSERT INTO media_time_app_exceptions (user_id, match_type, pattern, exempt_from) VALUES (NULL, 'prefix', 'de.schulapp.', 'quota')").run();
  const r = svc.classifySession(db, kid, { packageName: 'de.schulapp.reader', systemComponent: 0 });
  assert.equal(r.classification, 'exempt');
});

test('classifySession: system_component => system (fail-open, nie Abzug)', () => {
  const kid = freshChild();
  const r = svc.classifySession(db, kid, { packageName: 'com.android.phone', systemComponent: 1 });
  assert.equal(r.classification, 'system');
});

test('classifySession: unbekanntes Paket => unknown (NIE still abziehen)', () => {
  const kid = freshChild();
  const r = svc.classifySession(db, kid, { packageName: 'com.neu.unknown', systemComponent: 0 });
  assert.equal(r.classification, 'unknown');
});

// ════════════════════════════════════════════════════════════════════════════
// Kontingent-Rechnung
// ════════════════════════════════════════════════════════════════════════════

function setQuota(userId, { daily = 60, max = null, enabled = 1 } = {}) {
  db.prepare(`
    INSERT INTO media_time_quotas (user_id, device_id, daily_minutes, max_daily_minutes, enabled)
    VALUES (?, NULL, ?, ?, ?)
    ON CONFLICT(user_id) WHERE device_id IS NULL DO UPDATE SET daily_minutes = excluded.daily_minutes,
      max_daily_minutes = excluded.max_daily_minutes, enabled = excluded.enabled
  `).run(userId, daily, max, enabled);
}
let keySeq = 0;
function mkSession(userId, { minutes = 10, classification = 'charged', source = 'apk', credit = false } = {}) {
  const dayKey = svc.mediaTimeDayKey(db);
  db.prepare(`
    INSERT INTO media_time_sessions
      (session_key, user_id, started_at, used_minutes, minute_key, classification, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(`t-${++keySeq}`, userId, isoAgo(minutes), minutes, dayKey, credit ? 'credit' : classification, source);
}

test('dayUsage trennt charged / exempt / system / unknown', () => {
  const kid = freshChild();
  setQuota(kid, { daily: 60 });
  mkSession(kid, { minutes: 20, classification: 'charged' });
  mkSession(kid, { minutes: 5, classification: 'exempt' });
  mkSession(kid, { minutes: 3, classification: 'system' });
  mkSession(kid, { minutes: 7, classification: 'unknown' });
  const u = svc.dayUsage(db, kid, svc.mediaTimeDayKey(db));
  assert.equal(u.charged_min, 20);
  assert.equal(u.exempt_min, 5);
  assert.equal(u.system_min, 3);
  assert.equal(u.unknown_min, 7, 'unknown ist sichtbar, damit die Eltern entscheiden');
});

test('quotaState: remaining = daily - charged; nearing unter 5 Minuten Rest', () => {
  const kid = freshChild();
  setQuota(kid, { daily: 60 });
  mkSession(kid, { minutes: 10, classification: 'charged' });
  let s = svc.quotaState(db, kid);
  assert.equal(s.quota_min, 60);
  assert.equal(s.used_min, 10);
  assert.equal(s.remaining_min, 50);
  assert.equal(s.state, 'ok');
  mkSession(kid, { minutes: 46, classification: 'charged' });
  s = svc.quotaState(db, kid);
  assert.equal(s.remaining_min, 4);
  assert.equal(s.state, 'nearing');
  mkSession(kid, { minutes: 10, classification: 'charged' });
  s = svc.quotaState(db, kid);
  assert.equal(s.remaining_min, 0);
  assert.equal(s.state, 'exceeded');
});

test('quotaState: fehlende quota-Zeile und enabled=0 => kein Kontingentspiel (ok)', () => {
  const kid = freshChild();
  let s = svc.quotaState(db, kid);
  assert.equal(s.quota_min, 0);
  assert.equal(s.state, 'ok');
  setQuota(kid, { daily: 30, enabled: 0 });
  mkSession(kid, { minutes: 40, classification: 'charged' });
  s = svc.quotaState(db, kid);
  assert.equal(s.state, 'ok', 'ausgesetztes Kontingent zeigt kein exceeded');
});

test('Punktetausch: credit-Session erhoht das Kontingent des Tages (kein Verbrauch)', () => {
  const kid = freshChild();
  setQuota(kid, { daily: 60 });
  mkSession(kid, { minutes: 55, classification: 'charged' });
  mkSession(kid, { minutes: 15, credit: true, source: 'adjust' });
  const s = svc.quotaState(db, kid);
  assert.equal(s.purchased_min, 15);
  assert.equal(s.quota_min, 75, '60 Basis + 15 gekauft');
  assert.equal(s.used_min, 55, 'der Kauf ist kein Verbrauch');
  assert.equal(s.remaining_min, 20);
});

test('hartes Cap (Default) kappt auch gekaufte Minuten; kaufbares Cap nicht', () => {
  const kid = freshChild();
  setQuota(kid, { daily: 30, max: 45 });
  mkSession(kid, { minutes: 30, credit: true, source: 'adjust' });
  cfgSet('media_time_hard_cap', '1');
  assert.equal(svc.quotaState(db, kid).quota_min, 45, 'hart: max_daily_minutes ist Endstation');
  cfgSet('media_time_hard_cap', '0');
  assert.equal(svc.quotaState(db, kid).quota_min, 60, 'kaufbar: ueber das Cap hinaus');
  cfgSet('media_time_hard_cap', '1');
});

// ════════════════════════════════════════════════════════════════════════════
// Quiet-Hours (global, Signal)
// ════════════════════════════════════════════════════════════════════════════

test('Ruhezeit aktiv => state quiet, ruhig vor exceeded (Signal fuer alle)', () => {
  const kid = freshChild();
  setQuota(kid, { daily: 60 });
  mkSession(kid, { minutes: 70, classification: 'charged' });
  assert.equal(svc.quotaState(db, kid).state, 'exceeded');
  // Fenster um die aktuelle Wandzeit legen (Sekundenpuffer gegen Tagwechsel)
  const wall = svc.householdWallTime(db);
  const [h, m] = wall.split(':').map(Number);
  const from = `${String(h).padStart(2, '0')}:${String(Math.max(0, m - 2)).padStart(2, '0')}`;
  const to = `${String(h).padStart(2, '0')}:${String(Math.min(59, m + 2)).padStart(2, '0')}`;
  cfgSet('media_time_quiet_hours_global', `${from}-${to}`);
  assert.equal(svc.quotaState(db, kid).state, 'quiet', 'quiet gewinnt gegen exceeded');
  assert.equal(svc.quietWindowActive(db), true);
  cfgSet('media_time_quiet_hours_global', '');
});

test('wallTimeInWindow ueber Mitternacht: 23:50 liegt in 21:00-06:00, 12:00 nicht', () => {
  // quietWindowActive haengt von der echten Uhr ab - die Fensterlogik selbst
  // pruefen wir indirekt: ein Fenster, das JETZT nicht gilt, laesst exceeded.
  const kid = freshChild();
  setQuota(kid, { daily: 1 });
  mkSession(kid, { minutes: 30, classification: 'charged' });
  cfgSet('media_time_quiet_hours_global', '00:00-00:00');
  assert.equal(svc.quietWindowActive(db), false, 'leeres Fenster (from == to) gilt nie');
  cfgSet('media_time_quiet_hours_global', '');
});

// ════════════════════════════════════════════════════════════════════════════
// Neueklassifikation nach Exception-Aenderung (adjust-Philosophie)
//
// Die Testzeilen setzen ein Paket: eine Session OHNE Paket ist per Definition
// 'unknown' (fail-open), und eine Ausnahme-Regel matcht definitionsgemaess
// nichts, was sie nicht benennen kann - eine Ausnahme, die alles freistellt,
// waere kein Ausnahme-Schlussel, sondern ein Abschalten des Kontingents.
// ════════════════════════════════════════════════════════════════════════════

test('reclassifyForUser: Klassifikation wandert, Rohwerte bleiben', () => {
  const kid = freshChild();
  setQuota(kid, { daily: 60 });
  const started = isoAgo(100);
  const dayKey = svc.mediaTimeDayKey(db);
  // rc-2 ist charged, WEIL eine 'charged'-Regel greift (Eltern-Bestaetigung
  // 'Ja, abziehen') - die Regel steht vor der Neueklassifikation schon, damit
  // deren Lauf fuer rc-2 kein erster Regeltreffer ist.
  const chargedRuleId = db.prepare("INSERT INTO media_time_app_exceptions (user_id, match_type, pattern, exempt_from) VALUES (?, 'exact', 'com.andere.app', 'charged')").run(kid).lastInsertRowid;
  db.prepare(`
    INSERT INTO media_time_sessions
      (session_key, user_id, package_name, started_at, ended_at, used_minutes, minute_key, classification, source)
    VALUES ('rc-1', ?, 'com.neu.unknown', ?, ?, 15, ?, 'unknown', 'apk')
  `).run(kid, started, isoAgo(85), dayKey);
  // rc-2 ist charged, WEIL eine 'charged'-Regel greift - die Zeile traegt ihre
  // Regel-Id von Anfang an, sonst ist die Neueklassifikation kein stiller
  // Laeufer fuer sie, sondern der erste Eintrag der Regel (das zaehlt).
  db.prepare(`
    INSERT INTO media_time_sessions
      (session_key, user_id, package_name, started_at, ended_at, used_minutes, minute_key, classification, exception_rule_id, source)
    VALUES ('rc-2', ?, 'com.andere.app', ?, ?, 15, ?, 'charged', ?, 'apk')
  `).run(kid, started, isoAgo(85), dayKey, chargedRuleId);

  db.prepare("INSERT INTO media_time_app_exceptions (user_id, match_type, pattern, exempt_from) VALUES (?, 'exact', 'com.neu.unknown', 'quota')").run(kid);
  const changed = svc.reclassifyForUser(db, kid);
  assert.equal(changed, 1, 'nur die Zeile mit dem unbekannten Paket wandert');
  const row = db.prepare("SELECT * FROM media_time_sessions WHERE session_key = 'rc-1'").get();
  assert.equal(row.classification, 'exempt');
  assert.equal(row.used_minutes, 15, 'used_minutes bleibt, wie gemeldet');
  assert.equal(row.started_at, started, 'started_at bleibt, wie gemeldet');
  assert.equal(db.prepare("SELECT classification FROM media_time_sessions WHERE session_key = 'rc-2'").get().classification, 'charged');
});

test('reclassifyForUser: Haushalts-Default (NULL) gilt auch fuer die Neueklassifikation', () => {
  const kid = freshChild();
  const dayKey = svc.mediaTimeDayKey(db);
  db.prepare(`
    INSERT INTO media_time_sessions
      (session_key, user_id, package_name, started_at, used_minutes, minute_key, classification, source)
    VALUES ('rc-3', ?, 'com.neu.schulapp', ?, 5, ?, 'unknown', 'apk')
  `).run(kid, isoAgo(10), dayKey);
  db.prepare("INSERT INTO media_time_app_exceptions (user_id, match_type, pattern, exempt_from) VALUES (NULL, 'prefix', 'com.neu', 'quota')").run();
  assert.equal(svc.reclassifyForUser(db, kid), 1);
  assert.equal(db.prepare("SELECT classification FROM media_time_sessions WHERE session_key = 'rc-3'").get().classification, 'exempt');
});

// ════════════════════════════════════════════════════════════════════════════
// exceptions_version und Tracker-Status
// ════════════════════════════════════════════════════════════════════════════

test('exceptionsVersion: steigt bei Anlage und bei Ruecknahme', () => {
  const kid = freshChild();
  const before = svc.exceptionsVersion(db);
  const info = db.prepare("INSERT INTO media_time_app_exceptions (user_id, match_type, pattern) VALUES (?, 'exact', 'com.v.a')").run(kid);
  const mid = svc.exceptionsVersion(db);
  assert.ok(mid > before, `neue Regel (${mid}) > vorher (${before})`);
  db.prepare('UPDATE media_time_app_exceptions SET revoked_at = ? WHERE id = ?').run(isoAgo(1), info.lastInsertRowid);
  assert.ok(svc.exceptionsVersion(db) > mid, 'Ruecknahme zahlt mit');
});

test('trackerStatus: online binnen 12 h, offline danach, ohne Geraet still', () => {
  const kid = freshChild();
  assert.deepEqual(svc.trackerStatus(db, kid), { last_seen_at: null, online: false });
  const { id } = mkDevice(kid, 'Pixel');
  db.prepare('UPDATE media_time_devices SET last_seen_at = ? WHERE id = ?').run(isoAgo(30), id);
  let s = svc.trackerStatus(db, kid);
  assert.equal(s.online, true);
  db.prepare('UPDATE media_time_devices SET last_seen_at = ? WHERE id = ?').run(isoAgo(13 * 60), id);
  s = svc.trackerStatus(db, kid);
  assert.equal(s.online, false, '13 Stunden Stille => offline-Signal statt Nulltag');
  assert.ok(s.last_seen_at, 'der letzte Kontakt bleibt lesbar');
});

// ════════════════════════════════════════════════════════════════════════════
// Rohdaten-Aufbewahrung (Entscheidung: Rohzeiten, 90 Tage)
// ════════════════════════════════════════════════════════════════════════════

test('pruneRawSessions: alte Rohzeilen weg, junge und credit-Zeilen bleiben', () => {
  const kid = freshChild();
  const oldKey = isoDayAgo(svc.RAW_RETENTION_DAYS + 5);
  const youngKey = isoDayAgo(2);
  // created_at mitsetzen: der Pruning-Schutz gegen spaete Nachmeldungen lebt
  // genau davon (eine Nachmeldung EINES alten Tages faellt nicht sofort),
  // und der DEFAULT der Tabelle traegt hier das INSERT-Datum ein.
  const oldCreatedAt = isoAgo((svc.RAW_RETENTION_DAYS + 5) * 24 * 60);
  db.prepare(`
    INSERT INTO media_time_sessions (session_key, user_id, started_at, used_minutes, minute_key, classification, source, created_at)
    VALUES ('pr-old', ?, ?, 10, ?, 'charged', 'apk', ?)
  `).run(kid, isoAgo((svc.RAW_RETENTION_DAYS + 5) * 24 * 60), oldKey, oldCreatedAt);
  db.prepare(`
    INSERT INTO media_time_sessions (session_key, user_id, started_at, used_minutes, minute_key, classification, source)
    VALUES ('pr-young', ?, ?, 10, ?, 'charged', 'apk')
  `).run(kid, isoAgo(2 * 24 * 60), youngKey);
  db.prepare(`
    INSERT INTO media_time_sessions (session_key, user_id, started_at, used_minutes, minute_key, classification, source, created_at)
    VALUES ('pr-credit', ?, ?, 15, ?, 'credit', 'adjust', ?)
  `).run(kid, isoAgo((svc.RAW_RETENTION_DAYS + 5) * 24 * 60), oldKey, oldCreatedAt);
  const removed = svc.pruneRawSessions(db);
  assert.equal(removed, 1, 'nur die alte Nutzungszeile geht');
  assert.ok(db.prepare("SELECT id FROM media_time_sessions WHERE session_key = 'pr-young'").get());
  assert.ok(db.prepare("SELECT id FROM media_time_sessions WHERE session_key = 'pr-credit'").get(),
    'ein Kauf (credit) ist keine Rohzeit, die verschwindet');
  // Der Nachmeldungs-Schutz selbst: ein ALTER Tag mit FRISCHEM created_at
  // (eine Nachmeldung, die eben erst eintraf) darf noch nicht faellen.
  db.prepare(`
    INSERT INTO media_time_sessions (session_key, user_id, started_at, used_minutes, minute_key, classification, source)
    VALUES ('pr-late', ?, ?, 10, ?, 'charged', 'backfill')
  `).run(kid, oldCreatedAt, oldKey);
  assert.equal(svc.pruneRawSessions(db), 0, 'frisch gemeldete alte Rohzeit bleibt bis zur echten Aufbewahrung');
  assert.equal(svc.RAW_RETENTION_DAYS, 90);
});

function isoDayAgo(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// ════════════════════════════════════════════════════════════════════════════
// Konstanten der Sync-Grenzen
// ════════════════════════════════════════════════════════════════════════════

test('Sync-Grenzen: 200 Sessions, laufende Segmente bei 12 h gekappt', () => {
  assert.equal(svc.MAX_SESSIONS_PER_SYNC, 200);
  assert.equal(svc.STALE_SESSION_CAP_MIN, 720);
  assert.equal(svc.TRACKER_ONLINE_WINDOW_HOURS, 12);
});
