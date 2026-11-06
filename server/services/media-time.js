/**
 * Modul: Medienzeit (Bildschirmzeit-Kontingente)
 * Zweck: Die Regel-Engine hinter /api/v1/media-time (docs/medienzeit-konzept.md,
 *        docs/medienzeit-android-tracker.md). Der Server ist die einzige
 *        Autoritaet: ein Klient meldet Nutzung, erlauben entscheidet der Server.
 *        Grundprinzip ist das Treuhender-Modell - Anreiz, kein Zwang. Es gibt
 *        serverseitig keinen Sperrpfad, nur Antworten, die ein Klient zeigen kann.
 * Abhaengigkeiten: better-sqlite3-Handle (synchron), wird vom Aufrufer uebergeben
 *        (d-passing wie services/rewards.js).
 *
 * WARUM DIE KLASSIFIKATION FAIL-OPEN IST: ein unbekanntes Paket (neu
 * installiert, anderer Fork mit anderem Paketnamen) darf nicht still
 * Tageskontingent fressen - der Verdacht traefe das Kind zu Unrecht. Es wird
 * als classification='unknown' gefuehrt und erscheint in GET /today als
 * unknown_min; die Eltern entscheiden ("abziehen? / Ausnahme?"). Grobe
 * Anomalie (> X h/Tag unbekannt) ist spaeter moeglich, ist hier nicht noetig.
 *
 * ROHDATEN WERDEN NIE RUECK-EDITIERT: started_at/ended_at/used_minutes bleiben,
 * wie ein Geraet sie gemeldet hat. Aendert sich eine Ausnahme, wird die
 * classification der betroffenen Sessions NEU berechnet (adjust-Philosophie wie
 * reward_ledger: korrigieren, nicht radieren).
 */

import crypto from 'node:crypto';

import { householdTimeZone, todayKey, utcToWall, daysBetweenDateKeys } from '../utils/timezone.js';

/**
 * Das Yuvomi-eigene Paket ist hart ausgenommen (fix, nicht loeschbar): das Kind
 * oeffnet die App, um seinen Rest zu sehen - diese Zeit darf nie Kontingent
 * kosten. Serverseitige Konstante, damit kein API-Aufruf sie entfernen kann.
 */
export const YUVOMI_PACKAGE = 'de.eps.yuvomi';

/** Session-Quellen, die die Tabelle akzeptiert ('win' fuer den Windows-Agent). */
export const MEDIA_TIME_SOURCES = Object.freeze(['apk', 'pwa', 'manual', 'adjust', 'backfill', 'win']);

/** Minuten, ab denen der Klient "nearing" zeigen soll (unter 5 Rest). */
export const NEARING_THRESHOLD_MIN = 5;

/** Ein Sync nimmt maximal so viele Sessions pro Aufruf an (Puffer-Schutz). */
export const MAX_SESSIONS_PER_SYNC = 200;

/** Laufende Sessions ueber dieser Dauer kappen (Minuten): vergessenes Segment. */
export const STALE_SESSION_CAP_MIN = 12 * 60;

/** Online-Definition: ein Geraet gilt als online, wenn es <= 12 h gemeldet hat. */
export const TRACKER_ONLINE_WINDOW_HOURS = 12;

// Medienzeit: Praeferenz-Schluessel (sync_config) als einzige Wahrheit fuer
// Server und UI. media_time_quiet_hours_global ist die GLOBALE
// Haushalt-Ruhezeit ('HH:MM-HH:MM', Default leer/AUS) - sichtbar fuer alle
// Haushaltsmitglieder als Signal, nie als Zwang. media_time_exchange_rate ist
// EIN Kurs fuer den ganzen Haushalt ('points:minutes', z. B. '10:15'), nie pro
// Kind. media_time_hard_cap ('1' Default = hart, '0' = kaufbar) entscheidet,
// ob max_daily_minutes hart oder erstehbar ist. media_time_enabled ist das
// Hauptregal des Haushalts (Default AUS).
export const MEDIA_TIME_ENABLED_KEY = 'media_time_enabled';
export const MEDIA_TIME_QUIET_HOURS_KEY = 'media_time_quiet_hours_global';
export const MEDIA_TIME_EXCHANGE_RATE_KEY = 'media_time_exchange_rate';
export const MEDIA_TIME_HARD_CAP_KEY = 'media_time_hard_cap';
// 'count' (Default): Server sagt nur zu, Geraete melden und sperren nichts.
// 'lock': Geraete duerfen sperren, wenn der Server exceeded oder quiet meldet
// (Nutzer 04.11.: "sind die 30min weg soll es nicht weiter gehen duerfen,
// beim PC koennte man ein logout initieren").
export const MEDIA_TIME_ENFORCEMENT_KEY = 'media_time_enforcement';

