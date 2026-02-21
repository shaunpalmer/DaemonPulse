/**
 * PulseView — Module 3: The Pulse (Live Inference)
 *
 * Spec reference: docs/LMStudioDaemon.md section 6, 7
 * PRD reference:  docs/LMS Admin-PRD.txt Module 3
 *
 * Features:
 *   - Model selector populated from /api/v0/models
 *   - System prompt (optional, collapsible)
 *   - Streaming inference via /api/proxy/chat/completions/stream (SSE)
 *   - <think> tag interception → Reasoning panel (DeepSeek R1, QwQ, etc.)
 *   - Live stats: tokens/sec, TTFT, generation time, stop reason
 *   - Per-request history with stats replay
 *   - Continuous batching slot monitor (4 slots visual)
 */

import { AuthService } from '@/services/AuthService';
import { renderStatusBadge } from '@/views/components/StatusBadge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IInferenceStats {
  tokens_per_second:   number;
  time_to_first_token: number;
  generation_time:     number;
  stop_reason:         string;
  total_tokens:        number;
  prompt_tokens:       number;
  completion_tokens:   number;
}

interface IHistoryEntry {
  id:        string;
  model:     string;
  prompt:    string;
  response:  string;
  reasoning: string;
  stats:     IInferenceStats;
  ts:        Date;
}

interface IStreamDelta {
  choices?: Array<{
    delta:         { content?: string; reasoning_content?: string };
    finish_reason: string | null;
  }>;
  stats?: {
    tokens_per_second:    number;
    time_to_first_token:  number;
    generation_time:      number;
    stop_reason:          string;
  };
  usage?: {
    prompt_tokens:     number;
    completion_tokens: number;
    total_tokens:      number;
  };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtMs(s: number): string {
  return s < 1 ? `${(s * 1000).toFixed(0)}ms` : `${s.toFixed(2)}s`;
}

// ---------------------------------------------------------------------------
// PulseView
// ---------------------------------------------------------------------------

export class PulseView {
  private models:       string[]           = [];
  private selectedModel = '';
  private systemPrompt  = '';
  private showSystem    = false;
  private temperature   = 0.7;
  private maxTokens     = 1024;

  private streaming     = false;
  private responseText  = '';
  private reasoningText = '';
  private inThinkBlock  = false;
  private lastStats:    IInferenceStats | null = null;

  private history:         IHistoryEntry[] = [];
  private historyVisible   = false;

  constructor(private readonly root: HTMLElement) {}

  mount(): void {
    this.render();
    void this.fetchModels();
  }

  unmount(): void { /* stateless */ }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  private async fetchModels(): Promise<void> {
    try {
      const res  = await fetch('/api/proxy/models', {
        headers: { Authorization: `Bearer ${AuthService.getToken() ?? ''}` },
      });
      if (!res.ok) return;
      const json = await res.json() as { data?: Array<{ id: string; state: string; type: string }> };
      this.models = (json.data ?? [])
        .filter(m => m.type !== 'embeddings')
        .sort((a, b) => {
          if (a.state === 'loaded' && b.state !== 'loaded') return -1;
          if (a.state !== 'loaded' && b.state === 'loaded') return  1;
          return a.id.localeCompare(b.id);
        })
        .map(m => m.id);
      if (!this.selectedModel && this.models.length > 0) {
        this.selectedModel = this.models[0] ?? '';
      }
    } catch { /* keep empty */ }
    this.render();
    this.bindEvents();
  }

  // ---------------------------------------------------------------------------
  // Inference
  // ---------------------------------------------------------------------------

