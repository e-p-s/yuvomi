/**
 * Family-Link-Istzeit (Einbau-Spec HANDOVER.md, Commit dc62917df).
 *
 * Zweck: die ECHTEN Nutzungszeiten aus Google Family Link in die Medienzeit
 * einspeisen (Anforderung A5: "Anbindung Google Family Link API, nur abfragen,
 * nie fernsperren"). Der Collector (scripts/familylink/familyhub_screen.py)
 * liefert pro Kind und Geraet Limit/Verbrauch/Rest/Downtime; dieser Dienst
 * upsertet den Tagesstand nach `familylink_daily` und haelt den Status.
 * Seit A2 liefert der Collector zusaetzlich pro Kind eine App-Liste
 * (`children[].apps`, drei Formen: Paar-Array, Objekt-Array, Objekt-Map) -
 * sie kommt nach `familylink_app_usage` und zaehlt nicht in `written`.
 *
 * Grundregeln (Spec, Datenschutz):
 * - Nur lesen/abfragen - ein Rueckschreibpfad zu Google existiert hier nicht.
 * - 401/Fehlerfall schreibt NIE 0er-Snapshots: fehlgeschlagene Laeufe setzen
 *   nur den Status `login_noetig`; die UI zeigt den Hinweis statt einer Null.
 * - Google-Session/Cookies bleiben auf dem Collector-Host (~/.familyhub, 0600) -
 *   dieser Dienst kennt und speichert keine Cookies.
 * - KIND-Namen: der Report enthaelt Anzeigenamen aus Google; sie werden nicht
 *   in Logs geschrieben und nur in die Zuordnungstabelle aufgenommen (die
 *   Zuordnung ist Nutzerdaten im verschluesselten Kern, nicht im Repo).
 * Ausfuehren der Suite: node --experimental-sqlite --test test/test-familylink.js
 */

import { spawn } from 'node:child_process';

import { createLogger } from '../../logger.js';
import { activeAccountSql } from '../../services/account-state.js';
import { pushService as defaultPushService } from '../../services/push.js';
import { createNotificationChannelStore } from '../../services/notification-channels.js';
import { defaultProviders } from '../../services/notifications.js';

const log = createLogger('Familylink');

/** Der Status-Key und seine Zeitmarke (sync_config-Muster wie media_time_*). */
const STATUS_KEY = 'familylink_status';
const STATUS_AT_KEY = 'familylink_status_at';
export const FAMILYLINK_STATUS_KEYS = { status: STATUS_KEY, at: STATUS_AT_KEY };

/** Meldung beim Wechsel ok -> login_noetig (feste deutsche Vorgabe der Spec). */
export const FAMILYLINK_LOGIN_ALERT = {
  title: 'Family-Link-Verbindung abgelaufen',
  body: 'Bitte in den Medienzeit-Regeln erneut anmelden.',
  url: '/media-time',
};

/**
 * Die Altschluessel (self-healing-Migration, kein Deploy-Schritt): die erste
 * Fassung enthielt versehentlich echte U+2026-Zeichen statt Unterstrichen.
 * Beim ersten Zugriff (Lese- wie Schreibpfad) gilt: existiert ein Alt-Key und
 * der neue noch nicht -> Wert umziehen, alt loeschen; existieren beide ->
 * der neue gewinnt, alt loeschen. Idempotent: ohne Alt-Zeilen passiert nichts.
 */
const LEGACY_STATUS_KEY = 'familyli\u2026us';
const LEGACY_STATUS_AT_KEY = 'famil\u2026_at';

export function migrateLegacyStatusKeys(d) {
  const legacy = d.prepare(
    'SELECT key, value FROM sync_config WHERE key IN (?, ?)'
  ).all(LEGACY_STATUS_KEY, LEGACY_STATUS_AT_KEY);
  if (legacy.length === 0) return;
  const getNew = d.prepare('SELECT 1 AS hit FROM sync_config WHERE key = ?');
  const copy = d.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?)');
  const del = d.prepare('DELETE FROM sync_config WHERE key = ?');
  for (const row of legacy) {
    const target = row.key === LEGACY_STATUS_KEY ? STATUS_KEY : STATUS_AT_KEY;
    // existieren beide: der neue gewinnt - nur der Alt-Key verschwindet.
    if (!getNew.get(target)) copy.run(target, row.value);
    del.run(row.key);
  }
}

