/**
 * Remote Orchestration Routes — /api/remote/*
 *
 * Every route opens a fresh SSH session, runs the requested operation,
 * then closes the connection. Credentials are accepted per-request in
 * the JSON body and are never persisted by these routes.
 *
 * Routes:
 *   POST /api/remote/probe          — Connect + survey installed software + daemon state
 *   POST /api/remote/install/stream — SSE: install lmstudio CLI via official one-liner
 *   POST /api/remote/daemon/start   — systemctl start / lms daemon up
 *   POST /api/remote/daemon/stop    — systemctl stop / lms daemon down
 *   POST /api/remote/daemon/restart — systemctl restart
 *   POST /api/remote/survey         — lms runtime survey --json (GPU/VRAM/arch)
 *   POST /api/remote/key-scrape     — Read the LM Studio permission key from ~/.lmstudio
 */

import { Router } from 'express';
import { openConnection, runCommand, streamCommand } from '../lib/sshClient';
import type { SSHConnectOpts } from '../lib/sshClient';

export const remoteRouter = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ConnBody {
  host:        string;
  port?:       number;
  username:    string;
  privateKey?: string;
  password?:   string;
}

function connOptsFromBody(body: ConnBody): SSHConnectOpts {
  return {
    host:       body.host,
    port:       body.port,
    username:   body.username,
    privateKey: body.privateKey,
    password:   body.password,
  };
}

// ---------------------------------------------------------------------------
// POST /probe
// Runs a quick multi-step survey over SSH and returns a structured summary.
// ---------------------------------------------------------------------------
remoteRouter.post('/probe', (req, res) => {
  void (async () => {
    const body = req.body as ConnBody;
    if (!body.host || !body.username) {
      res.status(400).json({ error: 'host and username are required' });
      return;
    }

    let conn;
    try {
      conn = await openConnection(connOptsFromBody(body));
    } catch (e) {
      res.status(502).json({ error: 'SSH connection failed', detail: String(e) });
      return;
    }

    try {
      // 1 — Check if lms CLI is present
      const { stdout: which } = await runCommand(conn, 'which lms 2>/dev/null || echo ""');
      const lmsFound  = which.trim().length > 0;

      // 2 — Get lms version (if installed)
      let lmsVersion: string | null = null;
      if (lmsFound) {
        const { stdout: ver } = await runCommand(conn, 'lms --version 2>/dev/null || echo ""');
        lmsVersion = ver.trim() || null;
      }

      // 3 — Check systemd service status
      const { stdout: svcStatus } = await runCommand(conn,
        'systemctl is-active lmstudio-daemon 2>/dev/null || echo "unknown"',
      );
      const serviceActive = svcStatus.trim() === 'active';

      // 4 — Probe HTTP server on port 1234
      const { stdout: httpCode } = await runCommand(conn,
        'curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:1234/api/v0/models 2>/dev/null || echo "000"',
      );
      const serverUp = httpCode.trim() !== '000' && httpCode.trim() !== '';

      // 5 — OS / kernel info
      const { stdout: osFull } = await runCommand(conn,
        'uname -srm 2>/dev/null || echo "unknown"',
      );

      // 6 — Check if running on ARM or x86 (relevant for llmstudio compatibility)
      const arch = osFull.trim();

      res.json({
        host:          body.host,
        lmsInstalled:  lmsFound,
        lmsVersion,
        serviceActive,
        serverUp,
        daemonState:   serverUp ? 'running' : serviceActive ? 'starting' : 'stopped',
        os:            arch,
      });
    } catch (e) {
      res.status(502).json({ error: 'Remote command failed', detail: String(e) });
    } finally {
      conn.end();
    }
  })();
});

// ---------------------------------------------------------------------------
// POST /install/stream
// SSE: stream progress of the official lmstudio install one-liner.
// On macOS/Linux: curl -fsSL https://lmstudio.ai/install.sh | bash
// ---------------------------------------------------------------------------
remoteRouter.post('/install/stream', (req, res) => {
  res.setHeader('Content-Type',      'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  void (async () => {
    const body = req.body as ConnBody;
    if (!body.host || !body.username) {
      res.write(`data: ${JSON.stringify({ type: 'error', line: 'host and username are required' })}\n\n`);
      res.end(); return;
    }

    let conn;
    try {
      conn = await openConnection({ ...connOptsFromBody(body), connectTimeout: 15_000 });
    } catch (e) {
      res.write(`data: ${JSON.stringify({ type: 'error', line: `SSH failed: ${String(e)}` })}\n\n`);
      res.end(); return;
    }

    try {
      // Detect platform first (macOS vs Linux) then run the appropriate one-liner
      const { stdout: uname } = await runCommand(conn, 'uname -s 2>/dev/null');
      const isMac = uname.trim().toLowerCase() === 'darwin';

      const installCmd = isMac
        ? 'curl -fsSL https://lmstudio.ai/install.sh | bash 2>&1'
        : 'curl -fsSL https://lmstudio.ai/install.sh | bash 2>&1';

      res.write(`data: ${JSON.stringify({ type: 'info', line: `Platform: ${isMac ? 'macOS' : 'Linux'} — starting install…` })}\n\n`);
      await streamCommand(conn, installCmd, res);
    } catch (e) {
      res.write(`data: ${JSON.stringify({ type: 'error', line: String(e) })}\n\n`);
    } finally {
      conn.end();
      res.end();
    }
  })();
});

