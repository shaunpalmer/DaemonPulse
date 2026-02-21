/**
 * DaemonPulse — Node.js Bridge Server
 *
 * Sits between the browser and the remote llmster daemon.
 * Responsibilities:
 *   1. Auth: login endpoint, JWT issuance
 *   2. Proxy: forwards /api/proxy/* to the daemon, injects auth headers
 *   3. Security: never exposes the daemon URL directly to the browser
 */

import express from 'express';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { initDb } from './db/schema';
import { authRouter }   from './routes/auth';
import { proxyRouter }  from './routes/proxy';
import { remoteRouter } from './routes/remote';
import { requireAuth }  from './middleware/auth';

// Load .env manually — no dotenv dependency needed
try {
  const envPath = resolve(process.cwd(), '.env');
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
} catch { /* .env not found — fall back to defaults */ }

const PORT = process.env['BRIDGE_PORT'] ? parseInt(process.env['BRIDGE_PORT'], 10) : 3000;

const app = express();
app.use(express.json());

// Initialise SQLite on startup
initDb();

// --- Public routes ---
app.use('/api/auth', authRouter);

// --- Protected routes (JWT required) ---
app.use('/api/proxy',  requireAuth, proxyRouter);
app.use('/api/remote', requireAuth, remoteRouter);

app.listen(PORT, () => {
  console.log(`[DaemonPulse Bridge] Listening on http://localhost:${PORT}`);
  console.log(`[DaemonPulse Bridge] Proxying to daemon at ${process.env['DAEMON_API_URL'] ?? 'http://localhost:1234'}`);
});
