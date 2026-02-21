/**
 * Seed script — creates the first admin account.
 *
 * Usage (one-time before first run):
 *   npx tsx server/db/seed.ts [username] [password]
 *
 * Defaults: admin / changeme
 * The script is idempotent — re-running it will not create duplicates.
 */

import bcrypt   from 'bcrypt';
import { initDb, getDb } from './schema.js';

const username = process.argv[2] ?? 'admin';
const password = process.argv[3] ?? 'changeme';

initDb();
const db = getDb();

const existing = db
  .prepare<string, { id: number }>('SELECT id FROM users WHERE username = ?')
  .get(username);

if (existing) {
  console.log(`[seed] User "${username}" already exists — skipping.`);
  process.exit(0);
}

const hash = await bcrypt.hash(password, 12);

db.prepare(
  'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
).run(username, hash, 'admin');

console.log(`[seed] Created admin user: "${username}"`);
console.log(`[seed] ⚠  Change this password immediately after first login.`);
process.exit(0);