  private async sendPrompt(userPrompt: string): Promise<void> {
    if (this.streaming || !userPrompt.trim() || !this.selectedModel) return;

    this.streaming     = true;
    this.responseText  = '';
    this.reasoningText = '';
    this.inThinkBlock  = false;
    this.lastStats     = null;
    this.render();
    this.bindEvents();

    const messages: Array<{ role: string; content: string }> = [];
    if (this.systemPrompt.trim()) {
      messages.push({ role: 'system', content: this.systemPrompt.trim() });
    }
    messages.push({ role: 'user', content: userPrompt.trim() });

    const startTs = performance.now();
    let   firstTokenMs: number | null = null;

    try {
      const res = await fetch('/api/proxy/chat/completions/stream', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization:  `Bearer ${AuthService.getToken() ?? ''}`,
        },
        body: JSON.stringify({
          model:                 this.selectedModel,
          messages,
          temperature:           this.temperature,
          max_tokens:            this.maxTokens,
          stream:                true,
          // contextOverflowPolicy is a per-inference parameter; read the preference
          // saved by ForgeView (or the default) at inference time.
          contextOverflowPolicy: localStorage.getItem('dp_overflow_policy') ?? 'rollingWindow',
        }),
      });

      if (!res.ok || !res.body) {
        this.responseText = `⚠ HTTP ${res.status}`;
        this.streaming    = false;
        this.render(); this.bindEvents();
        return;
      }

      const reader   = res.body.getReader();
      const dec      = new TextDecoder();
      let   leftover = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        leftover += dec.decode(value, { stream: true });
        const lines = leftover.split('\n');
        leftover = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const raw = trimmed.slice(5).trim();
          if (raw === '[DONE]') continue;

          try {
            const chunk = JSON.parse(raw) as IStreamDelta;

            if (chunk.stats && chunk.usage) {
              this.lastStats = {
                tokens_per_second:   chunk.stats.tokens_per_second,
                time_to_first_token: chunk.stats.time_to_first_token,
                generation_time:     chunk.stats.generation_time,
                stop_reason:         chunk.stats.stop_reason,
                total_tokens:        chunk.usage.total_tokens,
                prompt_tokens:       chunk.usage.prompt_tokens,
                completion_tokens:   chunk.usage.completion_tokens,
              };
            }

            const choice = chunk.choices?.[0];
            if (!choice) continue;

            const reasoning = choice.delta.reasoning_content ?? '';
            const content   = choice.delta.content ?? '';

            if (reasoning) this.reasoningText += reasoning;

            if (content) {
              if (firstTokenMs === null) firstTokenMs = performance.now() - startTs;
              this.processToken(content);
            }
          } catch { /* skip malformed */ }
        }