/** Der Sammelstatus: 'ok' | 'login_noetig' | null (nie gelaufen). */
export function familylinkStatus(d) {
  migrateLegacyStatusKeys(d);
  const row = d.prepare('SELECT value FROM sync_config WHERE key = ?').get(STATUS_KEY);
  return row ? row.value : null;
}

export function setStatus(d, value) {
  migrateLegacyStatusKeys(d);
  d.prepare(`
    INSERT INTO sync_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(STATUS_KEY, value);
  d.prepare(`
    INSERT INTO sync_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(STATUS_AT_KEY, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Minuten einer App-Zeile: endliche Zahl >= 0 (Zahlen-String erlaubt), sonst null. */
function toAppMinutes(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

/** Anzeige-Name: String (<= 200) oder NULL. */
function toAppName(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, 200);
}

/**
 * report.children[].apps in eine Liste {pkg, name, minutes} normalisieren.
 * Der Collector darf drei Formen liefern: Paar-Array [pkg, {name, minutes}],
 * Objekt-Array {pkg, name, minutes} oder Objekt-Map pkg -> {name, minutes}.
 * Unsaubere Eintraege (pkg kein String 1..200, minutes keine endliche Zahl
 * >= 0) fallen hier still raus - der Ingest schreibt nur tragfaehige Zeilen.
 */
export function normalizeAppEntries(apps) {
  const out = [];
  const push = (pkgRaw, val) => {
    if (typeof pkgRaw !== 'string') return;
    const pkg = pkgRaw.trim();
    if (pkg === '' || pkg.length > 200) return;
    const minutes = toAppMinutes(val?.minutes);
    if (minutes == null) return;
    out.push({ pkg, name: toAppName(val?.name), minutes });
  };
  if (Array.isArray(apps)) {
    for (const entry of apps) {
      if (Array.isArray(entry)) push(entry[0], entry[1]);
      else if (entry && typeof entry === 'object') push(entry.pkg, entry);
    }
  } else if (apps && typeof apps === 'object') {
    for (const [pkg, val] of Object.entries(apps)) push(pkg, val);
  }
  return out;
}

/**
 * Ein Collector-Report (JSON von familyhub_screen.py --json) in
 * familylink_daily. Nur zugeordnete Kinder (familylink_children, enabled) und
 * nur zugeordnete Geraete (familylink_device_map) werden geschrieben -
 * nicht zugeordnete bleiben ungefragt draussen. Kinder ohne Geratezeile
 * (Report-Fehler 'template nicht abhoerbar') ueberspringt der Lauf still;
 * sie sind kein 0er-Snapshot, sondern keine Aussage.
 * @returns {{written: number, usage_written: number, childrenSeen: number, errors: number}}
 */
export function ingestFamilylinkReport(d, report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.children)) {
    throw new Error('familylink: Report ohne children-Liste');
  }
  const day = String(report.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error('familylink: Report ohne gueltiges Datum');
  }
  const fetchedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const upsert = d.prepare(`
    INSERT INTO familylink_daily (google_uid, google_device_id, day, limit_min,
      consumed_min, remaining_min, downtime, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(google_uid, google_device_id, day) DO UPDATE SET
      limit_min = excluded.limit_min,
      consumed_min = excluded.consumed_min,
      remaining_min = excluded.remaining_min,
      downtime = excluded.downtime,
      fetched_at = excluded.fetched_at
  `);
  // A2: App-Ebene (familylink_app_usage). eigener Zaehler - die App-Zeilen
  // zaehlen NICHT in written (der bleibt geraete-bezogen, wie bisher).
  const upsertApp = d.prepare(`
    INSERT INTO familylink_app_usage (day, google_uid, pkg, name, minutes, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, google_uid, pkg) DO UPDATE SET
      name = excluded.name,
      minutes = excluded.minutes,
      fetched_at = excluded.fetched_at
  `);
  const childStmt = d.prepare(
    'SELECT yuvomi_user_id FROM familylink_children WHERE google_uid = ? AND enabled = 1'
  );
  let written = 0;
  let usageWritten = 0;
  let errors = 0;
  for (const child of report.children) {
    if (!child || child.error) { errors += 1; continue; }
    const uid = String(child.userId ?? '');
    if (!uid || !childStmt.get(uid)) continue; // nicht zugeordnet: keine Zeile
    for (const dev of (Array.isArray(child.devices) ? child.devices : [])) {
      const gDevId = String(dev?.id ?? '');
      if (!gDevId) continue;
      // Ein zugeordnetes Kind schreibt seine Geraete auch ohne Geraet-Link:
      // die UI zeigt sie als "gemeldete Google-Geraete" zum Zuordnen. Ohne
      // Link zaehlen sie nicht in den Balken (dayUsage verlangt den Link).

      const limit = toNum(dev.allowed_min);
      const consumed = toNum(dev.consumed_min);
      const remaining = toNum(dev.remaining_min);
      // Ohne eine einzige Zahl waere die Zeile eine Falsaussage - weglassen.
      if (limit == null && consumed == null && remaining == null) continue;
      upsert.run(uid, gDevId, day, limit, consumed, remaining,
        child.downtime != null ? String(child.downtime) : null, fetchedAt);
      written += 1;
    }
    // Apps (A2): nur bei zugeordneten Kindern, Form egal (Paar-Array,
    // Objekt-Array, Objekt-Map) - unsaubere Eintraege verwirft die Norm.
    for (const app of normalizeAppEntries(child.apps)) {
      upsertApp.run(day, uid, app.pkg, app.name, app.minutes, fetchedAt);
      usageWritten += 1;
    }
  }
  return { written, usage_written: usageWritten, childrenSeen: report.children.length, errors };
}

/**
 * Der gesammelte Lauf: Collector-Kommandos ausfuehren, Report einarbeiten.
 * Fehlerfall (Exit ungleich 0, kein JSON, 401-Fernwirkung): Status
 * `login_noetig`, KEIN Snapshot - die Regel des Einbau-Specs.
 * @param {Function} [runner] Test-Haendler: fuehrt das Kommando aus und liefert
 *   {ok, report} - ohne ihn laeuft der echte Collector als Prozess.
 */
export async function runFamilylinkIngest(d, { command, runner } = {}) {
  let ok = false;
  let report = null;
  try {
    if (runner) {
      const res = await runner();
      ok = !!res?.ok;
      report = res?.report ?? null;
    } else {
      report = await runCollectorProcess(command);
      ok = true;
    }
  } catch {
    ok = false;
    report = null;
  }
  if (!ok || !report) {
    // Ein fehlgeschlagener lokaler Pull ueberschreibt keinen frischen Push:
    // auf dem Collector-Host liefert der 5-Minuten-Cron (familylink_push.sh)
    // die Daten — erst wenn dessen letzter Erfolg laenger als zwei Takte
    // plus Puffer her ist, darf der Fehl-Fall den Status kippen (07.11.:
    // der Takt auf CT135 machte jeden Push-Erfolg zunichtezurueck).
    const at = d.prepare('SELECT value FROM sync_config WHERE key = ?')
      .get(STATUS_AT_KEY)?.value;
    const ageMin = at ? (Date.now() - Date.parse(at)) / 60_000 : Infinity;
    if (ageMin >= 12) setStatus(d, 'login_noetig');
    return { ok: false, written: 0, status: familylinkStatus(d) ?? 'login_noetig' };
  }
  try {
    const r = ingestFamilylinkReport(d, report);
    setStatus(d, 'ok');
    return { ok: true, written: r.written, status: 'ok' };
  } catch {
    // Ein unlesbarer Report ist kein 0er-Beweis: nur der Status aendert sich.
    setStatus(d, 'login_noetig');
    return { ok: false, written: 0, status: 'login_noetig' };
  }
}

/** Der echte Collector-Aufruf (nur auf dem Collector-Host mit Session). */
function runCollectorProcess(command) {
  const cmd = command || 'python3 scripts/familylink/familyhub_screen.py --json';
  return new Promise((resolve, reject) => {
    const [bin, ...args] = cmd.split(' ');
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('familylink: Collector-Lauf endet ohne Antwort (timeout)'));
    }, 120_000);
    timer.unref();
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`familylink: Collector-Exit ${code}`)); return; }
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