/** Der Haushalts-Enforcement-Modus: 'count' oder 'lock'. */
export function mediaTimeEnforcement(d) {
  const row = d.prepare('SELECT value FROM sync_config WHERE key = ?').get(MEDIA_TIME_ENFORCEMENT_KEY);
  return row && row.value === 'lock' ? 'lock' : 'count';
}

export function hashDeviceToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Der Tag (YYYY-MM-DD) in Haushaltszone; die Geraetuhr ist dafuer egal. */
export function mediaTimeDayKey(d, now = new Date()) {
  return todayKey(d, now);
}

/**
 * Haushaltsschalter media_time_enabled (sync_config, Default AUS): eine Familie
 * ohne Medienzeit soll den ganzen Code-Pfad nie sehen muessen.
 */
export function mediaTimeEnabled(d) {
  const row = d.prepare("SELECT value FROM sync_config WHERE key = 'media_time_enabled'").get();
  return !!row && row.value === '1';
}

/**
 * Die GLOBALE Haushalts-Ruhezeit (Praeferenz media_time_quiet_hours_global,
 * 'HH:MM-HH:MM', Default leer/AUS). Entscheidung des Nutzers: die Ruhezeit ist
 * GLOBAL pro Haushalt (nicht pro Kind) und sichtbar fuer ALLE
 * Haushaltsmitglieder (Dashboard + Kindersicht zeigen 'Ruhezeit aktiv - noch
 * X Min') - als Signal, nicht als Zwang.
 * Ueberschreitet das Fenster Mitternacht (21:00-06:00), gilt es ueber den
 * Tagwechsel hinweg.
 */
export function mediaTimeQuietWindow(d) {
  const raw = d.prepare("SELECT value FROM sync_config WHERE key = 'media_time_quiet_hours_global'").get()?.value;
  return parseQuietHours(raw);
}

/**
 * Punktetausch: EIN Kurs fuer den ganzen Haushalt (Entscheidung 2: 'ein Kurs
 * fuer alle') - nie pro Kind. Gespeichert als 'points:minutes'
 * (z. B. '10:15' = 10 Punkte bringen 15 Minuten); leer/NULL = Tausch aus.
 */
export function mediaTimeExchangeRate(d) {
  const raw = d.prepare("SELECT value FROM sync_config WHERE key = 'media_time_exchange_rate'").get()?.value;
  return parseExchangeRate(raw);
}

/** 'points:minutes' parsen; null bei leer/ungueltig. */
export function parseExchangeRate(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{1,4}):(\d{1,4})$/.exec(raw.trim());
  if (!m) return null;
  const points = Number(m[1]);
  const minutes = Number(m[2]);
  if (points < 1 || minutes < 1 || minutes > 1440) return null;
  return { points, minutes };
}

/**
 * Harter Cap (Entscheidung 4, Schalter): media_time_hard_cap, Default HART
 * ('1'). '0' = kaufbar: gekaufte Minuten heben den max_daily_minutes ueber
 * den Tag hinaus an.
 */
export function mediaTimeHardCap(d) {
  const row = d.prepare("SELECT value FROM sync_config WHERE key = 'media_time_hard_cap'").get();
  return !row || row.value !== '0';
}

/** 'HH:MM-HH:MM' parsen; null bei leer/ungueltig. */
export function parseQuietHours(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [, fh, fm, th, tm] = m;
  const from = `${fh}:${fm}`;
  const to = `${th}:${tm}`;
  if (+fh > 23 || +fm > 59 || +th > 23 || +tm > 59) return null;
  return { from, to };
}

/** Steht der Haushalt gerade in der globalen Ruhezeit? (fur jede Antwort, die
 * das Signal zeigen soll, unabhangig davon, wer fragt - Entscheidung 8.) */
export function quietWindowActive(d, now = new Date()) {
  const window = mediaTimeQuietWindow(d);
  if (!window) return false;
  return wallTimeInWindow(householdWallTime(d, now), window);
}

/** Ist eine Wanduhrzeit ('HH:MM') innerhalb des Quiet-Fensters? */
function wallTimeInWindow(hhmm, { from, to }) {
  if (from === to) return false;
  return from < to
    ? (hhmm >= from && hhmm < to)
    : (hhmm >= from || hhmm < to);
}

/** Wanduhrzeit (HH:MM) der Haushaltszone fuer einen Zeitpunkt. */
export function householdWallTime(d, now = new Date()) {
  const iso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return utcToWall(iso, householdTimeZone(d))?.time ?? iso.slice(11, 16);
}

/**
 * Geraet per Token suchen (Tracker-Pfade). Das Geraet muss einem Kind
 * gehoeren - das Geraet selbst ist die Identitaet des Kindes. Revoked: null.
 */