// ---------------------------------------------------------------------------
// POST /daemon/start|stop|restart
// Prefers systemctl if the service unit is registered; falls back to lms CLI.
// ---------------------------------------------------------------------------

const LIFECYCLE_CMDS = {
  start:   { systemctl: 'sudo systemctl start   lmstudio-daemon', lms: 'lms daemon up'   },
  stop:    { systemctl: 'sudo systemctl stop    lmstudio-daemon', lms: 'lms daemon down' },
  restart: { systemctl: 'sudo systemctl restart lmstudio-daemon', lms: 'lms daemon up'   },
} as const;

type LifecycleAction = keyof typeof LIFECYCLE_CMDS;

function isLifecycleAction(s: string): s is LifecycleAction {
  return s === 'start' || s === 'stop' || s === 'restart';
}

remoteRouter.post('/daemon/:action', (req, res) => {
  void (async () => {
    const action = req.params['action'] ?? '';
    if (!isLifecycleAction(action)) {
      res.status(400).json({ error: `Unknown action "${action}". Use start, stop, or restart.` });
      return;
    }

    const body = req.body as ConnBody;
    if (!body.host || !body.username) {
      res.status(400).json({ error: 'host and username are required' });
      return;
    }

    let conn;
    try {
      conn = await openConnection(connOptsFromBody(body));
    } catch (e) {
      res.status(502).json({ error: 'SSH connection failed', detail: String(e) });
      return;
    }

    try {
      // Check whether the systemd unit exists
      const { exitCode: unitExists } = await runCommand(conn,
        'systemctl list-unit-files lmstudio-daemon.service 2>/dev/null | grep -q lmstudio-daemon',
      );
      const useSystemctl = unitExists === 0;
      const cmds = LIFECYCLE_CMDS[action];
      const cmd  = useSystemctl ? cmds.systemctl : cmds.lms;

      const result = await runCommand(conn, cmd);
      res.json({
        action,
        method:   useSystemctl ? 'systemctl' : 'lms-cli',
        exitCode: result.exitCode,
        stdout:   result.stdout,
        stderr:   result.stderr,
      });
    } catch (e) {
      res.status(502).json({ error: 'Remote command failed', detail: String(e) });
    } finally {
      conn.end();
    }
  })();
});

// ---------------------------------------------------------------------------
// POST /survey
// Run `lms runtime survey --json` and return parsed GPU/VRAM data.
// ---------------------------------------------------------------------------
remoteRouter.post('/survey', (req, res) => {
  void (async () => {
    const body = req.body as ConnBody;
    if (!body.host || !body.username) {
      res.status(400).json({ error: 'host and username are required' });
      return;
    }

    let conn;
    try {
      conn = await openConnection(connOptsFromBody(body));
    } catch (e) {
      res.status(502).json({ error: 'SSH connection failed', detail: String(e) });
      return;
    }

    try {
      const result = await runCommand(conn, 'lms runtime survey --json 2>/dev/null');
      try {
        const parsed = JSON.parse(result.stdout) as unknown;
        res.json({ survey: parsed });
      } catch {
        // Not JSON — return raw text (lms may output human-readable fallback)
        res.json({ raw: result.stdout, stderr: result.stderr });
      }
    } catch (e) {
      res.status(502).json({ error: 'Remote command failed', detail: String(e) });
    } finally {
      conn.end();
    }
  })();
});

// ---------------------------------------------------------------------------
// POST /key-scrape
// Read the LM Studio permission (API) key from the remote ~/.lmstudio config.
// Returns { key } if found, or { key: null } if not present.
// ---------------------------------------------------------------------------
remoteRouter.post('/key-scrape', (req, res) => {
  void (async () => {
    const body = req.body as ConnBody;
    if (!body.host || !body.username) {
      res.status(400).json({ error: 'host and username are required' });
      return;
    }

    let conn;
    try {
      conn = await openConnection(connOptsFromBody(body));
    } catch (e) {
      res.status(502).json({ error: 'SSH connection failed', detail: String(e) });
      return;
    }

    try {
      // LM Studio stores its config under ~/.lmstudio/.  The permission key
      // lives in the server settings JSON — try the most common location.
      const candidates = [
        '~/.lmstudio/configs/server-config.json',
        '~/.lmstudio/server-config.json',
        '~/.lmstudio/settings.json',
        '~/.config/lmstudio/server-config.json',
      ];

      let key: string | null = null;

      for (const path of candidates) {
        const { stdout, exitCode } = await runCommand(conn, `cat ${path} 2>/dev/null`);
        if (exitCode !== 0 || !stdout) continue;

        try {
          // Look for a "permissionKey", "apiKey", or "authToken" field
          const obj = JSON.parse(stdout) as Record<string, unknown>;
          const candidate = obj['permissionKey'] ?? obj['apiKey'] ?? obj['authToken'];
          if (typeof candidate === 'string' && candidate.length > 0) {
            key = candidate;
            break;
          }
        } catch { /* not JSON or doesn't have the field — try next */ }
      }

      // Also attempt an env-level check (key may be set via process env on the remote)
      if (!key) {
        const { stdout: envKey } = await runCommand(conn,
          'printenv LMS_API_KEY 2>/dev/null || printenv DAEMON_API_KEY 2>/dev/null || echo ""',
        );
        const trimmed = envKey.trim();
        if (trimmed.length > 0) key = trimmed;
      }

      res.json({ key });
    } catch (e) {
      res.status(502).json({ error: 'Remote command failed', detail: String(e) });
    } finally {
      conn.end();
    }
  })();
});
