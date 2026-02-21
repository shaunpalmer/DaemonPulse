/**
 * Proxy Routes — /api/proxy/*
 *
 * Forwards requests to the llmster daemon.
 * The browser never touches the daemon URL directly — this is the air-gap.
 * Spec reference: docs/LMStudioDaemon.md section 2, 3, 4, 5
 */

import { Router, type Request, type Response } from 'express';
import { exec }     from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// lms binary candidates: PATH first, then standard per-user install locations
const LMS_BINS = [
  'lms',
  `${process.env['HOME'] ?? '~'}/.lmstudio/bin/lms`,                                // Linux headless
  `${process.env['LOCALAPPDATA'] ?? ''}\\LM-Studio\\bin\\lms.exe`,              // Windows
];

async function runLmsCli(args: string[]): Promise<string> {
  // Inject --host from the active target when it targets a remote machine
  const target = getActiveTarget();
  const hostFlag = target.host ? ['--host', target.host] : [];
  const fullArgs = [...args, ...hostFlag];

  // Remote targets: 8 s timeout (unreachable hosts stall but don't hang forever).
  // Local targets:  12 s (GPU backend initialisation can be slow on first start).
  const cliTimeout = target.mode === 'remote' ? 8_000 : 12_000;

  let lastErr: unknown;
  for (const bin of LMS_BINS) {
    try {
      const { stdout } = await execAsync(`"${bin}" ${fullArgs.join(' ')}`, { timeout: cliTimeout });
      return stdout.trim();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('lms binary not found in PATH or known install locations');
}

/**
 * Poll the daemon HTTP endpoint until it responds (or times out).
 * `lms server start` returns as soon as the process spawns — the GPU backend
 * may still be initialising.  Callers should await this before reporting "ready".
 */
async function waitForPort(maxMs = 20_000, pollInterval = 600): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${getDaemonUrl()}/api/v0/models`,
        { signal: AbortSignal.timeout(1_500) });
      // 200 or 401 both mean the HTTP stack is alive.
      if (r.ok || r.status === 401) return;
    } catch { /* still booting — swallow and retry */ }
    await new Promise<void>(resolve => setTimeout(resolve, pollInterval));
  }
  throw new Error(`Daemon did not become reachable within ${maxMs} ms`);
}

export const proxyRouter = Router();

// ---------------------------------------------------------------------------
// Target registry — multi-host support
// Each target is one LM Studio daemon the proxy can talk to.
// The active target is selected at runtime via POST /config/targets/:id/activate.
// ---------------------------------------------------------------------------
interface DaemonTarget {
  id:     string;
  label:  string;
  url:    string;   // full daemon base URL  e.g. http://192.168.1.70:1234
  host?:  string;   // hostname/IP for lms --host flag (when different from URL host)
  key?:   string;   // per-target LM Studio Permission Key (overrides DAEMON_API_KEY)
  mode:   'local' | 'remote';
}

const DEFAULT_ID = 'default';

const targetRegistry = new Map<string, DaemonTarget>();
targetRegistry.set(DEFAULT_ID, {
  id:    DEFAULT_ID,
  label: process.env['DAEMON_LABEL']   ?? 'Local',
  url:   process.env['DAEMON_API_URL'] ?? 'http://localhost:1234',
  host:  process.env['DAEMON_HOST'],   // optional --host override
  key:   process.env['DAEMON_API_KEY'] ?? undefined,
  mode:  'local',
});

let activeTargetId: string = DEFAULT_ID;

function getActiveTarget(): DaemonTarget {
  return targetRegistry.get(activeTargetId) ?? (targetRegistry.get(DEFAULT_ID) as DaemonTarget);
}
const getDaemonUrl  = () => getActiveTarget().url;

// Fallback global key (settable via POST /config/daemon-key for the active target)
let runtimeDaemonKey: string = process.env['DAEMON_API_KEY'] ?? '';

function getDaemonHeaders(): Record<string, string> {
  const key = getActiveTarget().key ?? runtimeDaemonKey;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) h['Authorization'] = `Bearer ${key}`;
  return h;
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

async function forwardTo(daemonPath: string, req: Request, res: Response): Promise<void> {
  try {
    const url  = `${getDaemonUrl()}${daemonPath}`;
    const init: RequestInit = {
      method:  req.method,
      headers: getDaemonHeaders(),
    };
    if (req.method !== 'GET') init.body = JSON.stringify(req.body);

    const upstream = await fetch(url, init);
    const data     = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Daemon unreachable', detail: String(err) });
  }
}

/**
 * SSE streaming passthrough.
 * Forces stream:true in the request body, then pipes the upstream
 * text/event-stream response directly to the client chunk by chunk.
 */
async function forwardStream(daemonPath: string, req: Request, res: Response): Promise<void> {
  try {
    const url  = `${getDaemonUrl()}${daemonPath}`;
    const body = { ...(req.body as Record<string, unknown>), stream: true };

    const upstream = await fetch(url, {
      method:  'POST',
      headers: getDaemonHeaders(),
      body:    JSON.stringify(body),
    });

    if (!upstream.ok || !upstream.body) {
      res.status(upstream.status).json({ error: 'Upstream error', status: upstream.status });
      return;
    }

    res.setHeader('Content-Type',  'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if behind proxy
    res.flushHeaders();

    const reader = upstream.body.getReader();
    const dec    = new TextDecoder();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(dec.decode(value, { stream: true }));
    }

    res.end();
  } catch (err) {
    // Only send error if headers not yet sent
    if (!res.headersSent) {
      res.status(502).json({ error: 'Daemon unreachable', detail: String(err) });
    } else {
      res.write(`data: [ERROR] ${String(err)}\n\n`);
      res.end();
    }
  }
}

/**
 * Raw pipe — pipes upstream response body as-is (no body modification).
 * Used for endpoints that stream their own progress events (e.g. /api/v1/models/load).
 */
async function forwardPipe(daemonPath: string, req: Request, res: Response): Promise<void> {
  try {
    const url      = `${getDaemonUrl()}${daemonPath}`;
    const upstream = await fetch(url, {
      method:  req.method,
      headers: getDaemonHeaders(),
      body:    req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
    });

    if (!upstream.ok || !upstream.body) {
      const errBody = await upstream.text().catch(() => '');
      res.status(upstream.status).json({ error: 'Upstream error', detail: errBody });
      return;
    }

    res.setHeader('Content-Type',      'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const reader = upstream.body.getReader();
    const dec    = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(dec.decode(value, { stream: true }));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Daemon unreachable', detail: String(err) });
    } else {
      res.write(`data: [ERROR] ${String(err)}\n\n`);
      res.end();
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime config — update the daemon permission key without restarting the server.
// Key is kept in process memory only (not written back to .env).
// ---------------------------------------------------------------------------
proxyRouter.get('/config/daemon-key', (_req, res) => {
  // Never echo the full key value — return presence flag + masked hint only
  res.json({
    hasKey: runtimeDaemonKey.length > 0,
    hint:   runtimeDaemonKey.length > 4
              ? '••••' + runtimeDaemonKey.slice(-4)
              : runtimeDaemonKey.length > 0 ? '••••' : '',
  });
});
proxyRouter.post('/config/daemon-key', (req, res) => {
  const body  = req.body as { key?: unknown };
  runtimeDaemonKey = typeof body.key === 'string' ? body.key.trim() : '';
  res.json({ ok: true, hasKey: runtimeDaemonKey.length > 0 });
});

// ---------------------------------------------------------------------------
// Models — /api/v0/ (LM Studio native REST API)
// Returns richer model metadata: publisher, arch, compatibility_type, quantization
// ---------------------------------------------------------------------------

// Liveness probe — /api/v0/models is cheapest ping; logs nothing in LM Studio
proxyRouter.get('/daemon/state',  (req, res) => void forwardTo('/api/v0/models', req, res));

// List all downloaded+loaded models  (JIT ON: includes not-loaded; JIT OFF: loaded only)
proxyRouter.get('/models',          (req, res) => void forwardTo('/api/v0/models',         req, res));
proxyRouter.get('/models/loaded',   (req, res) => void forwardTo('/api/v0/models',         req, res));

// Single model detail
proxyRouter.get('/models/:id',      (req, res) => void forwardTo(`/api/v0/models/${encodeURIComponent(req.params['id'] ?? '')}`, req, res));

// Load / eject / download — no v0 equivalents yet; stay on v1 until LM Studio exposes them
// /api/v1/models/load streams JSON-line progress events, then the final instance_id
proxyRouter.post('/models/load',     (req, res) => void forwardPipe('/api/v1/models/load',      req, res));
proxyRouter.post('/models/eject',    (req, res) => void forwardTo('/api/v1/models/unload',     req, res));

// Unload all loaded models via lms CLI --all flag (faster than individual REST calls)
proxyRouter.post('/models/unload-all', (_req, res) => {
  void (async () => {
    try {
      const out = await runLmsCli(['unload', '--all']);
      res.json({ ok: true, output: out });
    } catch (err) {
      res.status(500).json({ error: 'lms unload --all failed', detail: String(err) });
    }
  })();
});
proxyRouter.post('/models/download', (req, res) => void forwardTo('/api/v1/models/download',   req, res));
proxyRouter.get( '/models/download/status', (req, res) => {
  // Forward all query params (e.g. ?jobId=...) through to the daemon
  const qs = new URLSearchParams(req.query as Record<string, string>).toString();
  void forwardTo(`/api/v1/models/download/status${qs ? `?${qs}` : ''}`, req, res);
});

// ---------------------------------------------------------------------------
// Inference — /api/v0/ endpoints
// ---------------------------------------------------------------------------

// Chat completions (OpenAI-compat messages format + enhanced stats)
// Body: { model, messages, temperature?, max_tokens?, stream? }
// Non-streaming (stream:false or omitted) → JSON response
proxyRouter.post('/chat/completions', (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (body['stream'] === true) {
    void forwardStream('/api/v0/chat/completions', req, res);
  } else {
    void forwardTo('/api/v0/chat/completions', req, res);
  }
});

// Streaming-only endpoint — explicit SSE path, always streams
proxyRouter.post('/chat/completions/stream', (req, res) =>
  void forwardStream('/api/v0/chat/completions', req, res));

// Text completions
// Body: { model, prompt, temperature?, max_tokens?, stream?, stop? }
proxyRouter.post('/completions',      (req, res) => void forwardTo('/api/v0/completions',      req, res));

// Embeddings
// Body: { model, input }
// TODO: verify embeddings path — research indicates OpenAI-compatible route is /v1/embeddings,
//       but LM Studio 0.4.x may also serve it at /api/v0/embeddings.  Test against live daemon.
proxyRouter.post('/embeddings',       (req, res) => void forwardTo('/api/v0/embeddings',       req, res));

// MCP-native chat (/api/v1/chat) — supports integrations[], output[] array response
// Kept separate: different request/response shape from /api/v0/chat/completions
// Body: { model, input, integrations?, context_length?, temperature? }
proxyRouter.post('/chat',             (req, res) => void forwardTo('/api/v1/chat',              req, res));

// ---------------------------------------------------------------------------
// Server lifecycle — executed via lms CLI (local target: direct exec; remote: --host flag)
proxyRouter.post('/server/start', (req, res) => {
  void (async () => {
    try {
      const body = req.body as Record<string, unknown>;
      const jit  = body['jit'] === true ? ['--jit', 'on'] : [];
      const out  = await runLmsCli(['server', 'start', ...jit]);
      // lms returns before the GPU backend is ready — poll until HTTP is live.
      await waitForPort(20_000);
      res.json({ ok: true, output: out });
    } catch (err) {
      res.status(500).json({ error: 'lms server start failed', detail: String(err) });
    }
  })();
});

proxyRouter.post('/server/stop', (_req, res) => {
  void (async () => {
    try {
      const out = await runLmsCli(['server', 'stop']);
      res.json({ ok: true, output: out });
    } catch (err) {
      res.status(500).json({ error: 'lms server stop failed', detail: String(err) });
    }
  })();
});

proxyRouter.post('/daemon/up', (_req, res) => {
  void (async () => {
    try {
      const out = await runLmsCli(['daemon', 'up']);
      res.json({ ok: true, output: out });
    } catch (err) {
      res.status(500).json({ error: 'lms daemon up failed', detail: String(err) });
    }
  })();
});

proxyRouter.post('/daemon/down', (_req, res) => {
  void (async () => {
    try {
      const out = await runLmsCli(['daemon', 'down']);
      res.json({ ok: true, output: out });
    } catch (err) {
      res.status(500).json({ error: 'lms daemon down failed', detail: String(err) });
    }
  })();
});

// Linux systemd lifecycle (remote targets only — requires lms --host or SSH)
// Returns the lms CLI output; actual systemctl must be orchestrated server-side
proxyRouter.post('/lifecycle/systemctl', (req, res) => {
  void (async () => {
    const body   = req.body as { action?: string };
    const action = body.action ?? 'status'; // restart | stop | start | status
    const allowed = new Set(['restart', 'stop', 'start', 'status']);
    if (!allowed.has(action)) {
      res.status(400).json({ error: `Unknown action: ${action}. Must be one of: ${[...allowed].join(', ')}` });
      return;
    }
    const target = getActiveTarget();
    if (target.mode !== 'remote') {
      res.status(400).json({
        error:   'systemctl management is only available for remote targets',
        hint:    'Use /server/start and /server/stop for local targets (calls lms CLI directly)',
      });
      return;
    }
    try {
      // Delegate to lms CLI with --host; the lms daemon on the remote box handles systemd
      const out = await runLmsCli(['server', action === 'restart' ? 'stop' : action]);
      res.json({ ok: true, action, output: out });
    } catch (err) {
      res.status(500).json({ error: `Lifecycle action '${action}' failed`, detail: String(err) });
    }
  })();
});

// ---------------------------------------------------------------------------
// Log streaming (spec section 9) — SSE passthrough with per-line framing
// ---------------------------------------------------------------------------

proxyRouter.get('/logs/stream', (req, res) => {
  res.setHeader('Content-Type',      'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Accept ?source= query param so callers can request different log channels.
  // Known sources: 'runtime' (default llama.cpp / MLX logs),
  //                'model'   (token throughput / perf stats — `lms log stream --source model`)
  const source      = typeof req.query['source'] === 'string' ? req.query['source'] : 'runtime';
  const upstreamUrl = `${getDaemonUrl()}/v1/lms/log/stream?source=${encodeURIComponent(source)}`;
  const ctrl        = new AbortController();
  let   leftover    = '';

  fetch(upstreamUrl, { signal: ctrl.signal })
    .then(async upstream => {
      if (!upstream.body) { res.end(); return; }
      const reader = upstream.body.getReader();
      const dec    = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Buffer and split so each SSE event contains exactly one log line
        leftover += dec.decode(value, { stream: true });
        const lines = leftover.split('\n');
        leftover    = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) res.write(`data: ${line}\n\n`);
        }
      }
      if (leftover.trim()) res.write(`data: ${leftover}\n\n`);
      res.end();
    })
    .catch((err: unknown) => {
      if (!res.headersSent) res.end();
      else { res.write(`data: [ERROR] ${String(err)}\n\n`); res.end(); }
    });

  req.on('close', () => ctrl.abort());
});

// ---------------------------------------------------------------------------
// Daemon health stream — SSE pushed by the proxy every HEALTH_INTERVAL_MS.
// Client subscribes once; proxy owns the poll cycle against the daemon.
// Emits: { state: 'running'|'stopped'|'stalled', latencyMs: number }
// ---------------------------------------------------------------------------
const HEALTH_INTERVAL_MS  = 15_000;
const STALL_THRESHOLD_MS  =  5_000;  // daemon response >5 s → stalled

proxyRouter.get('/health/stream', (req, res) => {
  res.setHeader('Content-Type',      'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const probe = async () => {
    const start = Date.now();
    try {
      const r = await fetch(`${getDaemonUrl()}/api/v0/models`, {
        signal:  AbortSignal.timeout(STALL_THRESHOLD_MS),
        headers: getDaemonHeaders(),
      });
      const latencyMs = Date.now() - start;
      // 200 or 401 both mean the HTTP stack is alive
      const state = (r.ok || r.status === 401) ? 'running' : 'stopped';
      res.write(`data: ${JSON.stringify({ state, latencyMs })}\n\n`);
    } catch {
      const latencyMs = Date.now() - start;
      const state = latencyMs >= STALL_THRESHOLD_MS ? 'stalled' : 'stopped';
      res.write(`data: ${JSON.stringify({ state, latencyMs })}\n\n`);
    }
  };

  void probe();   // immediate first event
  const timer = setInterval(() => void probe(), HEALTH_INTERVAL_MS);
  req.on('close', () => clearInterval(timer));
});

// One-shot probe — triggered by client on user action for immediate state update
proxyRouter.post('/health/probe', (_req, res) => {
  void (async () => {
    const start = Date.now();
    try {
      const r = await fetch(`${getDaemonUrl()}/api/v0/models`, {
        signal:  AbortSignal.timeout(STALL_THRESHOLD_MS),
        headers: getDaemonHeaders(),
      });
      const latencyMs = Date.now() - start;
      const state = (r.ok || r.status === 401) ? 'running' : 'stopped';
      res.json({ state, latencyMs });
    } catch {
      const latencyMs = Date.now() - start;
      res.json({ state: latencyMs >= STALL_THRESHOLD_MS ? 'stalled' : 'stopped', latencyMs });
    }
  })();
});

// ---------------------------------------------------------------------------
// MCP tool discovery — calls tools/list on a remote MCP server on behalf of
// the client (avoids CORS issues when the MCP server does not set CORS headers)
// ---------------------------------------------------------------------------

/**
 * POST /api/proxy/mcp/discover
 * Body: { url: string; headers?: Record<string, string> }
 * Returns: an array of MCPTool objects from the server's tools/list response,
 *          OR a 502 error object on failure.
 *
 * Protocol: MCP uses JSON-RPC 2.0 over HTTP POST.
 */
proxyRouter.post('/mcp/discover', (req, res) => {
  void (async () => {
    const body = req.body as { url?: string; headers?: Record<string, string> };
    if (!body.url) {
      res.status(400).json({ error: 'url is required' });
      return;
    }

    const extraHeaders: Record<string, string> = {};
    if (body.headers && typeof body.headers === 'object') {
      for (const [k, v] of Object.entries(body.headers)) {
        if (typeof k === 'string' && typeof v === 'string') extraHeaders[k] = v;
      }
    }

    const rpcPayload = JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 });
    try {
      const r = await fetch(body.url, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: {
          'Content-Type': 'application/json',
          Accept:         'application/json',
          ...extraHeaders,
        },
        body: rpcPayload,
      });

      if (!r.ok) {
        res.status(502).json({ error: `MCP server returned HTTP ${r.status}`, detail: await r.text() });
        return;
      }

      const json = await r.json() as {
        result?: { tools?: unknown[] };
        error?:  { code?: number; message?: string };
      };

      if (json.error) {
        res.status(502).json({ error: json.error.message ?? 'JSON-RPC error', code: json.error.code });
        return;
      }

      res.json({ tools: json.result?.tools ?? [] });
    } catch (err) {
      res.status(502).json({ error: 'Failed to reach MCP server', detail: String(err) });
    }
  })();
});

// ---------------------------------------------------------------------------
// CLI-backed routes — lms runtime survey, lms ps, lms load --estimate-only
// ---------------------------------------------------------------------------

/** Hardware survey: GPU names, architectures, VRAM, driver info */
proxyRouter.get('/runtime/survey', (_req, res) => {
  void (async () => {
    try {
      const stdout = await runLmsCli(['runtime', 'survey', '--json']);
      try { res.json(JSON.parse(stdout)); }
      catch { res.json({ raw: stdout }); }
    } catch (err) {
      res.status(502).json({ error: 'lms runtime survey failed', detail: String(err) });
    }
  })();
});

/** Loaded model instances: id, path, state, VRAM/RAM footprint */
proxyRouter.get('/models/running', (_req, res) => {
  void (async () => {
    try {
      const stdout = await runLmsCli(['ps', '--json']);
      try { res.json(JSON.parse(stdout)); }
      catch { res.json({ raw: stdout }); }
    } catch (err) {
      res.status(502).json({ error: 'lms ps failed', detail: String(err) });
    }
  })();
});

/**
 * Pre-flight VRAM estimate — does NOT actually load the model.
 * Body: { model: string, contextLength?: number, gpuLayers?: number }
 *
 * lms load --estimate-only emits human-readable lines like:
 *   Model: qwen/qwen3-8b
 *   Context Length: 16,000
 *   Estimated GPU Memory: 8.73 GB
 *   Estimated Total Memory: 8.73 GB
 * We parse those into a structured object.
 */
proxyRouter.post('/models/estimate', (req, res) => {
  void (async () => {
    const body = req.body as { model?: string; contextLength?: number; gpuLayers?: number };
    if (!body.model) { res.status(400).json({ error: 'model is required' }); return; }
    const args: string[] = ['load', '--estimate-only', body.model];
    if (body.contextLength) args.push('--context-length', String(body.contextLength));
    if (body.gpuLayers !== undefined) args.push('--gpu-layers', String(body.gpuLayers));
    try {
      const stdout = await runLmsCli(args);
      // Try JSON first (future-proofs if LM Studio adds --json support)
      try { res.json(JSON.parse(stdout)); return; } catch { /* not JSON */ }
      // Parse human-readable output
      const parsed: Record<string, string | number> = { raw: stdout };
      for (const line of stdout.split('\n')) {
        const m = /^([^:]+):\s*(.+)$/.exec(line.trim());
        if (!m) continue;
        const key = m[1].trim().toLowerCase().replace(/\s+/g, '_');
        const val = m[2].trim();
        // Extract numeric GB values
        const gbMatch = /([\d,.]+)\s*GB/i.exec(val);
        parsed[key] = gbMatch ? parseFloat(gbMatch[1].replace(/,/g, '')) : val;
      }
      res.json(parsed);
    } catch (err) {
      res.status(502).json({ error: 'lms load --estimate-only failed', detail: String(err) });
    }
  })();
});