export function deviceByTokenHash(d, tokenHash) {
  if (typeof tokenHash !== 'string' || tokenHash.length !== 64) return null;
  const row = d.prepare(`
    SELECT dev.*, u.family_role, u.deactivated_at
    FROM media_time_devices dev
    JOIN users u ON u.id = dev.user_id
    WHERE dev.device_token_hash = ? AND dev.revoked_at IS NULL
  `).get(tokenHash);
  if (!row || row.deactivated_at) return null;
  return row;
}

/**
 * Aktive Ausnahmen fuer ein Kind: Haushalts-Default (user_id NULL) plus die
 * eigenen des Kindes. Sortiert fuer die Klassifikation: exact zuerst, dann
 * prefix mit laengstem Pattern zuerst, dann glob.
 */
export function activeExceptionRules(d, userId) {
  return d.prepare(`
    SELECT * FROM media_time_app_exceptions
    WHERE revoked_at IS NULL AND (user_id IS NULL OR user_id = ?)
  `).all(userId);
}

/**
 * Muster gegen einen Paketnamen. Saubere Patterns (nur [A-Za-z0-9._-]) werden
 * per Stringvergleich entschieden; nur Patterns mit Glob-Zeichen brauchen die
 * Regex (Uebersetzung: * -> .*, ? -> ., alles andere literal).
 */
