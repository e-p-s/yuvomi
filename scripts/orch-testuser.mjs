/**
 * Richtet in einer Prod-KOPIE den lokalen Testzugang `orchtest` ein (Admin), damit
 * das Puppeteer-Replay die Medienzeitseite mit echten Daten sieht. Laeuft nur auf
 * Kopien unter /data/orch-*.db - die Produktivdatenbank wird hier nie angefasst.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from '../server/utils/sqlite-driver.js';
import { hashPassword } from '../server/utils/password.js';

const file = process.argv[2];
if (!/orch-.*\.db$/.test(file)) {
  console.error('Nur fuer Kopien (data/orch-*.db oder /tmp/opencode/orch-*.db) gedacht.');
  process.exit(1);
}
// Schluessel aus der Fork-.env (dieselbe wie auf Prod, siehe scripts/pull-prod.sh)
const env = Object.fromEntries(
  fs.readFileSync(path.join(import.meta.dirname, '..', '.env'), 'utf8')
    .split('\n').filter((l) => /^[A-Z_]+=./.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
);
const db = new Database(file);
if (env.DB_ENCRYPTION_KEY) {
  db.pragma("cipher = 'sqlcipher'");
  db.pragma(`key="x'${Buffer.from(env.DB_ENCRYPTION_KEY, 'utf8').toString('hex')}'"`);
}
const cols = db.prepare('PRAGMA table_info(users)').all();
console.log('user-Spalten:', cols.map((c) => `${c.name}${c.notnull ? '!' : ''}`).join(', '));
const probe = db.prepare('SELECT id, username, display_name, role, family_role FROM users ORDER BY id').all();
console.log('Bestand:', probe.map((u) => `${u.id}:${u.username}/${u.role}/${u.family_role}`).join(' '));
const PASSWORD = 'LocalTest!2026';
const hash = await hashPassword(PASSWORD);
const existing = db.prepare('SELECT id FROM users WHERE username = ?').get('orchtest');
if (existing) {
  db.prepare('UPDATE users SET password_hash = ?, role = ? WHERE id = ?').run(hash, 'admin', existing.id);
  console.log(`orchtest (id ${existing.id}) aktualisiert`);
} else {
  // Muster zeile: nimmt einem alle NOT-NULL-Spalten ab (avatar_color, feed-Token,
  // onboarding_version, ...). Der Testzugang ist ein Admin wie chris, nur mit
  // eigenem Namen und eigenem Passwort.
  const vorlage = db.prepare("SELECT * FROM users WHERE username = 'chris'").get();
  if (!vorlage) throw new Error('Keine Musterzeile (chris) in der Kopie');
  const { id, ...rest } = vorlage;
  rest.username = 'orchtest';
  rest.password_hash = hash;
  rest.display_name = 'Orch-Test';
  rest.role = 'admin';
  const cols = Object.keys(rest);
  const info = db.prepare(`INSERT INTO users (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => rest[c]));
  console.log(`orchtest angelegt (id ${info.lastInsertRowid})`);
}
const check = db.prepare('SELECT COUNT(*) c FROM media_time_quotas').get();
console.log('Kontingentzeilen in der Kopie:', check.c);
db.close();
