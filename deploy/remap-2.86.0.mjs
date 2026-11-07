#!/usr/bin/env node
/**
 * Umschreibung der schema_migrations nach dem Merge auf v2.86.0.
 *
 * WARUM. Vor dem Merge lief der Fork-Zweig mit eigenen Migrationsnummern 278-288.
 * Der Merge hat die offiziellen 278-282 übernommen und unsere 279-288 auf
 * 283-292 gehoben (unsere alte 278 fiel weg: byte-identisch mit dem offiziellen
 * 282, unser Spaetabzug-Patch ist als #2413 upstreamed). Der Migrations-Laeufer
 * entscheidet aber rein nach der Versionsnummer: ohne diese Umschreibung haette
 * eine Prod-DB die Nummern 278-281 an UNSERE Migrationen vergeben, die
 * offiziellen blieben aus - es fehlten `tasks.external_rrule`,
 * `calendar_events.provider_status`, die Preis-Historie und
 * `display_accounts.device_settings`, obwohl die Spalten-Spiegel sie erwarten.
 * Und schlimmer: der Laeufer hielte unsere 289-292 fuer offen und wollte sie auf
 * eine Datenbank loslassen, in der sie laengst gelaufen sind - der Probelauf auf
 * einer Prod-Kopie zeigte dafuer `duplicate column name: kind`.
 *
 * WARUM HIER EIGENE VERBINDUNG. Dieses Skript darf auf KEINEN Fall
 * `server/db.js` importieren: das Modul wandert beim Import sofort
 * (`init()` -> `migrate()`), und genau das ist der Fehler oben. Es oeffnet die
 * Datei deshalb selbst, mit demselben Cipher-Handschlag wie der Dienst
 * (`cipher = 'sqlcipher'`, Schluessel als Hex), und ruehrt keine Migration an.
 *
 * REIHENFOLGE BEIM DEPLOY. Dienst stoppen -> dieses Skript (--write) -> neue
 * Fassung starten. Der Start der neuen Fassung auf dem ungeschriebenen Stand
 * scheitert (siehe oben), ein Rollback auf die alte Fassung nach dem Schreiben
 * meldet "Datenbank ist neuer als der Code" - beides gefaehrlos, beides bleibt
 * unveraendert.
 *
 * NUTZUNG. Im App-Verzeichnis, Umgebung wie der Dienst (DB_PATH,
 * DB_ENCRYPTION_KEY):
 *   node deploy/remap-2.86.0.mjs            # zeigt nur, was passieren wuerde
 *   node deploy/remap-2.86.0.mjs --write    # Backup + Umschreibung
 * Idempotent: ein zweiter Lauf findet den Zielzustand und tut nichts.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { resolveDbPath } from '../server/utils/db-path.js';

const WRITE = process.argv.includes('--write');
const OURS = [279, 280, 281, 282, 283, 284, 285, 286, 287, 288]; // alte Fork-Nummern
const SHIFT = 4; // 279 -> 283 ... 288 -> 292
// Die neuen Beschreibungen muessen zu den Migriationsobjekten im Code passen.
// Absichtlich hier abgelegt (und nicht aus server/db.js gelesen): siehe oben.
const DESCRIPTIONS = {
  283: 'rewards: optional consequences (penalty ledger type)',
  284: 'tasks: parental approval of completion',
  285: 'media time: devices and quotas (server-side ledger, trustee model)',
  286: 'media time: usage sessions, app exceptions, device inventory (classification)',
  287: 'rewards: consequence catalog (editable penalty templates)',
  288: "media time: quota adjustment notes (parent edits today's quota with a reason)",
  289: 'media time: enforcement flag, app duty/exempt rule kinds, per-device quota',
  290: 'media time: check-in (check-in/check-out) per device, for agents without an OS integration',
  291: 'family link: istzeit-collector tables (mapping + daily usage) for media time',
  292: 'media time: per-device quota upserts (unique (user_id, device_id), partial unique global row)',
};

const { dbPath } = resolveDbPath();
const key = process.env.DB_ENCRYPTION_KEY;

function open(readonly) {
  const db = new Database(dbPath, { readonly });
  if (key) {
    db.pragma("cipher = 'sqlcipher'");
    db.pragma(`key="x'${Buffer.from(key, 'utf8').toString('hex')}'"`);
  }
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (err) {
    db.close();
    throw new Error(
      `${dbPath} ist nicht lesbar (${err.message}). ` +
      (key ? 'Der gesetzte DB_ENCRYPTION_KEY passt nicht zu dieser Datei.'
           : 'Die Datei sieht verschluesselt aus - DB_ENCRYPTION_KEY setzen (steht in .env).'),
      { cause: err });
  }
  return db;
}

console.log(`Datenbank: ${dbPath}`);
const db = open(!WRITE);
const rows = db.prepare('SELECT version, description, applied_at FROM schema_migrations ORDER BY version').all();
const have = new Set(rows.map((r) => r.version));
const show = (label, list) => {
  console.log(`${label}:`);
  for (const r of list) console.log(`  ${r.version}  ${r.description}`);
};

if (have.has(289) || have.has(292)) {
  console.log('Kein Umschreiben noetig: Zielzustand (283-292) ist bereits eingetragen.');
  db.close();
  process.exit(0);
}
const stale = OURS.filter((v) => !have.has(v));
if (stale.length) {
  console.error(`Abbruch: fuer den Fork-Zweig werden 279-288 erwartet, es fehlt ${stale.join(', ')}.`);
  console.error('Diese Datenbank ist nicht der erwartete Stand vor dem Merge - nichts veraendert.');
  db.close();
  process.exit(1);
}
const missing = OURS.map((old) => old + SHIFT).filter((to) => !DESCRIPTIONS[to]);
if (missing.length) {
  console.error(`Abbruch: Beschreibung fuer ${missing.join(', ')} fehlt im Skript.`);
  db.close();
  process.exit(1);
}

show('weg (alte Fork-Nummern 278-288)', rows.filter((r) => r.version >= 278 && r.version <= 288));
show('neu (283-292, dieselben Migrationen, gleicher applied_at)',
  OURS.map((old) => ({ version: old + SHIFT, description: DESCRIPTIONS[old + SHIFT] })));
console.log('und beim naechsten Start: offiziell 278-281 (das erste Mal) + 282 (PRAGMA-gesichert, No-op)');
console.log(`Stand vorher: groesste Nummer ${Math.max(...rows.map((r) => r.version))}, ${rows.length} Zeilen`);

if (!WRITE) {
  console.log('\nTrockenlauf - nichts geaendert. Mit --write ausfuehren (Dienst anhalten).');
  db.close();
  process.exit(0);
}
db.close();

// --- Schreiben ---
const rw = open(false);
try {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backup = `/tmp/yuvomi-pre-remap-2.86-${stamp}.db`;
  await fs.rm(backup, { force: true });
  // VACUUM INTO vor der Transaktion: VACUUM laeuft nicht innerhalb einer.
  // Es erbt Cipher und Schluessel der Quelle, das Backup ist also verschluesselt.
  rw.prepare('VACUUM INTO ?').run(backup);
  console.log(`\nBackup: ${backup}`);
  // BEGIN IMMEDIATE: wer gerade schreibt (laufender Dienst), haelt genau hier fest.
  rw.exec('BEGIN IMMEDIATE');
  rw.prepare('DELETE FROM schema_migrations WHERE version BETWEEN 278 AND 288').run();
  const insert = rw.prepare('INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)');
  const times = new Map(OURS.map((old) => [old, rows.find((r) => r.version === old)?.applied_at]));
  for (const old of OURS) insert.run(old + SHIFT, DESCRIPTIONS[old + SHIFT], times.get(old));
  rw.exec('COMMIT');
  const after = rw.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
  const frei = [];
  for (let v = 1; v <= Math.max(...after); v++) if (!after.includes(v)) frei.push(v);
  console.log(`Nachher: ${after.length} Zeilen, groesste Nummer ${Math.max(...after)}.`);
  console.log(`Frei (laufen beim Start): ${frei.join(', ') || 'keine'}`);
  console.log('Naechster Schritt: neue Fassung starten - sie meldet "Migration 278..282 applied" und endet bei v292.');
} catch (err) {
  try { rw.exec('ROLLBACK'); } catch { /* Transaktion ist schon zu */ }
  console.error(`Abbruch, nichts geschrieben: ${err.message}`);
  rw.close();
  process.exit(1);
}
rw.close();