export function packageMatches(rule, packageName) {
  if (typeof packageName !== 'string' || packageName.length === 0) return false;
  const pattern = String(rule.pattern ?? '');
  if (rule.match_type === 'exact') return packageName === pattern;
  if (rule.match_type === 'prefix') return packageName.startsWith(pattern);
  if (/^[A-Za-z0-9._-]+$/.test(pattern)) {
    if (pattern.includes('*')) {
      const parts = pattern.split('*');
      const re = new RegExp(`^${parts.map(escapeRegex).join('.*')}$`);
      return re.test(packageName);
    }
    if (pattern.includes('?')) {
      const re = new RegExp(`^${pattern.split('').map((c) => (c === '?' ? '.' : escapeRegex(c))).join('')}$`);
      return re.test(packageName);
    }
    return packageName === pattern;
  }
  const re = new RegExp(`^${pattern.split(/([*?])/).map((p) => (p === '*' ? '.*' : p === '?' ? '.' : escapeRegex(p))).join('')}$`);
  return re.test(packageName);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Die Regel, die zuerst greift (exact > prefix lang > glob), oder null.
 * "Laengster Prefix zuerst" ist hier hart kodiert: eine Ausnahme
 * 'com.example.school' gewinnt gegen 'com.example', auch wenn die kuerzere
 * zuerst angelegt wurde.
 */
export function matchExceptionRule(rules, packageName) {
  if (!packageName) return null;
  const rank = { exact: 0, prefix: 1, glob: 2 };
  const sorted = [...rules].sort((a, b) =>
    (rank[a.match_type] - rank[b.match_type])
    || (String(b.pattern).length - String(a.pattern).length));
  for (const rule of sorted) {
    if (packageMatches(rule, packageName)) return rule;
  }
  return null;
}

/**
 * Klassifikation einer gemeldeten Session bei Annahme:
 *   1. Yuvomi-Paket -> 'exempt' (hart, ohne Zeile)
 *   2. Exception-Match -> 'exempt' (exempt_from 'quota' oder 'history') oder
 *      'charged' (Gegenrichtung: Eltern-UI-Bestaetigung "Ja, abziehen")
 *   3. system_component=1 -> 'system' (fail-open, nie Abzug)
 *   4. sonst 'unknown' (NIE still abziehen)
 */
export function classifySession(d, userId, { packageName, systemComponent }) {
  if (packageName === YUVOMI_PACKAGE) {
    return { classification: 'exempt', ruleId: null, exemptFrom: 'quota' };
  }
  const rules = activeExceptionRules(d, userId);
  const rule = matchExceptionRule(rules, packageName);
  if (rule) {
    // Pflichtzeit (Busticket, Schulmanager, Hausaufgaben): zahlt NICHT gegen
    // das Kontingent und erscheint als eigener Satz 'duty' in GET /today.
    if (rule.kind === 'duty') {
      return { classification: 'duty', ruleId: rule.id, exemptFrom: 'duty' };
    }
    if (rule.exempt_from === 'charged') {
      return { classification: 'charged', ruleId: rule.id, exemptFrom: 'charged' };
    }
    return { classification: 'exempt', ruleId: rule.id, exemptFrom: rule.exempt_from };
  }
  if (systemComponent) return { classification: 'system', ruleId: null, exemptFrom: 'system' };
  return { classification: 'unknown', ruleId: null, exemptFrom: 'unknown' };
}

/**
 * Kontingent-Berechnung fuer einen Tag.
 * charged = Summe used_minutes aller Sessions des Tages mit
 * classification='charged' (exceptions exempt/system/unknown sind draussen).
 * Punktetausch: ein Kauf schreibt eine adjust-Session (classification
 * 'exempt', used_minutes = die erkauften Minuten). Diese Minuten sind dem
 * Kind GESCHENKT, nicht verbraucht - sie werden vom Verbrauch abgezogen.
 * Der Rohwert der Zeile bleibt, wie er gemeldet wurde (nie rueck-editiert);
 * die Rechenregel steht hier, nicht in der Tabelle.
 * quota = daily_minutes der media_time_quotas (fehlende Zeile = 0 Min,
 * enabled=0 = kein Kontingentspiel => state 'ok' ohne Abzugspflicht zeigen).
 */
export function dayUsage(d, userId, dayKey) {
  const row = d.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN classification = 'charged' THEN used_minutes ELSE 0 END), 0) AS charged_min,
      COALESCE(SUM(CASE WHEN classification = 'exempt' THEN used_minutes ELSE 0 END), 0) AS exempt_min,
      COALESCE(SUM(CASE WHEN classification = 'system' THEN used_minutes ELSE 0 END), 0) AS system_min,
      COALESCE(SUM(CASE WHEN classification = 'unknown' THEN used_minutes ELSE 0 END), 0) AS unknown_min,
      COALESCE(SUM(CASE WHEN classification = 'credit' THEN used_minutes ELSE 0 END), 0) AS credit_min
    FROM media_time_sessions
    WHERE user_id = ? AND minute_key = ? AND classification <> 'duty'
  `).get(userId, dayKey);
  // Pflichtzeit (Busticket, Schulmanager, Hausaufgaben): eigener Satz, zaehlt
  // nie gegen das Kontingent (classification 'duty', kein credit-Filter hier).
  const dutyRow = d.prepare(`
    SELECT COALESCE(SUM(used_minutes), 0) AS duty_min
      FROM media_time_sessions
     WHERE user_id = ? AND minute_key = ? AND classification = 'duty'
  `).get(userId, dayKey);
  /* Family-Link-Istzeit (Einbau-Spec 287): fuer ein Geraet, das auf einen
   * Google-Eintrag gemappt ist und heute einen Tageswert hat, gilt der
   * Google-Verbrauch - die Agent-Sessions desselben Geraets werden ersetzt,
   * nicht dazugerechnet (kein Doppelzaehlen). Kein Tageswert (z.B.
   * login_noetig) => keine Ersetzung, die Session-Zeit bleibt die Auskunft. */
  let flCharged = 0;
  const fl = d.prepare(
    'SELECT google_uid FROM familylink_children WHERE yuvomi_user_id = ? AND enabled = 1'
  ).get(userId);
  if (fl) {
    // Kein einziges eigenes Geraet (Telefon-Kinder ohne Agent): die Summe
    // aller gemeldeten Google-Zeilen des Tages ist der Verbrauch - sonst
    // bliebe die Istzeit ohne Balken-Wirkung, obwohl das Kind zugeordnet ist.
    const ownDevices = d.prepare(
      'SELECT COUNT(*) AS n FROM media_time_devices WHERE user_id = ? AND revoked_at IS NULL'
    ).get(userId).n;
    if (!ownDevices) {
      const all = d.prepare(
        'SELECT COALESCE(SUM(consumed_min), 0) AS m FROM familylink_daily WHERE google_uid = ? AND day = ?'
      ).get(fl.google_uid, dayKey).m;
      if (all > 0) {
        return {
          charged_min: Math.round(all),
          exempt_min: row.exempt_min,
          system_min: row.system_min,
          unknown_min: row.unknown_min,
          credit_min: row.credit_min,
          duty_min: dutyRow.duty_min,
          familylink_min: Math.round(all),
        };
      }
    }
    const flRows = d.prepare(`
      SELECT fdl.consumed_min, m.media_time_device_id
        FROM familylink_daily fdl
        JOIN familylink_device_map m
          ON m.google_uid = fdl.google_uid AND m.google_device_id = fdl.google_device_id
       WHERE fdl.google_uid = ? AND fdl.day = ? AND m.media_time_device_id IS NOT NULL
    `).all(fl.google_uid, dayKey);
    if (flRows.length) {
      const ids = flRows.map((r) => r.media_time_device_id);
      const placeholders = ids.map(() => '?').join(',');
      const sess = d.prepare(`
        SELECT COALESCE(SUM(used_minutes), 0) AS m
          FROM media_time_sessions
         WHERE user_id = ? AND minute_key = ? AND classification = 'charged'
           AND device_id IN (${placeholders})
      `).get(userId, dayKey, ...ids);
      const replaced = sess ? sess.m : 0;
      const googleSum = flRows.reduce((sum, r) => sum + (r.consumed_min || 0), 0);
      const charged = Math.max(0, row.charged_min - replaced + googleSum);
      flCharged = Math.round(googleSum);
      return {
        charged_min: charged,
        exempt_min: row.exempt_min,
        system_min: row.system_min,
        unknown_min: row.unknown_min,
        credit_min: row.credit_min,
        duty_min: dutyRow.duty_min,
        familylink_min: flCharged,
      };
    }
  }
  return {
    charged_min: row.charged_min,
    familylink_min: 0,
    exempt_min: row.exempt_min,
    system_min: row.system_min,
    unknown_min: row.unknown_min,
    credit_min: row.credit_min,
    duty_min: dutyRow.duty_min,
  };
}

/**
 * Nutzung des Tages aufgeschluesselt nach Geraet - dieselbe Grundlage, die
 * dayUsage zaehlt (GET /today: data.devices fuer die Eltern-Kacheln):
 *   - charged-Sessions (auch manuelle Buchungen) gesammelt je Geraet,
 *   - ein Geraet mit Family-Link-Tageswert wird ERSETZT, nicht dazugezaehlt
 *     (dasselbe Mapping wie dayUsage - kein Doppelzaehlen),
 *   - Kind ohne eigenes Geraet: die Google-Summe des Tages als Zeile mit
 *     device_id null (sonst bliebe die Istzeit ohne jede Zeile).
 * rows: [{ device_id (null = ohne Geraet), device_name, minutes }].
 */
export function perDeviceUsage(d, userId, dayKey) {
  const rows = d.prepare(`
    SELECT s.device_id AS device_id, dev.name AS device_name,
           COALESCE(SUM(s.used_minutes), 0) AS minutes
      FROM media_time_sessions s
      LEFT JOIN media_time_devices dev ON dev.id = s.device_id
     WHERE s.user_id = ? AND s.minute_key = ? AND s.classification = 'charged'
     GROUP BY s.device_id, dev.name
  `).all(userId, dayKey);
  const fl = d.prepare(
    'SELECT google_uid FROM familylink_children WHERE yuvomi_user_id = ? AND enabled = 1'
  ).get(userId);
  const ownDevices = d.prepare(
    'SELECT COUNT(*) AS n FROM media_time_devices WHERE user_id = ? AND revoked_at IS NULL'
  ).get(userId).n;
  if (fl && !ownDevices) {
    const all = d.prepare(
      'SELECT COALESCE(SUM(consumed_min), 0) AS m FROM familylink_daily WHERE google_uid = ? AND day = ?'
    ).get(fl.google_uid, dayKey).m;
    if (all > 0) {
      rows.push({ device_id: null, device_name: null, minutes: Math.round(all) });
    }
    return rows;
  }
  if (fl) {
    const flRows = d.prepare(`
      SELECT fdl.google_device_id, m.media_time_device_id, fdl.consumed_min
        FROM familylink_daily fdl
        JOIN familylink_device_map m
          ON m.google_uid = fdl.google_uid AND m.google_device_id = fdl.google_device_id
       WHERE fdl.google_uid = ? AND fdl.day = ? AND m.media_time_device_id IS NOT NULL
    `).all(fl.google_uid, dayKey);
    for (const f of flRows) {
      const existing = rows.find((r) => r.device_id === f.media_time_device_id);
      if (existing) existing.minutes = Math.round(f.consumed_min || 0);
      else {
        const name = d.prepare('SELECT name FROM media_time_devices WHERE id = ?').get(f.media_time_device_id)?.name ?? null;
        rows.push({ device_id: f.media_time_device_id, device_name: name, minutes: Math.round(f.consumed_min || 0) });
      }
    }
  }
  return rows;
}

/**
 * Gekaufte Minuten eines Tages: adjust-Sessions mit classification 'credit'
 * (Punktetausch, Entscheidung 2 + 4). Sie erhoehen das Kontingent des Tages,
 * sie sind kein Verbrauch - die Zeile traegt den Kauf als eigene Historie.
 */
export function dayCredit(d, userId, dayKey) {
  const row = d.prepare(`
    SELECT COALESCE(SUM(used_minutes), 0) AS credit_min
    FROM media_time_sessions
    WHERE user_id = ? AND minute_key = ? AND classification = 'credit'
  `).get(userId, dayKey);
  return row.credit_min;
}

/**
 * Eltern-Notiz: die Summe der Anpassungen (delta_minutes), die Eltern an
 * diesem Tag am Kontingent vorgenommen haben (0 wenn keine). Mehrere
 * Eintraege pro Tag sind erlaubt und summieren - die Notizen sind ein
 * Protokoll, nie ein Zustand, der ueberschrieben wird. Dieselbe Stelle im
 * Kontingent wie dayCredit: credit und Notizen heben (oder senken) den Tag,
 * beide sind kein Verbrauch.
 */
export function quotaAdjustmentFor(d, userId, dayKey) {
  const row = d.prepare(`
    SELECT COALESCE(SUM(delta_minutes), 0) AS adjusted_min
    FROM media_time_quota_notes
    WHERE user_id = ? AND day_key = ?
  `).get(userId, dayKey);
  return row.adjusted_min;
}

/**
 * Die Begruendungen eines Tages fuer die KIND-Ansicht (Transparenz: jede
 * Anpassung am Kontingent erklaert sich dem Kind). Sortiert nach created_at
 * aufsteigend, damit die letzte die neueste ist.
 */
export function quotaNoteReasons(d, userId, dayKey) {
  return d.prepare(`
    SELECT reason FROM media_time_quota_notes
    WHERE user_id = ? AND day_key = ?
    ORDER BY created_at ASC, id ASC
  `).all(userId, dayKey).map((r) => r.reason);
}

/**
 * Check-ins (Einbuchen/Ausbuchen, Nutzer 05.11.): offene Sitzungen zaehlen ab
 * started_at bis jetzt als charged Minuten, auf den Rest des Tages begrenzt.
 * Der Tag schliesst mit Mitternacht (kein Uebertrag); eine offene Sitzung, die
 * gestern startete, wird beim naechsten /today-Stand automatisch geschlossen
 * (auto), damit nie ein alter Tag weiterlaeuft.
 */
export function openCheckinMinutes(d, userId, dayKey, now = new Date()) {
  const rows = d.prepare(`
    SELECT c.id, c.started_at, dt.tz || '' AS tz
      FROM media_time_checkins c
      LEFT JOIN (SELECT value AS tz FROM sync_config WHERE key = 'timezone') dt ON 1 = 1
     WHERE c.user_id = ? AND c.ended_at IS NULL
  `).all(userId);
  if (!rows.length) return 0;
  let minutes = 0;
  for (const row of rows) {
    const started = Date.parse(row.started_at);
    if (!Number.isFinite(started)) continue;
    const dayStart = Date.parse(dayKey + 'T00:00:00Z');
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const from = Math.max(started, Number.isFinite(dayStart) ? dayStart : started);
    const to = Math.min(now.getTime(), Number.isFinite(dayEnd) ? dayEnd : now.getTime());
    if (to > from) minutes += Math.floor((to - from) / 60000);
  }
  return minutes;
}

/** Zahl offener Check-ins des Kindes (deviceId optional: nur dieses Geraet). */
export function openCheckinCount(d, userId, deviceId = null) {
  const row = deviceId
    ? d.prepare('SELECT COUNT(*) AS n FROM media_time_checkins WHERE user_id = ? AND device_id = ? AND ended_at IS NULL').get(userId, deviceId)
    : d.prepare('SELECT COUNT(*) AS n FROM media_time_checkins WHERE user_id = ? AND ended_at IS NULL').get(userId);
  return row?.n || 0;
}

/** Offene Check-ins schliessen, die nicht mehr in den heutigen Tag hoeren. */
export function closeStaleCheckins(d, userId, dayKey, now = new Date()) {
  const rows = d.prepare(
    'SELECT id, started_at FROM media_time_checkins WHERE user_id = ? AND ended_at IS NULL'
  ).all(userId);
  const dayStart = Date.parse(dayKey + 'T00:00:00Z');
  if (!Number.isFinite(dayStart)) return;
  for (const row of rows) {
    if (Date.parse(row.started_at) < dayStart) {
      d.prepare("UPDATE media_time_checkins SET ended_at = ?, end_reason = 'auto' WHERE id = ?")
        .run(isoNowSafe(now), row.id);
    }
  }
}

function isoNowSafe(now) {
  const d = now instanceof Date ? now : new Date();
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Die neueste Begruendung des Tages (GET /today braucht genau diese eine). */
export function latestQuotaNoteReason(d, userId, dayKey) {
  const row = d.prepare(`
    SELECT reason FROM media_time_quota_notes
    WHERE user_id = ? AND day_key = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(userId, dayKey);
  return row ? row.reason : null;
}

