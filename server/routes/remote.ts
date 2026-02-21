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
  installMethod?: 'official' | 'npm';
  privateKey?: string;
  password?:   string;
}

type RemotePlatform = 'linux' | 'macOS' | 'windows' | 'unknown';

function connOptsFromBody(body: ConnBody): SSHConnectOpts {
  return {
    host:       body.host,
    port:       body.port,
    username:   body.username,
    privateKey: body.privateKey,
    password:   body.password,
  };
}

async function detectPlatform(conn: Awaited<ReturnType<typeof openConnection>>): Promise<RemotePlatform> {
  const { stdout: uname } = await runCommand(conn, 'uname -s 2>/dev/null || echo ""');
  const u = uname.trim().toLowerCase();
  if (u === 'linux') return 'linux';
  if (u === 'darwin') return 'macOS';

  const { stdout: osEnv } = await runCommand(conn,
    'powershell -NoProfile -Command "$env:OS" 2>$null || echo ""',
  );
  if (osEnv.trim().toLowerCase().includes('windows')) return 'windows';
  return 'unknown';
}

function lifecycleFallbackCmd(action: LifecycleAction, platform: RemotePlatform): string {
  if (platform === 'windows') {
    return action === 'stop'
      ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command "lms daemon down"'
      : 'powershell -NoProfile -ExecutionPolicy Bypass -Command "lms daemon up"';
  }
  return action === 'stop' ? 'lms daemon down' : 'lms daemon up';
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
      const platform = await detectPlatform(conn);

      // 1 — Check if lms CLI is present
      const whichCmd = platform === 'windows'
        ? 'powershell -NoProfile -Command "(Get-Command lms -ErrorAction SilentlyContinue).Path" 2>$null || echo ""'
        : 'command -v lms 2>/dev/null || echo ""';
      const { stdout: which } = await runCommand(conn, whichCmd);
      const lmsFound  = which.trim().length > 0;

      // 2 — Get lms version (if installed)
      let lmsVersion: string | null = null;
      if (lmsFound) {
        const verCmd = platform === 'windows'
          ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command "lms --version" 2>$null || echo ""'
          : 'lms --version 2>/dev/null || echo ""';
        const { stdout: ver } = await runCommand(conn, verCmd);
        lmsVersion = ver.trim() || null;
      }

      // 3 — Check systemd service status
      let serviceActive = false;
      if (platform !== 'windows') {
        const { stdout: svcStatus } = await runCommand(conn,
          'command -v systemctl >/dev/null 2>&1 && systemctl is-active lmstudio-daemon 2>/dev/null || echo "unknown"',
        );
        serviceActive = svcStatus.trim() === 'active';
      }

      // 4 — Probe HTTP server on port 1234
      const probeHttpCmd = platform === 'windows'
        ? 'powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri \"http://127.0.0.1:1234/api/v0/models\" -TimeoutSec 3).StatusCode } catch { 0 }"'
        : 'curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:1234/api/v0/models 2>/dev/null || echo "000"';
      const { stdout: httpCode } = await runCommand(conn, probeHttpCmd);
      const serverUp = httpCode.trim() !== '000' && httpCode.trim() !== '';

      // 5 — OS / kernel info
      const osCmd = platform === 'windows'
        ? 'powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).Caption" 2>$null || cmd /c ver'
        : 'uname -srm 2>/dev/null || echo "unknown"';
      const { stdout: osFull } = await runCommand(conn, osCmd);

      // 6 — Check if running on ARM or x86 (relevant for llmstudio compatibility)
      const arch = osFull.trim();

      res.json({
        host:          body.host,
        lmsInstalled:  lmsFound,
        lmsVersion,
        platform,
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
    const totalSteps = 6;
    const emit = (payload: Record<string, unknown>) =>
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const emitLine = (type: 'info' | 'warn' | 'error', line: string) => emit({ type, line });
    const emitStep = (
      step: number,
      label: string,
      status: 'active' | 'done' | 'error',
      line?: string,
    ) => emit({
      type: 'step',
      step,
      totalSteps,
      label,
      status,
      line: line ?? `[${step}/${totalSteps}] ${label}`,
    });

    const body = req.body as ConnBody;
    if (!body.host || !body.username) {
      emitLine('error', 'host and username are required');
      res.end(); return;
    }

    const installMethod = body.installMethod === 'npm' ? 'npm' : 'official';

    let conn;
    emitStep(1, 'SSH connection', 'active');
    try {
      conn = await openConnection({ ...connOptsFromBody(body), connectTimeout: 15_000 });
      emitStep(1, 'SSH connection', 'done', `Connected to ${body.host}:${body.port ?? 22}`);
    } catch (e) {
      emitStep(1, 'SSH connection', 'error', `SSH failed: ${String(e)}`);
      res.end(); return;
    }

    try {
      emitStep(2, 'Remote platform detection', 'active');
      const platform = await detectPlatform(conn);
      emitStep(2, 'Remote platform detection', 'done', `Detected platform: ${platform}`);

      emitStep(3, 'Installer preflight', 'active');
      if (installMethod === 'npm') {
        const npmCheckCmd = platform === 'windows'
          ? 'powershell -NoProfile -Command "(Get-Command npm -ErrorAction SilentlyContinue).Path" 2>$null || echo ""'
          : 'command -v npm 2>/dev/null || echo ""';
        const { stdout: npmPath } = await runCommand(conn, npmCheckCmd);
        if (!npmPath.trim()) {
          emitStep(3, 'Installer preflight', 'error', 'npm not found on remote host. Install Node.js/npm first, or switch to Official Script method.');
          res.end(); return;
        }
        emitStep(3, 'Installer preflight', 'done', `Install method: npm package (${npmPath.trim()})`);
      } else {
        emitStep(3, 'Installer preflight', 'done', 'Install method: official LM Studio script');
      }

      const installCmd = installMethod === 'npm'
        ? (platform === 'windows'
          ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command "npm install -g lmstudio" 2>&1'
          : 'npm install -g lmstudio 2>&1')
        : (platform === 'windows'
          ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://lmstudio.ai/install.ps1 | iex" 2>&1'
          : 'curl -fsSL https://lmstudio.ai/install.sh | bash 2>&1');

      emitStep(4, 'Run installer', 'active');
      emitLine('info', `Platform: ${platform} — starting ${installMethod} install…`);
      const installExit = await streamCommand(conn, installCmd, res);
      if (installExit === 0) {
        emitStep(4, 'Run installer', 'done', 'Installer command finished successfully.');
      } else {
        emitStep(4, 'Run installer', 'error', `Installer exited with code ${installExit}. Continuing with verification.`);
      }

      // Post-install verification and daemon bootstrap hint
      emitStep(5, 'Verify lms CLI', 'active');
      const verifyCmd = platform === 'windows'
        ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command "lms --version" 2>$null || echo "lms not found"'
        : 'lms --version 2>/dev/null || echo "lms not found"';
      const { stdout: versionAfter } = await runCommand(conn, verifyCmd);
      const installCheck = versionAfter.trim() || 'unknown';
      emitLine('info', `Install check: ${installCheck}`);
      if (/lms not found/i.test(installCheck)) {
        emitStep(5, 'Verify lms CLI', 'error', 'lms binary was not found after install.');
        res.end(); return;
      }
      emitStep(5, 'Verify lms CLI', 'done', `lms ready: ${installCheck}`);

      emitStep(6, 'Daemon bootstrap', 'active');
      const daemonCmd = lifecycleFallbackCmd('start', platform);
      const daemonStart = await runCommand(conn, `${daemonCmd} 2>&1`);
      if (daemonStart.exitCode === 0) {
        emitLine('info', 'Daemon start command succeeded.');
        emitStep(6, 'Daemon bootstrap', 'done', 'Daemon start command succeeded.');
      } else {
        emitLine('warn', `Daemon start command exited ${daemonStart.exitCode}. You can use the Status tab controls next.`);
        emitStep(6, 'Daemon bootstrap', 'error', `Daemon start exited ${daemonStart.exitCode}.`);
      }
    } catch (e) {
      emitLine('error', String(e));
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
      const platform = await detectPlatform(conn);

      // Check whether the systemd unit exists
      let useSystemctl = false;
      if (platform !== 'windows') {
        const hasSystemctl = await runCommand(conn, 'command -v systemctl >/dev/null 2>&1');
        if (hasSystemctl.exitCode === 0) {
          const unitExists = await runCommand(conn,
            'systemctl list-unit-files lmstudio-daemon.service 2>/dev/null | grep -q lmstudio-daemon',
          );
          useSystemctl = unitExists.exitCode === 0;
        }
      }
      const cmds = LIFECYCLE_CMDS[action];
      const cmd  = useSystemctl
        ? cmds.systemctl.replace('sudo systemctl', 'sudo -n systemctl')
        : lifecycleFallbackCmd(action, platform);

      const result = await runCommand(conn, cmd);
      // If non-interactive sudo failed, fall back to lms CLI command
      if (useSystemctl && result.exitCode !== 0 && /sudo:|a password is required/i.test(`${result.stdout}\n${result.stderr}`)) {
        const fallback = await runCommand(conn, lifecycleFallbackCmd(action, platform));
        res.json({
          action,
          method:   'lms-cli-fallback',
          exitCode: fallback.exitCode,
          stdout:   fallback.stdout,
          stderr:   fallback.stderr,
        });
        return;
      }

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