/**
 * Die App-Liste eines Tages (lesende Route, A2). Alle gesammelten Zeilen,
 * sortiert minutes DESC, Limit 100. yuvomi_user_id ueber die aktive Kind-
 * Zuordnung (enabled=1) - Kinder ohne Zuordnung bleiben mit NULL sichtbar
 * (der Report ist die Auskunft, die Zuordnung ist Eltern-Entscheidung).
 * Spec: keine Kind-Namen - nur uid + user-id.
 */
export function familylinkAppUsage(d, day) {
  const rows = d.prepare(`
    SELECT a.google_uid, c.yuvomi_user_id, a.pkg, a.name, a.minutes
      FROM familylink_app_usage a
      LEFT JOIN familylink_children c
        ON c.google_uid = a.google_uid AND c.enabled = 1
     WHERE a.day = ?
     ORDER BY a.minutes DESC
     LIMIT 100
  `).all(day);
  return rows.map((r) => ({
    google_uid: r.google_uid,
    yuvomi_user_id: r.yuvomi_user_id ?? null,
    pkg: r.pkg,
    name: r.name ?? null,
    minutes: r.minutes,
  }));
}

/**
 * Die Istzeit eines Kindes an einem Tag (lesende Route). Ohne Zuordnung:
 * mapped=false und leere Liste - die Seite behauptet dann nichts. Der Status
 * kommt mit, damit die UI 'login_noetig' als Hinweis zeigen kann statt Null.
 */