export function quotaRow(d, userId, deviceId = null) {
  // Migration 285 (A2, Nutzer 31.10.: "taegliches kontigent ggf pro geraet"):
  // eine Zeile mit device_id gilt fuer genau dieses Geraet und ueberschreibt
  // die kindweite Basis; ohne device_id (oder ohne Treffer) zaehlt die kindweite.
  if (deviceId != null) {
    const dev = d.prepare(
      'SELECT * FROM media_time_quotas WHERE user_id = ? AND device_id = ?'
    ).get(userId, deviceId);
    if (dev) return dev;
  }
  return d.prepare(
    'SELECT * FROM media_time_quotas WHERE user_id = ? AND device_id IS NULL'
  ).get(userId) ?? null;
}

/**
 * Der Zustand fuer einen Klienten (sync/heartbeat-Antwort und /today):
 * state = 'quiet' (Zeitfenster aktiv) | 'exceeded' | 'nearing' | 'ok'.
 * Quiet gewinnt - ein Fenster ist die haushaltweite Aussage "Bildschirmfreie
 * Zeit", unabhaengig vom Rest.
 */
export function quotaState(d, userId, now = new Date(), deviceId = null) {
  const dayKey = mediaTimeDayKey(d, now);
  closeStaleCheckins(d, userId, dayKey, now);
  const usage = dayUsage(d, userId, dayKey);
  // Eingebuchte Minuten (Check-in offen) zahlen wie gemeldete Nutzung: charged.
  usage.charged_min += openCheckinMinutes(d, userId, dayKey, now);
  const quota = quotaRow(d, userId, deviceId);
  // Kontingent des Tages (Entscheidung 2 + 4): Basis daily_minutes plus
  // gekaufte Minuten (adjust-Session mit classification 'credit'). Bei hartem
  // Cap (media_time_hard_cap, Default) bleibt max_daily_minutes trotzdem die
  // Obergrenze; bei kaufbarem Cap ('0') darf das Kontingent bis dorthin, oder
  // ohne Cap offen, wachsen.
  // Eltern-Notiz (Migration 284): die Anpassungen des Tages (delta_minutes der
  // media_time_quota_notes) wirken an exakt derselben Stelle wie der credit -
  // sie verschieben den Tag, sie sind kein Verbrauch. Ein Minus senkt das
  // Kontingent unter die Basis; die Basis-Zeile selbst bleibt unangetastet
  // (adjust-Philosophie: korrigieren, nicht radieren).
  const base = quota && quota.enabled === 1 ? quota.daily_minutes : 0;
  const checkedIn = openCheckinCount(d, userId, deviceId) > 0;
  const credit = dayCredit(d, userId, dayKey);
  const adjusted = quotaAdjustmentFor(d, userId, dayKey);
  // Die Obergrenze des Tages (Entscheidung 4): bei hartem Cap (Default) ist
  // max_daily_minutes die Obergrenze fuer credit und positive Notizen -
  // dieselbe Klammer wie bisher. Ein Minus der Eltern senkt den Tag dagegen
  // von der BASIS aus (bis auf 0): wer 180 von 240 erlaubt, soll dem Kind
  // nicht versehentlich nur noch die Cap-Reste lassen. Ein negatives Ergebnis
  // der Summe waere kein Kontingent - der Boden ist 0.
  const hardCap = mediaTimeHardCap(d);
  // Das Minus der Eltern setzt VOR der Cap-Klammer an der Basis an: wer den
  // Tag von 180 (bei Cap 240) auf 0 dreht, dem darf die Cap-Klammer nicht
  // wieder 180 zurueckgeben. Positives (credit + Plus-Notizen) klaammert wie
  // bisher unter dem Cap.
  const negative = Math.min(0, adjusted);
  let quotaMin = Math.max(0, base + negative) + credit + Math.max(0, adjusted);
  // Ein negatives Kontingent gibt es nicht - der Boden bleibt 0.
  quotaMin = Math.max(0, quotaMin);
  if (hardCap && quota && quota.max_daily_minutes != null) {
    quotaMin = Math.min(quotaMin, quota.max_daily_minutes);
  }
  const remaining = Math.max(0, quotaMin - usage.charged_min);
  const quiet = mediaTimeQuietWindow(d);
  const quietActive = quiet ? wallTimeInWindow(householdWallTime(d, now), quiet) : false;
  let state = 'ok';
  if (quietActive) state = 'quiet';
  else if (quotaMin > 0 && remaining <= 0) state = 'exceeded';
  else if (quotaMin > 0 && remaining < NEARING_THRESHOLD_MIN) state = 'nearing';
  return {
    day: dayKey,
    quota_min: quotaMin,
    used_min: usage.charged_min,
    remaining_min: remaining,
    charged_min: usage.charged_min,
    exempt_min: usage.exempt_min,
    unknown_min: usage.unknown_min,
    purchased_min: credit,
    adjusted_min: adjusted,
    duty_min: usage.duty_min,
    max_daily_minutes: quota?.max_daily_minutes ?? null,
    hard_cap: hardCap,
    quiet_active: quietActive,
    checked_in: checkedIn,
    enforcement: mediaTimeEnforcement(d),
    // 'lock' heisst: ein Geraet darf sperren, wenn state 'exceeded' oder
    // 'quiet' ist (Nachricht "Zeit ist um", PC: Logout). 'count' = reine Meldespur.
    state,
  };
}

