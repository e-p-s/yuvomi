import fs from 'node:fs';
import path from 'node:path';
import Database from '../server/utils/sqlite-driver.js';
const file = process.argv[2];
const env = Object.fromEntries(fs.readFileSync(path.join(import.meta.dirname, '..', '.env'), 'utf8')
  .split('\n').filter((l) => /^[A-Z_]+=./.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const db = new Database(file, { readonly: true });
if (env.DB_ENCRYPTION_KEY) {
  db.pragma("cipher = 'sqlcipher'");
  db.pragma(`key="x'${Buffer.from(env.DB_ENCRYPTION_KEY, 'utf8').toString('hex')}'"`);
}
const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'media_time%'").all().map(r => r.name);
console.log('Tabellen:', t.join(', '));
for (const tbl of t) console.log('  ', tbl, '=', db.prepare(`SELECT COUNT(*) c FROM ${tbl}`).get().c);
const keys = db.prepare("SELECT key, value FROM sync_config WHERE key LIKE 'media_time%' ORDER BY key").all();
console.log('Einstellungen:');
for (const k of keys) console.log(`  ${k.key} = ${String(k.value).slice(0, 60)}`);
db.close();
