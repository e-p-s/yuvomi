/**
 * Family-Link-Istzeit (Einbau-Spec HANDOVER.md, Commit dc62917df).
 *
 * Zweck: die ECHTEN Nutzungszeiten aus Google Family Link in die Medienzeit
 * einspeisen (Anforderung A5: "Anbindung Google Family Link API, nur abfragen,
 * nie fernsperren"). Der Collector (scripts/familylink/familyhub_screen.py)
 * liefert pro Kind und Geraet Limit/Verbrauch/Rest/Downtime; dieser Dienst
 * upsertet den Tagesstand nach `familylink_daily` und haelt den Status.
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

/** Der Status-Key und seine Zeitmarke (sync_config-Muster wie media_time_*). */
const STATUS_KEY = 'familyli…us';
const STATUS_AT_KEY = 'famil…_at';
export const FAMILYLINK_STATUS_KEYS = { status: STATUS_KEY, at: STATUS_AT_KEY };

/** Der Sammelstatus: 'ok' | 'login_noetig' | null (nie gelaufen). */
export function familylinkStatus(d) {
  const row = d.prepare('SELECT value FROM sync_config WHERE key = ?').get(STATUS_KEY);
  return row ? row.value : null;
}

export function setStatus(d, value) {
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

/**
 * Ein Collector-Report (JSON von familyhub_screen.py --json) in
 * familylink_daily. Nur zugeordnete Kinder (familylink_children, enabled) und
 * nur zugeordnete Geraete (familylink_device_map) werden geschrieben -
 * nicht zugeordnete bleiben ungefragt draussen. Kinder ohne Geratezeile
 * (Report-Fehler 'template nicht abhoerbar') ueberspringt der Lauf still;
 * sie sind kein 0er-Snapshot, sondern keine Aussage.
 * @returns {{written: number, childrenSeen: number, errors: number}}
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
  const childStmt = d.prepare(
    'SELECT yuvomi_user_id FROM familylink_children WHERE google_uid = ? AND enabled = 1'
  );
  let written = 0;
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
  }
  return { written, childrenSeen: report.children.length, errors };
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
    setStatus(d, 'login_noetig');
    return { ok: false, written: 0, status: 'login_noetig' };
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
 * Die Istzeit eines Kindes an einem Tag (lesende Route). Ohne Zuordnung:
 * mapped=false und leere Liste - die Seite behauptet dann nichts. Der Status
 * kommt mit, damit die UI 'login_noetig' als Hinweis zeigen kann statt Null.
 */
export function familylinkUsage(d, userId, day) {
  const child = d.prepare(
    'SELECT google_uid, display_name, enabled FROM familylink_children WHERE yuvomi_user_id = ?'
  ).get(userId);
  const statusRow = d.prepare('SELECT value FROM sync_config WHERE key = ?').get(STATUS_KEY);
  const status = statusRow ? statusRow.value : null;
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