/**
 * Klassifikation ALLER Sessions eines Kindes neu berechnen (nach
 * Exception-Aenderung). Die Rohwerte bleiben; nur classification und
 * exception_rule_id wandern. returns: Anzahl betroffener Zeilen.
 */
export function reclassifyForUser(d, userId) {
  // package_name IS NULL faehlt hier bewusst NICHT als Ausschluss: eine
  // Rohzeile ohne Paket ist per Definition 'unknown' (fail-open) und muss
  // mitwandern, sobald eine Regel greift oder eine Regel zurueckgenommen
  // wird - sonst bleibt die Klassifikation still stehen. Der Ausschluss
  // waere ausserdem ein Loch gegenueber pruneRawSessions (das ohne
  // Paket-Bedingung loescht): eine Session koennte aus der Neueklassifikation
  // entkommen und trotzdem aus der Aufbewahrung fallen.
  const rows = d.prepare(`
    SELECT id, package_name, system_component, classification, exception_rule_id FROM media_time_sessions
    WHERE user_id = ? AND classification <> 'credit'
  `).all(userId);
  const rules = activeExceptionRules(d, userId);
  const write = d.prepare('UPDATE media_time_sessions SET classification = ?, exception_rule_id = ? WHERE id = ?');
  let changed = 0;
  for (const row of rows) {
    let next = { classification: 'unknown', ruleId: null };
    if (row.package_name === YUVOMI_PACKAGE) next = { classification: 'exempt', ruleId: null };
    else {
      const rule = matchExceptionRule(rules, row.package_name);
      if (rule) {
        next = rule.exempt_from === 'charged'
          ? { classification: 'charged', ruleId: rule.id }
          : { classification: 'exempt', ruleId: rule.id };
      } else if (row.system_component) {
        next = { classification: 'system', ruleId: null };
      }
    }
    // 'changed' zaehlt NUR echte inhaltliche Wanderungen (Zeile 1: 'nur die
    // Zeile mit dem unbekannten Paket wandert'). Ein Satz, der den Zustand nur
    // bestaetigt oder die Regel-Id nachtraegt (exception_rule_id fehlte bei
    // Erstanlage), ist keine Aenderung der Klassifikation und zaehlt nicht mit.
    if (String(row.classification ?? '') !== String(next.classification)
      || (row.exception_rule_id ?? null) !== (next.ruleId ?? null)) {
      write.run(next.classification, next.ruleId, row.id);
      changed += 1;
    } else if ((row.exception_rule_id ?? null) === null && next.ruleId !== null) {
      // Wertgleich, aber die Regel-Id kann fehlen (exact-Regel vor Erstanlage):
      // sicherheitshalber schreiben, ohne dass es als Aenderung zaehlt.
      write.run(next.classification, next.ruleId, row.id);
    }
  }
  return changed;
}

