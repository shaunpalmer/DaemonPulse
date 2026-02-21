/**
 * ConsoleView — Module 5: The Console (Diagnostics)
 *
 * Spec reference: docs/LMStudioDaemon.md section 9
 * PRD reference:  docs/LMS Admin-PRD.txt Module 5
 *
 * Live log stream from /api/proxy/logs/stream (SSE, fetch-based so we can
 * send the Authorization: Bearer header — EventSource does not support headers).
 * Features: pause/resume, level filter, auto-scroll, reconnect on error.
 */

import { AuthService } from '@/services/AuthService';

type LogLevel = 'all' | 'live' | 'info' | 'warn' | 'error';

function levelOf(line: string): Exclude<LogLevel, 'all' | 'live'> {
  if (/\[error\]|\bERROR\b/i.test(line)) return 'error';
  if (/\[warn\]|\bWARN\b/i.test(line))  return 'warn';
  return 'info';
}

/** Returns true for lines that are surfaced in Live-mode (high-level events only) */
function isHighLevelEvent(line: string): boolean {
  return (
    /llm\.(load|unload|eject|ready)/i.test(line) ||
    /server\.(start|stop|restart|ready|listening)/i.test(line) ||
    /daemon\.(up|down|start|stop)/i.test(line) ||
    /model.*loaded|model.*unloaded|download.*(complete|failed|started)/i.test(line) ||
    /\[error\]|\bERROR\b/i.test(line) ||
    /\[warn\]|\bWARN\b/i.test(line)
  );
}

interface IPerfStats {
  tokens_per_second:    number | null;
  time_to_first_token:  number | null;  // seconds — display as ms
  total_tokens:         number | null;
  prompt_tokens:        number | null;
  generated_tokens:     number | null;
  model:                string | null;
  updatedAt:            Date   | null;
}

const EMPTY_PERF: IPerfStats = {
  tokens_per_second:   null,
  time_to_first_token: null,
  total_tokens:        null,
  prompt_tokens:       null,
  generated_tokens:    null,
  model:               null,
  updatedAt:           null,
};

export class ConsoleView {
  private logLines:    string[]    = [];
  private levelFilter: LogLevel    = 'all';
  private paused       = false;
  private connected    = false;
  private autoScroll   = true;
  private abortCtrl:   AbortController | null = null;

  private activeTab:     'logs' | 'perf'  = 'logs';
  private perfConnected  = false;
  private perfAbortCtrl: AbortController | null = null;
  private perfStats:     IPerfStats       = { ...EMPTY_PERF };
  private perfHistory:   IPerfStats[]     = [];   // last 30 completed runs

  constructor(private readonly root: HTMLElement) {}

  mount(): void {
    // Default filter based on current environment mode
    const devMode = localStorage.getItem('dp_developer_mode') === 'true';
    this.levelFilter = devMode ? 'all' : 'live';
    this.render();
    void this.connectLogs();
    // TODO (nice-to-have): listen for storage events so flipping Dev/Live in
    // Settings reactively resets the filter without needing a navigation round-trip:
    //   window.addEventListener('storage', (e) => {
    //     if (e.key === 'dp_developer_mode') {
    //       this.levelFilter = e.newValue === 'true' ? 'all' : 'live';
    //       this.render(); this.rebindEvents();
    //     }
    //   });
  }

  unmount(): void {
    this.abortCtrl?.abort();
    this.abortCtrl = null;
    this.perfAbortCtrl?.abort();
    this.perfAbortCtrl = null;
  }

  // ---------------------------------------------------------------------------
  // SSE: perf stream — source=model (prediction.stats events)
  // ---------------------------------------------------------------------------