export function familylinkUsage(d, userId, day) {
  const child = d.prepare(
    'SELECT google_uid, display_name, enabled FROM familylink_children WHERE yuvomi_user_id = ?'
  ).get(userId);
  const status = familylinkStatus(d);
  if (!child || child.enabled !== 1) {
    return { mapped: false, status, devices: [] };
  }
  const rows = d.prepare(`
    SELECT fdl.google_device_id, fdl.day, fdl.limit_min, fdl.consumed_min,
           fdl.remaining_min, fdl.downtime, fdl.fetched_at,
           m.media_time_device_id, dev.name AS device_name
      FROM familylink_daily fdl
      LEFT JOIN familylink_device_map m
        ON m.google_uid = fdl.google_uid AND m.google_device_id = fdl.google_device_id
      LEFT JOIN media_time_devices dev ON dev.id = m.media_time_device_id
     WHERE fdl.google_uid = ? AND fdl.day = ?
     ORDER BY dev.name COLLATE NOCASE
  `).all(child.google_uid, day);
  return {
    mapped: true,
    status,
    devices: rows.map((r) => ({
      google_device_id: r.google_device_id,
      media_time_device_id: r.media_time_device_id,
      device_name: r.device_name ?? null,
      day: r.day,
      limit_min: r.limit_min,
      consumed_min: r.consumed_min,
      remaining_min: r.remaining_min,
      downtime: r.downtime,
      fetched_at: r.fetched_at,
    })),
  };
}

/**
 * Eltern/Admins melden, dass die Google-Sitzung des Sammlers abgelaufen ist —
 * Muster medication-scheduler.js: Web Push ueber den bestehenden Engpass
 * (pushService) plus die aktivierten Notification-Channels der Person.
 * Aufgerufene Stelle ist die Status-Annahme in routes/familylink-report.js
 * (Wechsel von 'ok' nach 'login_noetig'); Titel und Text sind die feste
 * deutsche Vorgabe der Spec. Empfaenger sind die Verwaltung des Haushalts —
 * Kinder bekommen die Meldung nicht (sie koennen nichts anmelden).
 * @param {Function} [deps.push] Test-Haendler: async (userId, payload) => number
 * @param {Object} [deps.channelStore] { listEnabledChannelsForUser } - ohne ihn
 *   und ohne push laeuft die Meldung gegen den echten Dienst (Produktionspfad).
 */
export async function notifyFamilylinkLoginNeeded(d, { push, channelStore, providers = defaultProviders } = {}) {
  const pushFn = push || ((userId, payload) => defaultPushService.sendPushToUser(userId, payload));
  const store = channelStore
    ?? (push ? { listEnabledChannelsForUser: () => [] } : createNotificationChannelStore({ db: d }));
  const recipients = d.prepare(
    `SELECT id FROM users
      WHERE (role = 'admin' OR family_role IN ('dad', 'mom', 'parent'))
        AND ${activeAccountSql('users')}`
  ).all();
  const payload = { ...FAMILYLINK_LOGIN_ALERT, tag: 'familylink-login-noetig', priority: 'default' };
  let sent = 0;
  for (const r of recipients) {
    try {
      const n = await pushFn(r.id, payload);
      if (n > 0) sent += n;
    } catch (err) {
      log.warn(`familylink: Web Push an ${r.id} fehlgeschlagen:`, err?.message || err);
    }
    for (const channel of store.listEnabledChannelsForUser(r.id)) {
      const provider = providers[channel.provider];
      if (!provider) continue;
      try {
        await provider.send({ channel, payload });
        sent += 1;
      } catch (err) {
        log.warn(`familylink: Channel-Zustellung an ${r.id} fehlgeschlagen:`, err?.message || err);
      }
    }
  }
  return { recipients: recipients.length, sent };
}