/**
 * Version der aktiven Ausnahmen fuer einen Klienten-Cache: eine Zahl, die sich
 * bei jeder Anlegung/Ruecknahme aendert (max id, Revocations zaehlen mit).
 * Deterministisch und guenstig.
 */
export function exceptionsVersion(d) {
  const row = d.prepare(`
    SELECT COALESCE(MAX(id), 0) AS max_id,
           COALESCE(SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS revoked_n
    FROM media_time_app_exceptions
  `).get();
  return row.max_id * 1000 + row.revoked_n;
}

/**
 * Aufbewahrung der Rohzeiten (Entscheidung 6: Paket + Start/Ende, ~90 Tage).
 * Loescht NUR Sessions aelter als der Aufbewahrungszeitraum (minute_key alt,
 * created_at alt - beide, damit eine spaete Nachmeldung eines alten Tages
 * nicht sofort faellt). Der Aggregat bleibt: dayUsage liest danach 0, und die
 * Dashboard-Zahlen stehen in keiner Tabelle, die hiervon abhaengt. Laeuft bei
 * Bedarf (Scheduler kann sie spaeter aufrufen); ein Lauf ist idempotent.
 */
export const RAW_RETENTION_DAYS = 90;

export function pruneRawSessions(d, now = new Date()) {
  const cutoff = new Date(now.getTime() - RAW_RETENTION_DAYS * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const cutoffDay = new Date(now.getTime() - RAW_RETENTION_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const info = d.prepare(
    "DELETE FROM media_time_sessions WHERE created_at < ? AND minute_key < ? AND classification <> 'credit'",
  ).run(cutoff, cutoffDay);
  return info.changes;
}

/** Tracker-Status fuer GET /today: letztes Geraet des Kindes, online-Flag. */
export function trackerStatus(d, userId, now = new Date()) {
  const device = d.prepare(`
    SELECT last_seen_at FROM media_time_devices
    WHERE user_id = ? AND revoked_at IS NULL
    ORDER BY (last_seen_at IS NULL) ASC, last_seen_at DESC
    LIMIT 1
  `).get(userId);
  let online = false;
  if (device?.last_seen_at) {
    const seen = new Date(device.last_seen_at).getTime();
    online = Number.isFinite(seen) && (now.getTime() - seen) <= TRACKER_ONLINE_WINDOW_HOURS * 3600 * 1000;
  }
  return { last_seen_at: device?.last_seen_at ?? null, online };
}