        this.updateStreamDisplay();
      }
    } catch (err) {
      this.responseText = `⚠ ${String(err)}`;
    }

    if (!this.lastStats) {
      const elapsed = (performance.now() - startTs) / 1000;
      this.lastStats = {
        tokens_per_second:   0,
        time_to_first_token: (firstTokenMs ?? 0) / 1000,
        generation_time:     elapsed,
        stop_reason:         'unknown',
        total_tokens:        0,
        prompt_tokens:       0,
        completion_tokens:   0,
      };
    }

    this.history.unshift({
      id:        crypto.randomUUID(),
      model:     this.selectedModel,
      prompt:    userPrompt.trim(),
      response:  this.responseText,
      reasoning: this.reasoningText,
      stats:     this.lastStats,
      ts:        new Date(),
    });
    if (this.history.length > 20) this.history.length = 20;

    this.streaming = false;
    this.render();
    this.bindEvents();
  }

  /** State machine: route tokens between reasoningText and responseText */
  private processToken(token: string): void {
    let remaining = token;
    while (remaining.length > 0) {
      if (this.inThinkBlock) {
        const closeIdx = remaining.indexOf('</think>');
        if (closeIdx === -1) {
          this.reasoningText += remaining;
          remaining = '';
        } else {
          this.reasoningText  += remaining.slice(0, closeIdx);
          remaining            = remaining.slice(closeIdx + 8);
          this.inThinkBlock    = false;
        }
      } else {
        const openIdx = remaining.indexOf('<think>');
        if (openIdx === -1) {
          this.responseText += remaining;
          remaining = '';
        } else {
          this.responseText += remaining.slice(0, openIdx);
          remaining          = remaining.slice(openIdx + 7);
          this.inThinkBlock  = true;
        }
      }
    }
  }

  /** Partial DOM update during streaming — avoids full re-render on every chunk */
  private updateStreamDisplay(): void {
    const responseEl  = document.getElementById('pulse-response-text');
    const reasoningEl = document.getElementById('pulse-reasoning-text');
    const cursor      = document.getElementById('pulse-cursor');

    if (responseEl) {
      responseEl.textContent = this.responseText;
      if (cursor) responseEl.appendChild(cursor);
    }
    if (this.reasoningText) {
      const panel = document.getElementById('pulse-reasoning-panel');
      if (panel) panel.classList.remove('hidden');
      if (reasoningEl) reasoningEl.textContent = this.reasoningText;
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  private render(): void {
    this.root.innerHTML = `
      <div class="space-y-5 max-w-5xl">

        <!-- Header -->
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-lg font-bold text-white tracking-tight">The Pulse</h2>
            <p class="text-xs text-slate-500 mt-0.5">Live inference · streaming · agentic reasoning</p>
          </div>
          <button id="pulse-history-toggle"
            class="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-700
                   text-xs font-semibold text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-all">
            ↩ History
            ${this.history.length > 0
              ? `<span class="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400 text-[10px] font-mono">${this.history.length}</span>`
              : ''}
          </button>
        </div>

        <!-- Controls -->
        <div class="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
          <div class="flex flex-wrap gap-3 items-end">

            <!-- Model -->
            <div class="flex-1 min-w-48">
              <label class="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Model</label>
              <select id="pulse-model-select"
                class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5
                       text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500">
                ${this.models.length === 0
                  ? `<option value="">Loading models…</option>`
                  : this.models.map(m =>
                      `<option value="${esc(m)}" ${m === this.selectedModel ? 'selected' : ''}>${esc(m)}</option>`
                    ).join('')}
              </select>
            </div>

            <!-- Temperature -->
            <div class="w-36">
              <label class="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                Temperature <span id="pulse-temp-label" class="text-slate-400 font-mono">${this.temperature.toFixed(2)}</span>
              </label>
              <input id="pulse-temp" type="range" min="0" max="2" step="0.05" value="${this.temperature}"
                class="w-full accent-indigo-500 cursor-pointer">
            </div>

            <!-- Max tokens -->
            <div class="w-28">
              <label class="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Max tokens</label>
              <input id="pulse-max-tokens" type="number" min="1" max="32768" value="${this.maxTokens}"
                class="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5
                       text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500">
            </div>

            <!-- System toggle -->
            <button id="pulse-system-toggle"
              class="px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all
                     ${this.showSystem
                       ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-400'
                       : 'border-slate-700 text-slate-500 hover:text-slate-300 hover:border-slate-600'}">
              ⚙ System
            </button>
          </div>

          ${this.showSystem ? `
            <div>
              <label class="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">System Prompt</label>
              <textarea id="pulse-system-input" rows="2"
                placeholder="You are a helpful assistant…"
                class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2
                       text-xs text-slate-200 font-mono resize-none focus:outline-none focus:border-indigo-500"
              >${esc(this.systemPrompt)}</textarea>
            </div>
          ` : ''}
        </div>

        <!-- Response area -->
        <div class="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden">

          <!-- Reasoning panel -->
          <div id="pulse-reasoning-panel" class="${this.reasoningText ? '' : 'hidden'}">
            <div class="border-b border-slate-800 px-4 py-2.5 flex items-center gap-2 bg-indigo-500/5">
              <span class="text-indigo-400 text-[11px] font-mono">&lt;think&gt;</span>
              <span class="text-[10px] font-bold uppercase tracking-wider text-slate-500">Reasoning</span>
              <span class="text-[10px] text-slate-600 ml-auto font-mono">
                ${this.reasoningText ? `${this.reasoningText.split(/\s+/).filter(Boolean).length} words` : ''}
              </span>
            </div>
            <div class="px-4 py-3 max-h-48 overflow-y-auto">
              <p id="pulse-reasoning-text"
                class="text-[11px] font-mono text-indigo-300/60 whitespace-pre-wrap leading-relaxed">
                ${esc(this.reasoningText)}
              </p>
            </div>
          </div>

          <!-- Main response -->
          <div class="px-5 py-4 min-h-32 max-h-[28rem] overflow-y-auto">
            ${!this.streaming && !this.responseText && !this.lastStats
              ? `<p class="text-slate-700 text-xs font-mono select-none">
                   Ready — enter a prompt below and press Send (or Ctrl+Enter)
                 </p>`
              : `<p id="pulse-response-text"
                    class="text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">
                   ${esc(this.responseText)}${this.streaming
                     ? `<span id="pulse-cursor"
                               class="inline-block w-1.5 h-4 bg-indigo-400 ml-0.5 animate-pulse align-middle"></span>`
                     : ''}
                 </p>`
            }
          </div>

          <!-- Stats bar -->
          ${this.lastStats && !this.streaming ? `
            <div class="border-t border-slate-800 px-5 py-2.5 flex flex-wrap gap-5 bg-slate-900/70">
              ${this.renderStat('⚡', 'tok/s',  this.lastStats.tokens_per_second > 0 ? this.lastStats.tokens_per_second.toFixed(1) : '—')}
              ${this.renderStat('⏱', 'TTFT',    fmtMs(this.lastStats.time_to_first_token))}
              ${this.renderStat('⏳', 'Gen',     fmtMs(this.lastStats.generation_time))}
              ${this.renderStat('🔢', 'Tokens',  this.lastStats.completion_tokens > 0 ? String(this.lastStats.completion_tokens) : '—')}
              ${this.renderStat('■', 'Stop',    this.lastStats.stop_reason)}
            </div>
          ` : this.streaming ? `
            <div class="border-t border-slate-800 px-5 py-2.5 flex items-center gap-2 bg-slate-900/70">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
              <span class="text-[11px] text-emerald-400 font-mono">Generating…</span>
            </div>
          ` : ''}
        </div>

        <!-- Prompt input -->
        <div class="flex gap-3">
          <textarea id="pulse-prompt-input" rows="3"
            placeholder="Type your message… (Ctrl+Enter to send)"
            ${this.streaming ? 'disabled' : ''}
            class="flex-1 bg-slate-900 border ${this.streaming ? 'border-slate-800 opacity-50' : 'border-slate-700'}
                   rounded-xl px-4 py-3 text-sm text-slate-200 resize-none
                   focus:outline-none focus:border-indigo-500 transition-colors"
          ></textarea>
          <button id="pulse-send-btn"
            ${this.streaming || this.models.length === 0 ? 'disabled' : ''}
            class="px-6 rounded-xl border text-sm font-bold transition-all self-stretch min-w-[4.5rem]
                   ${this.streaming || this.models.length === 0
                     ? 'border-slate-800 text-slate-600 cursor-not-allowed bg-slate-900'
                     : 'border-indigo-500/40 bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 cursor-pointer'}">
            ${this.streaming ? '…' : 'Send'}
          </button>
        </div>

        <!-- Slot monitor -->
        ${this.renderSlotMonitor()}

        <!-- History -->
        ${this.historyVisible && this.history.length > 0 ? this.renderHistory() : ''}

      </div>
    `;

    this.bindEvents();
  }

  private renderStat(icon: string, label: string, value: string): string {
    return `
      <div class="flex items-center gap-1.5">
        <span class="text-[11px]">${icon}</span>
        <span class="text-[10px] uppercase tracking-wider text-slate-600">${label}</span>
        <span class="text-xs font-mono font-bold text-slate-300">${esc(value)}</span>
      </div>
    `;
  }

  private renderSlotMonitor(): string {
    const slots = [1, 2, 3, 4].map((id, i) => ({ id, active: this.streaming && i === 0 }));
    return `
      <section>
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-[10px] font-bold uppercase tracking-wider text-slate-600">Continuous Batching — 4 Slots</h3>
          <span class="text-[10px] text-slate-700 font-mono">n_parallel: 4 (default)</span>
        </div>
        <div class="grid grid-cols-4 gap-2">
          ${slots.map(s => `
            <div class="bg-slate-900 border ${s.active ? 'border-indigo-500/40' : 'border-slate-800'}
                        rounded-lg p-3 text-center transition-colors">
              <p class="text-[10px] text-slate-600 font-mono mb-1.5">Slot ${s.id}</p>
              ${s.active ? renderStatusBadge('Active', 'active') : renderStatusBadge('Idle', 'idle')}
            </div>
          `).join('')}
        </div>
        <p class="text-[10px] text-slate-700 mt-1.5">
          Per-slot tok/s and request IDs will populate once LM Studio exposes slot telemetry via REST.
        </p>
      </section>
    `;
  }

  private renderHistory(): string {
    return `
      <section>
        <h3 class="text-[10px] font-bold uppercase tracking-wider text-slate-600 mb-2">Recent Requests</h3>
        <div class="space-y-2">
          ${this.history.slice(0, 5).map(h => `
            <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <div class="flex items-center justify-between gap-3 mb-1.5">
                <p class="text-[11px] font-mono text-slate-500 truncate">${esc(h.model)}</p>
                <span class="text-[10px] text-slate-700 font-mono flex-shrink-0">${h.ts.toLocaleTimeString()}</span>
              </div>
              <p class="text-xs text-slate-500 truncate mb-1">
                <span class="text-slate-700">→ </span>${esc(h.prompt)}
              </p>
              <p class="text-xs text-slate-600 line-clamp-2">${esc(h.response)}</p>
              <div class="flex gap-4 mt-2 pt-2 border-t border-slate-800">
                ${this.renderStat('⚡', 'tok/s', h.stats.tokens_per_second > 0 ? h.stats.tokens_per_second.toFixed(1) : '—')}
                ${this.renderStat('⏱', 'TTFT',   fmtMs(h.stats.time_to_first_token))}
                ${this.renderStat('⏳', 'Gen',    fmtMs(h.stats.generation_time))}
              </div>
            </div>
          `).join('')}
        </div>
      </section>
    `;
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  private bindEvents(): void {
    document.getElementById('pulse-model-select')?.addEventListener('change', (e) => {
      this.selectedModel = (e.target as HTMLSelectElement).value;
    });

    const tempEl = document.getElementById('pulse-temp') as HTMLInputElement | null;
    tempEl?.addEventListener('input', () => {
      this.temperature = parseFloat(tempEl.value);
      const label = document.getElementById('pulse-temp-label');
      if (label) label.textContent = this.temperature.toFixed(2);
    });

    document.getElementById('pulse-max-tokens')?.addEventListener('change', (e) => {
      const n = parseInt((e.target as HTMLInputElement).value, 10);
      if (!isNaN(n) && n > 0) this.maxTokens = n;
    });

    document.getElementById('pulse-system-toggle')?.addEventListener('click', () => {
      this.showSystem = !this.showSystem;
      this.render();
    });

    document.getElementById('pulse-system-input')?.addEventListener('input', (e) => {
      this.systemPrompt = (e.target as HTMLTextAreaElement).value;
    });

    document.getElementById('pulse-send-btn')?.addEventListener('click', () => {
      const ta = document.getElementById('pulse-prompt-input') as HTMLTextAreaElement | null;
      if (ta?.value.trim()) void this.sendPrompt(ta.value);
    });

    document.getElementById('pulse-prompt-input')?.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === 'Enter' && (ke.ctrlKey || ke.metaKey)) {
        const ta = e.target as HTMLTextAreaElement;
        if (ta.value.trim()) void this.sendPrompt(ta.value);
      }
    });

    document.getElementById('pulse-history-toggle')?.addEventListener('click', () => {
      this.historyVisible = !this.historyVisible;
      this.render();
    });
  }
}