  private async connectPerf(): Promise<void> {
    this.perfAbortCtrl?.abort();
    this.perfAbortCtrl = new AbortController();
    this.perfConnected = false;
    this.updatePerfStatus('connecting');

    try {
      const res = await AuthService.apiFetch('/api/proxy/logs/stream?source=model', {
        signal: this.perfAbortCtrl.signal,
      });

      if (!res.ok || !res.body) {
        this.updatePerfStatus('error');
        setTimeout(() => { void this.connectPerf(); }, 5000);
        return;
      }

      this.perfConnected = true;
      this.updatePerfStatus('live');

      const reader = res.body.getReader();
      const dec    = new TextDecoder();
      let   buf    = '';
      let   accumulating = false;
      let   current: Partial<IPerfStats> = {};

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const raw of lines) {
          const trimmed = raw.trim();
          if (!trimmed.startsWith('data:')) continue;
          const line = trimmed.slice(5).trim();
          if (!line) continue;

          // Start of a prediction.stats block
          if (/type:\s*llm\.prediction\.stats/i.test(line)) {
            if (accumulating) this.flushPerfStats(current);
            accumulating = true;
            current = {};
            continue;
          }

          if (!accumulating) continue;

          // New 'type:' line signals end of prev block
          if (/^type:/i.test(line)) {
            this.flushPerfStats(current);
            accumulating = false;
            current = {};
            continue;
          }

          const kv = /^([\w.]+):\s*(.+)$/.exec(line);
          if (!kv) continue;
          const key = (kv[1] ?? '').toLowerCase().replace(/\./g, '_');
          const val  = kv[2] ?? '';
          switch (key) {
            case 'tokens_per_second':   current.tokens_per_second   = parseFloat(val); break;
            case 'time_to_first_token': current.time_to_first_token = parseFloat(val); break;
            case 'total_tokens':        current.total_tokens        = parseInt(val, 10); break;
            case 'prompt_tokens':       current.prompt_tokens       = parseInt(val, 10); break;
            case 'generated_tokens':    current.generated_tokens    = parseInt(val, 10); break;
            case 'model':               current.model               = val; break;
          }
        }
      }
      if (accumulating) this.flushPerfStats(current);
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'AbortError') return;
      this.updatePerfStatus('error');
      setTimeout(() => { void this.connectPerf(); }, 5000);
      return;
    }

    this.perfConnected = false;
    this.updatePerfStatus('disconnected');
    setTimeout(() => { void this.connectPerf(); }, 5000);
  }

  private flushPerfStats(partial: Partial<IPerfStats>): void {
    if (partial.tokens_per_second == null && partial.total_tokens == null) return;
    const snapshot: IPerfStats = {
      tokens_per_second:   partial.tokens_per_second   ?? null,
      time_to_first_token: partial.time_to_first_token ?? null,
      total_tokens:        partial.total_tokens        ?? null,
      prompt_tokens:       partial.prompt_tokens       ?? null,
      generated_tokens:    partial.generated_tokens    ?? null,
      model:               partial.model               ?? null,
      updatedAt:           new Date(),
    };
    this.perfStats = snapshot;
    this.perfHistory.unshift(snapshot);
    if (this.perfHistory.length > 30) this.perfHistory.pop();
    this.repaintPerfGauges();
  }

  private repaintPerfGauges(): void {
    const s = this.perfStats;
    const set = (id: string, v: string) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    const fmt    = (n: number | null, d = 1)  => n != null ? n.toFixed(d) : '—';
    const fmtMs  = (n: number | null)          => n != null ? `${(n * 1000).toFixed(0)} ms` : '—';
    const fmtInt = (n: number | null)          => n != null ? n.toLocaleString() : '—';

    set('perf-tps-val',    fmt(s.tokens_per_second));
    set('perf-ttft-val',   fmtMs(s.time_to_first_token));
    set('perf-total-val',  fmtInt(s.total_tokens));
    set('perf-prompt-val', fmtInt(s.prompt_tokens));
    set('perf-gen-val',    fmtInt(s.generated_tokens));
    set('perf-model-val',  s.model ?? '—');
    set('perf-updated',    s.updatedAt ? s.updatedAt.toTimeString().slice(0, 8) : '—');

    const tbody = document.getElementById('perf-history-body');
    if (tbody && s.updatedAt) {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-900/40';
      const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      tr.innerHTML = `
        <td class="px-4 py-1.5 text-slate-600">${s.updatedAt.toTimeString().slice(0, 8)}</td>
        <td class="px-4 py-1.5 text-emerald-400">${fmt(s.tokens_per_second)}</td>
        <td class="px-4 py-1.5 text-indigo-400">${fmtMs(s.time_to_first_token)}</td>
        <td class="px-4 py-1.5 text-slate-300">${fmtInt(s.generated_tokens)}</td>
        <td class="px-4 py-1.5 text-slate-500 truncate max-w-[12rem]">${esc(s.model ?? '—')}</td>
      `;
      tbody.prepend(tr);
      while (tbody.children.length > 30) tbody.removeChild(tbody.lastChild!);
    }
  }

  private updatePerfStatus(state: 'connecting' | 'live' | 'error' | 'disconnected'): void {
    const dot  = document.getElementById('perf-status-dot');
    const text = document.getElementById('perf-status-text');
    if (!dot || !text) return;
    const map: Record<string, [string, string]> = {
      connecting:   ['bg-yellow-400 animate-pulse', 'Connecting…'],
      live:         ['bg-emerald-400 animate-pulse', 'Live'],
      error:        ['bg-red-500',                   'Error — retrying…'],
      disconnected: ['bg-slate-600',                 'Reconnecting…'],
    };
    const [cls, label] = map[state] ?? ['bg-slate-600', ''];
    dot.className    = `w-1.5 h-1.5 rounded-full ${cls}`;
    text.textContent = label;
  }

  // ---------------------------------------------------------------------------
  // SSE: runtime log stream — source=runtime (default)
  // ---------------------------------------------------------------------------

  private async connectLogs(): Promise<void> {
    this.abortCtrl?.abort();
    this.abortCtrl = new AbortController();
    this.connected = false;
    this.updateStatusBar('connecting');

    try {
      const res = await AuthService.apiFetch('/api/proxy/logs/stream', {
        signal: this.abortCtrl.signal,
      });
      // TODO (nice-to-have): open a second fetch to /api/proxy/logs/stream?source=model
      //   (`lms log stream --source model`) for performance stats (tokens/sec, I/O).
      //   Route those lines to a separate "Perf" tab alongside the main stream.

      if (!res.ok || !res.body) {
        this.updateStatusBar('error');
        setTimeout(() => { void this.connectLogs(); }, 4000);
        return;
      }

      this.connected = true;
      this.updateStatusBar('live');

      const reader = res.body.getReader();
      const dec    = new TextDecoder();
      let   buf    = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const raw of lines) {
          const trimmed = raw.trim();
          if (!trimmed.startsWith('data:')) continue;
          const line = trimmed.slice(5).trim();
          if (line) this.receiveLine(line);
        }
      }
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'AbortError') return;
      this.updateStatusBar('error');
      setTimeout(() => { void this.connectLogs(); }, 4000);
      return;
    }

    this.connected = false;
    this.updateStatusBar('disconnected');
    setTimeout(() => { void this.connectLogs(); }, 4000);
  }

  private receiveLine(line: string): void {
    if (this.paused) return;
    const level = levelOf(line);
    if (this.levelFilter === 'live' && !isHighLevelEvent(line)) return;
    if (this.levelFilter !== 'all' && this.levelFilter !== 'live' && level !== this.levelFilter) return;

    this.logLines.push(line);
    if (this.logLines.length > 1000) this.logLines.shift();

    const container = document.getElementById('console-log-stream');
    if (!container) return;
    const p = document.createElement('p');
    p.innerHTML = this.formatLine(line);
    container.appendChild(p);
    if (this.autoScroll) container.scrollTop = container.scrollHeight;

    // Update line count badge
    const badge = document.getElementById('console-line-count');
    if (badge) badge.textContent = `${this.logLines.length} lines`;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  private render(): void {
    const levels: LogLevel[] = ['all', 'live', 'info', 'warn', 'error'];
    const levelColours: Record<LogLevel, string> = {
      all:   'text-slate-400',
      live:  'text-indigo-400',
      info:  'text-emerald-400',
      warn:  'text-orange-400',
      error: 'text-red-400',
    };
    const levelLabels: Record<LogLevel, string> = {
      all:   'All',
      live:  '⚡ Live',
      info:  'Info',
      warn:  'Warn',
      error: 'Error',
    };

    this.root.innerHTML = `
      <div class="space-y-5 max-w-5xl">

        <!-- Header -->
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-lg font-bold text-white tracking-tight">The Console</h2>
            <p class="text-xs text-slate-500 mt-0.5">
              ${this.activeTab === 'perf'
                ? `Inference performance · <span class="font-mono">lms log stream -s model</span>`
                : `Raw daemon output · <span class="font-mono">lms log stream -s runtime</span>`
              }
            </p>
          </div>
          <div class="flex items-center gap-2">
            <!-- Tab switcher -->
            <div class="flex rounded-lg overflow-hidden border border-slate-700 text-[10px] font-bold">
              <button id="console-tab-logs"
                class="px-3 py-1.5 transition-colors cursor-pointer
                       ${this.activeTab === 'logs' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}">
                Logs
              </button>
              <button id="console-tab-perf"
                class="px-3 py-1.5 transition-colors cursor-pointer
                       ${this.activeTab === 'perf' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}">
                ⚡ Perf
              </button>
            </div>
            ${this.activeTab === 'perf' ? `
              <span id="perf-status-dot"
                class="w-1.5 h-1.5 rounded-full ${this.perfConnected ? 'bg-emerald-400 animate-pulse' : 'bg-yellow-400 animate-pulse'}"></span>
              <span id="perf-status-text" class="text-[10px] font-mono text-slate-500">
                ${this.perfConnected ? 'Live' : 'Connecting…'}
              </span>
            ` : `
              <span id="console-status-dot"
                class="w-1.5 h-1.5 rounded-full ${this.connected ? 'bg-emerald-400 animate-pulse' : 'bg-yellow-400 animate-pulse'}">
              </span>
              <span id="console-status-text"
                class="text-[10px] font-mono text-slate-500">
                ${this.connected ? 'Live' : 'Connecting…'}
              </span>
            `}
          </div>
        </div>

        ${this.activeTab === 'perf' ? this.renderPerfPanel() : `

        <!-- Controls -->
        <div class="flex flex-wrap items-center gap-2">

          <!-- Level filter pills -->
          <div class="flex rounded-lg overflow-hidden border border-slate-700">
            ${levels.map(lvl => `
              <button data-level="${lvl}"
                class="level-filter-btn px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider
                       transition-colors cursor-pointer border-r border-slate-700 last:border-r-0
                       ${this.levelFilter === lvl
                         ? `bg-slate-800 ${levelColours[lvl]}`
                         : 'text-slate-600 hover:text-slate-300 hover:bg-slate-800'}">
                ${levelLabels[lvl]}
              </button>
            `).join('')}
          </div>

          <!-- Pause / Resume -->
          <button id="console-pause-btn"
            class="px-3 py-1.5 rounded-lg border text-[10px] font-bold uppercase tracking-wider transition-all
                   ${this.paused
                     ? 'border-orange-500/40 bg-orange-500/10 text-orange-400'
                     : 'border-slate-700 text-slate-500 hover:text-slate-300 hover:bg-slate-800'}">
            ${this.paused ? '▶ Resume' : '⏸ Pause'}
          </button>

          <!-- Auto-scroll -->
          <button id="console-autoscroll-btn"
            class="px-3 py-1.5 rounded-lg border text-[10px] font-bold uppercase tracking-wider transition-all
                   ${this.autoScroll
                     ? 'border-indigo-500/20 bg-indigo-500/10 text-indigo-400'
                     : 'border-slate-700 text-slate-500 hover:text-slate-300 hover:bg-slate-800'}">
            ↓ Auto-scroll
          </button>

          <div class="ml-auto flex items-center gap-2">
            <!-- Clear -->
            <button id="console-clear-btn"
              class="px-3 py-1.5 rounded-lg border border-slate-700 text-[10px] font-bold uppercase
                     tracking-wider text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-all">
              ✕ Clear
            </button>
            <!-- Reconnect -->
            <button id="console-reconnect-btn"
              class="px-3 py-1.5 rounded-lg border border-slate-700 text-[10px] font-bold uppercase
                     tracking-wider text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-all">
              ↺ Reconnect
            </button>
          </div>
        </div>

        <!-- Log stream -->
        <section class="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden">
          <div class="flex items-center gap-3 px-4 py-2.5 border-b border-slate-800 bg-slate-900/60">
            <code class="text-[10px] font-mono text-slate-400">lms log stream -s runtime</code>
            <span id="console-line-count"
              class="text-[10px] font-mono text-slate-600 ml-auto">
              ${this.logLines.length} lines
            </span>
          </div>
          <div id="console-log-stream"
               class="p-4 font-mono text-[11px] h-[30rem] overflow-y-auto space-y-0.5">
            ${this.logLines.length === 0
              ? `<p class="text-slate-700">[Connecting to daemon log stream — waiting for first line…]</p>`
              : this.logLines.map(l => `<p>${this.formatLine(l)}</p>`).join('')
            }
          </div>
        </section>

        <!-- Info strip -->
        <div class="bg-slate-900 border border-slate-800 rounded-xl p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <p class="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">Data Source</p>
            <p class="text-[11px] text-slate-500 leading-relaxed">
              Proxied from
              <code class="font-mono text-slate-400">/v1/lms/log/stream?source=runtime</code>
              — the same stream shown in LM Studio's desktop Logs panel.
              Includes llama.cpp / MLX kernel events, context activity, and token traces.
            </p>
          </div>
          <div>
            <p class="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">Level Guide</p>
            <div class="flex flex-col gap-1 text-[11px]">
              <span><code class="text-emerald-400">info</code> — model load/unload, server events</span>
              <span><code class="text-orange-400">warn</code> — degraded performance, near-OOM conditions</span>
              <span><code class="text-red-400">error</code> — OOM, kernel failures, crashed requests</span>
            </div>
          </div>
        </div>

        `}
      </div>
    `;

    this.bindEvents();
  }

  // ---------------------------------------------------------------------------
  // Perf panel template
  // ---------------------------------------------------------------------------

  private renderPerfPanel(): string {
    const s      = this.perfStats;
    const esc    = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const fmt    = (n: number | null, d = 1)  => n != null ? n.toFixed(d) : '—';
    const fmtMs  = (n: number | null)          => n != null ? `${(n * 1000).toFixed(0)} ms` : '—';
    const fmtInt = (n: number | null)          => n != null ? n.toLocaleString() : '—';

    const gauge = (id: string, label: string, value: string, colour: string, sub = '') => `
      <div class="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col gap-1">
        <p class="text-[10px] font-bold uppercase tracking-wider text-slate-500">${label}</p>
        <p id="${id}" class="text-2xl font-bold font-mono ${colour}">${value}</p>
        ${sub ? `<p class="text-[10px] text-slate-600">${sub}</p>` : ''}
      </div>`;

    return `
      <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
        ${gauge('perf-tps-val',    'Tokens / sec',        fmt(s.tokens_per_second),    'text-emerald-400', 'higher = faster')}
        ${gauge('perf-ttft-val',   'Time to first token', fmtMs(s.time_to_first_token), 'text-indigo-400',  'lower = more responsive')}
        ${gauge('perf-gen-val',    'Generated tokens',    fmtInt(s.generated_tokens),  'text-slate-200',   'last inference run')}
        ${gauge('perf-prompt-val', 'Prompt tokens',       fmtInt(s.prompt_tokens),     'text-slate-400',   'input context size')}
        ${gauge('perf-total-val',  'Total tokens',        fmtInt(s.total_tokens),      'text-slate-400',   'prompt + generated')}
        <div class="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col gap-1">
          <p class="text-[10px] font-bold uppercase tracking-wider text-slate-500">Model</p>
          <p id="perf-model-val" class="text-xs font-mono text-slate-300 truncate"
             title="${esc(s.model ?? '')}">${esc(s.model ?? '—')}</p>
          <p class="text-[10px] text-slate-600">last active model</p>
        </div>
      </div>

      <div class="flex items-center gap-2 text-[10px] font-mono text-slate-600">
        <span>Last inference:</span>
        <span id="perf-updated">${s.updatedAt ? s.updatedAt.toTimeString().slice(0, 8) : '—'}</span>
        <span class="ml-auto italic">Waiting for <code>llm.prediction.stats</code> events…</span>
      </div>

      <section class="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden">
        <div class="flex items-center gap-3 px-4 py-2.5 border-b border-slate-800 bg-slate-900/60">
          <code class="text-[10px] font-mono text-slate-400">prediction.stats history</code>
          <span class="text-[10px] font-mono text-slate-600 ml-auto">last 30 runs</span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-[11px] font-mono">
            <thead>
              <tr class="border-b border-slate-800 text-slate-600 text-left">
                <th class="px-4 py-2 font-semibold">Time</th>
                <th class="px-4 py-2 font-semibold">t/s</th>
                <th class="px-4 py-2 font-semibold">TTFT</th>
                <th class="px-4 py-2 font-semibold">Gen tokens</th>
                <th class="px-4 py-2 font-semibold">Model</th>
              </tr>
            </thead>
            <tbody id="perf-history-body" class="divide-y divide-slate-800/40">
              ${this.perfHistory.length === 0
                ? `<tr><td colspan="5" class="px-4 py-6 text-slate-700 text-center">
                    No inference runs captured yet — run an inference in the Pulse view or directly in LM Studio
                   </td></tr>`
                : this.perfHistory.map(r => `
                    <tr class="hover:bg-slate-900/40">
                      <td class="px-4 py-1.5 text-slate-600">${r.updatedAt!.toTimeString().slice(0, 8)}</td>
                      <td class="px-4 py-1.5 text-emerald-400">${fmt(r.tokens_per_second)}</td>
                      <td class="px-4 py-1.5 text-indigo-400">${fmtMs(r.time_to_first_token)}</td>
                      <td class="px-4 py-1.5 text-slate-300">${fmtInt(r.generated_tokens)}</td>
                      <td class="px-4 py-1.5 text-slate-500 truncate max-w-[12rem]">${esc(r.model ?? '—')}</td>
                    </tr>`).join('')
              }
            </tbody>
          </table>
        </div>
      </section>

      <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <p class="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">Data Source</p>
        <p class="text-[11px] text-slate-500 leading-relaxed">
          Streamed from <code class="font-mono text-slate-400">/v1/lms/log/stream?source=model</code>.
          Emits <code class="font-mono text-slate-400">llm.prediction.stats</code> events after every completed
          inference — captures <code class="font-mono text-slate-400">tokens_per_second</code>,
          <code class="font-mono text-slate-400">time_to_first_token</code>, token counts, and active model.
          History persists in-session; refreshing the page resets the table.
        </p>
      </div>`;
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  private bindEvents(): void {
    document.getElementById('console-tab-logs')?.addEventListener('click', () => {
      if (this.activeTab !== 'logs') { this.activeTab = 'logs'; this.render(); }
    });
    document.getElementById('console-tab-perf')?.addEventListener('click', () => {
      if (this.activeTab !== 'perf') {
        this.activeTab = 'perf';
        this.render();
        // Lazy-start perf SSE on first switch
        if (!this.perfConnected && !this.perfAbortCtrl) void this.connectPerf();
      }
    });

    if (this.activeTab === 'logs') {
      document.getElementById('console-pause-btn')?.addEventListener('click', () => {
        this.paused = !this.paused;
        this.render();
      });
      document.getElementById('console-autoscroll-btn')?.addEventListener('click', () => {
        this.autoScroll = !this.autoScroll;
        this.render();
      });
      document.getElementById('console-clear-btn')?.addEventListener('click', () => {
        this.logLines = [];
        const container = document.getElementById('console-log-stream');
        if (container) container.innerHTML = '<p class="text-slate-700">[Cleared]</p>';
        const badge = document.getElementById('console-line-count');
        if (badge) badge.textContent = '0 lines';
      });
      document.getElementById('console-reconnect-btn')?.addEventListener('click', () => {
        void this.connectLogs();
      });
      document.querySelectorAll<HTMLButtonElement>('.level-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          this.levelFilter = btn.dataset['level'] as LogLevel;
          this.render();
        });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private updateStatusBar(state: 'connecting' | 'live' | 'error' | 'disconnected'): void {
    const dot  = document.getElementById('console-status-dot');
    const text = document.getElementById('console-status-text');
    if (!dot || !text) return;
    const map: Record<string, [string, string]> = {
      connecting:   ['bg-yellow-400 animate-pulse', 'Connecting…'],
      live:         ['bg-emerald-400 animate-pulse', 'Live'],
      error:        ['bg-red-500',                   'Error — retrying…'],
      disconnected: ['bg-slate-600',                 'Reconnecting…'],
    };
    const [cls, label] = map[state] ?? ['bg-slate-600', ''];
    dot.className  = `w-1.5 h-1.5 rounded-full ${cls}`;
    text.textContent = label;
  }

  private formatLine(line: string): string {
    const e = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Structured entries from `lms log stream -s runtime` use `key: value` format
    // e.g. "type: llm.prediction.input"  or  "timestamp: 11/13/2024, 9:35:15 AM"
    const kvMatch = /^([a-zA-Z][\w.]+):\s(.+)$/.exec(line.trim());
    if (kvMatch) {
      const key = (kvMatch[1] ?? '').toLowerCase();
      const val = kvMatch[2] ?? '';
      const vEsc = val.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (key === 'type') {
        if (/error/i.test(val))                    return `<span class="text-slate-600 text-[10px]">type: </span><span class="text-red-400">${vEsc}</span>`;
        if (/unload|stop|cancel/i.test(val))       return `<span class="text-slate-600 text-[10px]">type: </span><span class="text-orange-400">${vEsc}</span>`;
        if (/load/i.test(val))                     return `<span class="text-slate-600 text-[10px]">type: </span><span class="text-indigo-400">${vEsc}</span>`;
        if (/prediction\.stats/i.test(val))        return `<span class="text-slate-600 text-[10px]">type: </span><span class="text-yellow-400">${vEsc}</span>`;
        if (/prediction|completion/i.test(val))    return `<span class="text-slate-600 text-[10px]">type: </span><span class="text-emerald-400">${vEsc}</span>`;
        return `<span class="text-slate-600 text-[10px]">type: </span><span class="text-slate-300">${vEsc}</span>`;
      }
      if (key === 'timestamp')                       return `<span class="text-slate-700">${e}</span>`;
      if (key === 'modelidentifier' || key === 'modelpath') return `<span class="text-slate-500">${e}</span>`;
      return `<span class="text-slate-500 text-[10px]">${key}: </span><span class="text-slate-400">${vEsc}</span>`;
    }

    // Legacy bracket-style and free-text fallbacks
    if (/\[error\]|\bERROR\b/i.test(line))  return `<span class="text-red-400">${e}</span>`;
    if (/\[warn\]|\bWARN\b/i.test(line))    return `<span class="text-orange-400">${e}</span>`;
    if (/\[debug\]|\bDEBUG\b/i.test(line))  return `<span class="text-slate-600">${e}</span>`;
    if (/\[runtime\]/i.test(line))          return `<span class="text-slate-500">${e}</span>`;
    return `<span class="text-emerald-400/80">${e}</span>`;
  }
}
