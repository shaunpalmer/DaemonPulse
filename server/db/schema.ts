/**
 * SQLite Schema — DaemonPulse
 *
 * Intentionally minimal. Only auth state lives here.
 * Runtime data (VRAM, models, logs) comes from the daemon live — not stored.
 *
 * Tables:
 *   users         — admin accounts
 *   nodes         — registered remote daemon instances
 *   node_tokens   — per-node API keys (encrypted at rest)
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env['DB_PATH'] ?? './data/daemonpulse.db';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialised. Call initDb() first.');
  return db;
}

export function initDb(): void {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');  // Write-Ahead Logging — better concurrent read perf
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT    NOT NULL UNIQUE,
      password_hash TEXT  NOT NULL,
      role        TEXT    NOT NULL DEFAULT 'viewer'  CHECK(role IN ('admin','viewer')),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS nodes (
      node_id     TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      ip_address  TEXT NOT NULL,
      port        INTEGER NOT NULL DEFAULT 1234,
      tags        TEXT NOT NULL DEFAULT '[]',  -- JSON array
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS node_tokens (
      node_id     TEXT NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
      api_key     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (node_id)
    );
  `);

  console.log(`[DB] SQLite initialised at ${path.resolve(DB_PATH)}`);
}
