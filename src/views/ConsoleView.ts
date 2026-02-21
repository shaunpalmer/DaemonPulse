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

export class ConsoleView {
  private logLines:    string[]    = [];
  private levelFilter: LogLevel    = 'all';
  private paused       = false;
  private connected    = false;
  private autoScroll   = true;
  private abortCtrl:   AbortController | null = null;

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
  }

  // ---------------------------------------------------------------------------
  // SSE connection via fetch() — supports Authorization header unlike EventSource
  // ---------------------------------------------------------------------------

  private async connectLogs(): Promise<void> {
    this.abortCtrl?.abort();
    this.abortCtrl = new AbortController();
    this.connected = false;
    this.updateStatusBar('connecting');

    try {
      const res = await fetch('/api/proxy/logs/stream', {
        headers: { Authorization: `Bearer ${AuthService.getToken() ?? ''}` },
        signal:  this.abortCtrl.signal,
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
              Raw daemon output ·
              <span class="font-mono">lms log stream -s runtime</span>
            </p>
          </div>
          <div class="flex items-center gap-2">
            <span id="console-status-dot"
              class="w-1.5 h-1.5 rounded-full ${this.connected ? 'bg-emerald-400 animate-pulse' : 'bg-yellow-400 animate-pulse'}">
            </span>
            <span id="console-status-text"
              class="text-[10px] font-mono text-slate-500">
              ${this.connected ? 'Live' : 'Connecting…'}
            </span>
          </div>
        </div>

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

      </div>
    `;

    this.bindEvents();
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  private bindEvents(): void {
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
