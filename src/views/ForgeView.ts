/**
 * ForgeView — Module 2: The Forge (Model Lifecycle)
 *
 * Spec reference: docs/LMStudioDaemon.md section 5
 * PRD reference:  docs/LMS Admin-PRD.txt Module 2
 *
 * JIT-aware model management:
 *   - "In VRAM" — models currently resident in GPU memory
 *   - "On Disk — JIT Loadable" — downloaded models auto-loaded on first inference call
 *
 * LM Studio JIT behaviour (0.3+):
 *   JIT ON  → /api/v1/models returns ALL downloaded models; inference auto-loads on-demand
 *   JIT OFF → /api/v1/models returns only models already loaded into VRAM
 */

import { renderStatusBadge } from '@/views/components/StatusBadge';
import type { LMSModelRecord } from '@/services/DaemonService';
import { AuthService, AuthRedirectError } from '@/services/AuthService';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Load Wizard state
// ---------------------------------------------------------------------------

interface IEstimateResult {
  model?:                     string;
  context_length?:            string;
  estimated_gpu_memory?:      number;
  estimated_total_memory?:    number;
  raw?:                       string;
  [k: string]:                unknown;
}

export class ForgeView {
  private models:    LMSModelRecord[] = [];
  private loading    = true;
  private error:     string | null    = null;
  private actionId:  string | null    = null;   // model currently being loaded or ejected
  private actionErr: string | null    = null;

  // Load streaming state
  private loadProgress:   string[]    = [];
  private loadInstanceId: string | null = null;

  // Load Wizard
  private wizardModel      = '';
  private wizardCtxLen     = 4096;
  private wizardNParallel  = 4;
  private wizardGpu        = 'max';  // 'max' | 'off' | fraction e.g. '0.5'
  private wizardOverflow:  'rollingWindow' | 'stopAtLimit' | 'truncateMiddle' = 'rollingWindow';
  private wizardTtl        = 0;       // seconds; 0 = never auto-unload
  private wizardEstimating = false;
  private wizardEstimate:  IEstimateResult | null = null;
  private wizardEstErr:    string | null = null;
  // Reasoning block tags — persisted to localStorage and read by PulseView
  private wizardThinkStart = '<think>';
  private wizardThinkEnd   = '</think>';

  constructor(private readonly root: HTMLElement) {}

  mount(): void {
    // Read defaults saved from SettingsView
    const ttl = parseInt(localStorage.getItem('dp_default_ttl') ?? '0', 10);
    const np  = parseInt(localStorage.getItem('dp_default_n_parallel') ?? '4', 10);
    const ctx = parseInt(localStorage.getItem('dp_default_context') ?? '4096', 10);
    if (!isNaN(ttl)) this.wizardTtl       = ttl;
    if (!isNaN(np))  this.wizardNParallel = np;
    if (!isNaN(ctx)) this.wizardCtxLen    = ctx;
    this.render();
    void this.fetchModels();
  }

  unmount(): void { /* stateless — nothing to tear down */ }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  private async fetchModels(): Promise<void> {
    try {
      const res = await AuthService.apiFetch('/api/proxy/models');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: LMSModelRecord[] };
      // Sort: loaded first, then alphabetically within each group
      this.models = (json.data ?? []).sort((a, b) => {
        if (a.state === 'loaded' && b.state !== 'loaded') return -1;
        if (a.state !== 'loaded' && b.state === 'loaded') return  1;
        return a.id.localeCompare(b.id);
      });
      this.loading = false;
      this.error   = null;
    } catch (err) {
      if (err instanceof AuthRedirectError) return; // redirect in progress — do not render error banner
      this.loading = false;
      this.error   = String(err);
    }
    this.render();
    this.bindEvents();
  }

  private async handleLoad(id: string): Promise<void> {
    this.actionId      = id;
    this.actionErr     = null;
    this.loadProgress  = [];
    this.loadInstanceId = null;
    this.render();
    this.bindEvents();

    try {
      // contextOverflowPolicy is a per-inference parameter (LLMPredictionConfigInput),
      // NOT a load-time setting.  Persist the selection here so PulseView can pick it up.
      localStorage.setItem('dp_overflow_policy', this.wizardOverflow);

      const res = await fetch('/api/proxy/models/load', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization:  `Bearer ${AuthService.getToken() ?? ''}`,
        },
        body: JSON.stringify({
          identifier:     id,
          context_length: this.wizardCtxLen,
          n_parallel:     this.wizardNParallel,
          gpu:            this.wizardGpu === 'off' || this.wizardGpu === 'max'
                            ? this.wizardGpu
                            : parseFloat(this.wizardGpu),
          ttl:            this.wizardTtl > 0 ? this.wizardTtl : undefined,
        }),
      });

      if (!res.ok) {
        this.actionErr = `Load failed (HTTP ${res.status})`;
      } else if (res.body) {
        // /api/v1/models/load streams JSON-line progress events then the final instance_id
        const reader = res.body.getReader();
        const dec    = new TextDecoder();
        let   buf    = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';

          for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            // Parse JSON progress chunks
            try {
              const chunk = JSON.parse(t) as Record<string, unknown>;
              if (chunk['instance_id']) this.loadInstanceId = String(chunk['instance_id']);
              const msg = chunk['message'] ?? chunk['type'] ?? chunk['progress'];
              if (msg != null) this.loadProgress.push(String(msg));
            } catch {
              this.loadProgress.push(t);
            }
            // Live-append to progress log without full re-render
            const el = document.getElementById('forge-load-progress');
            if (el) {
              const p = document.createElement('p');
              p.className = 'text-[10px] font-mono text-slate-400';
              p.textContent = this.loadProgress[this.loadProgress.length - 1] ?? '';
              el.appendChild(p);
              el.scrollTop = el.scrollHeight;
            }
          }
        }
      }
    } catch (err) {
      this.actionErr = String(err);
    }

    this.actionId = null;
    await new Promise(r => setTimeout(r, 600));
    this.loading = true;
    this.render();
    void this.fetchModels();
  }

  private async handleEject(id: string): Promise<void> {
    this.actionId  = id;
    this.actionErr = null;
    this.render();
    this.bindEvents();
    try {
      const res = await fetch('/api/proxy/models/eject', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization:  `Bearer ${AuthService.getToken() ?? ''}`,
        },
        body: JSON.stringify({ identifier: id }),
      });
      if (!res.ok) this.actionErr = `Eject failed (HTTP ${res.status})`;
    } catch (err) {
      this.actionErr = String(err);
    }
    this.actionId = null;
    this.loading  = true;
    this.render();
    void this.fetchModels();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  private render(): void {
    const loaded    = this.models.filter(m => m.state === 'loaded');
    const available = this.models.filter(m => m.state !== 'loaded');
    const jitActive = available.length > 0;

    this.root.innerHTML = `
      <div class="space-y-6 max-w-6xl">

        <!-- Header -->
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-lg font-bold text-white tracking-tight">The Forge</h2>
            <p class="text-xs text-slate-500 mt-0.5">Model lifecycle · VRAM management · JIT loading</p>
          </div>
          <button data-forge-action="refresh"
            class="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-700
                   text-xs font-semibold text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-all">
            <span class="text-base leading-none">↻</span> Refresh
          </button>
        </div>

        ${this.loading ? `
          <div class="text-slate-500 text-xs font-mono p-4">Fetching from LM Studio…</div>
        ` : this.error ? `
          <div class="flex gap-3 bg-red-500/10 border border-red-500/20 rounded-xl p-4">
            <span class="text-red-400">⚠</span>
            <p class="text-xs font-mono text-red-300">${esc(this.error)}</p>
          </div>
        ` : `

          ${this.actionErr ? `
            <div class="flex gap-3 bg-red-500/10 border border-red-500/20 rounded-xl p-3">
              <span class="text-red-400 text-xs">⚠</span>
              <p class="text-xs font-mono text-red-300">${esc(this.actionErr)}</p>
            </div>
          ` : ''}

          <!-- JIT mode banner -->
          ${jitActive ? `
            <div class="flex items-start gap-3 bg-indigo-500/5 border border-indigo-500/20 rounded-xl p-4">
              <span class="text-indigo-400 text-sm flex-shrink-0">⚡</span>
              <div>
                <p class="text-xs font-semibold text-indigo-300">
                  Just-In-Time Loading Active
                  <span class="ml-2 inline-block px-1.5 py-0.5 rounded text-[10px] bg-indigo-500/20 text-indigo-400 font-mono">JIT ON</span>
                </p>
                <p class="text-[11px] text-indigo-400/60 mt-0.5">
                  ${available.length} model${available.length !== 1 ? 's' : ''} on disk will auto-load into VRAM on first inference call.
                  JIT-loaded models are auto-unloaded after inactivity.
                  Configure in LM Studio → Settings.
                </p>
              </div>
            </div>
          ` : ''}

          <!-- In VRAM section -->
          <section>
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-[11px] font-bold uppercase tracking-wider text-slate-500">In VRAM</h3>
              <span class="text-[10px] text-slate-600 font-mono">${loaded.length} resident</span>
            </div>
            ${loaded.length === 0
              ? `<div class="bg-slate-900 border border-slate-800 rounded-xl p-4 text-center text-slate-600 text-xs font-mono">
                   ${jitActive ? 'No models in VRAM — will JIT-load on first call' : 'No models loaded in LM Studio'}
                 </div>`
              : `<div class="space-y-3">${loaded.map(m => this.renderCard(m, 'loaded')).join('')}</div>`
            }
          </section>

          <!-- JIT-loadable section (only shown when JIT is active) -->
          ${jitActive ? `
            <section>
              <div class="flex items-center justify-between mb-3">
                <h3 class="text-[11px] font-bold uppercase tracking-wider text-slate-500">On Disk — JIT Loadable</h3>
                <span class="text-[10px] text-slate-600 font-mono">${available.length} available</span>
              </div>
              <div class="space-y-3">${available.map(m => this.renderCard(m, 'available')).join('')}</div>
            </section>
          ` : ''}

          <!-- Load Wizard -->
          ${this.renderLoadWizard()}
        `}

      </div>
    `;

    this.bindEvents();
  }

  // ---------------------------------------------------------------------------
  // Load Wizard render
  // ---------------------------------------------------------------------------

  private renderLoadWizard(): string {
    const allModels = this.models;
    const est = this.wizardEstimate;

    const gpuGb    = est?.estimated_gpu_memory   ?? null;
    const totalGb  = est?.estimated_total_memory  ?? null;

    // Find actual usage from loaded model for overlay
    const actualGb = this.wizardModel
      ? null   // lms ps data not available synchronously here — shown via Memory State in Fleet
      : null;

    // Detect reasoning model (DeepSeek R1 / QwQ / etc.)
    const isReasoning = /r1|qwq|thinking|deepseek-r1/i.test(this.wizardModel);

    // Dev mode gates advanced sliders — Live mode locks to production presets
    const devMode = localStorage.getItem('dp_developer_mode') === 'true';
    const locked  = !devMode;

    return `
      <section class="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div class="flex items-center gap-3 px-5 py-3.5 border-b border-slate-800 bg-slate-900/60">
          <span class="text-indigo-400">⚙</span>
          <h3 class="text-sm font-bold text-slate-200">Load Wizard</h3>
          <span class="text-[10px] text-slate-600 ml-auto">Pre-flight · VRAM estimate · runtime params</span>
        </div>

        <div class="p-5 space-y-4">

          <!-- Row 1: model + context length -->
          <div class="flex flex-wrap gap-3">
            <div class="flex-1 min-w-48">
              <label class="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Model</label>
              <select id="wiz-model"
                class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5
                       text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500">
                <option value="">— select —</option>
                ${allModels.map(m =>
                  `<option value="${esc(m.id)}" ${m.id === this.wizardModel ? 'selected' : ''}>${esc(m.id)}</option>`
                ).join('')}
              </select>
            </div>
            <div class="w-32">
              <label class="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Context</label>
              <input id="wiz-ctx" type="number" min="512" max="131072" step="512" value="${this.wizardCtxLen}"
                class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5
                       text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500">
            </div>
            <div class="w-32">
              <label class="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                Idle TTL
                <span class="text-slate-600 normal-case tracking-normal font-normal">
                  ${this.wizardTtl > 0 ? `${this.wizardTtl}s` : 'never'}
                </span>
              </label>
              <input id="wiz-ttl" type="range" min="0" max="3600" step="60" value="${this.wizardTtl}"
                class="w-full accent-indigo-500 cursor-pointer">
            </div>
            <div class="w-28">
              ${locked ? `
                <label class="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                  Slots (n‖parallel)
                </label>
                <div class="flex items-center gap-1.5">
                  <span class="text-slate-600 text-[10px]">&#128274;</span>
                  <span class="font-mono text-slate-600 text-[11px]">${this.wizardNParallel} (preset)</span>
                </div>
              ` : `
                <label class="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                  Slots (n‖parallel)
                  <span id="wiz-np-label" class="text-slate-400 font-mono normal-case tracking-normal">${this.wizardNParallel}</span>
                </label>
                <input id="wiz-np" type="range" min="1" max="16" step="1" value="${this.wizardNParallel}"
                  class="w-full accent-indigo-500 cursor-pointer">
              `}
            </div>
          </div>

          <!-- Row 2: GPU offload + context overflow policy -->
          <div class="flex flex-wrap items-start gap-6">
            <div>
              <label class="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                GPU Offload
              </label>
              ${locked ? `
                <div class="flex items-center gap-1.5">
                  <span class="text-slate-600 text-[10px]">&#128274;</span>
                  <span class="font-mono text-slate-600 text-[11px]">max (preset)</span>
                </div>
              ` : `
                <select id="wiz-gpu"
                  class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5
                         text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500 cursor-pointer">
                  ${(['max','1.0','0.75','0.5','0.25','off'] as const).map(v => `
                    <option value="${v}" ${this.wizardGpu === v ? 'selected' : ''}>
                      ${v === 'max' ? 'max — all VRAM' : v === 'off' ? 'off — CPU only' : `${Math.round(parseFloat(v)*100)}% VRAM`}
                    </option>
                  `).join('')}
                </select>
              `}
            </div>
            <div>
              <label class="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                Context Overflow
              </label>
              <div class="flex rounded-lg overflow-hidden border border-slate-700 w-fit">
                ${([
                  ['rollingWindow',  'Rolling'],
                  ['stopAtLimit',    'Stop'],
                  ['truncateMiddle', 'Truncate'],
                ] as const).map(([val, label]) => `
                  <button data-wiz-overflow="${val}"
                    class="wiz-overflow-btn px-3 py-1.5 text-[10px] font-semibold transition-colors cursor-pointer
                           border-r border-slate-700 last:border-r-0
                           ${this.wizardOverflow === val
                             ? 'bg-indigo-600/20 text-indigo-400'
                             : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'}"
                  >${label}</button>
                `).join('')}
              </div>
              <p class="text-[10px] text-slate-600 mt-1">
                ${{ rollingWindow: 'Slides window — drops oldest turns.',
                    stopAtLimit:   'Halts generation at the context limit.',
                    truncateMiddle:'Removes middle tokens — keeps prompt + recent.' }[this.wizardOverflow]}
              </p>
            </div>
          </div>

          ${isReasoning ? `
            <div class="bg-indigo-500/5 border border-indigo-500/20 rounded-lg px-4 py-3 space-y-2.5">
              <div class="flex items-center gap-2">
                <span class="text-indigo-400">🧠</span>
                <p class="text-[11px] font-semibold text-indigo-300">Reasoning model detected</p>
              </div>
              <div class="flex flex-wrap gap-4">
                <div>
                  <label class="block text-[10px] text-indigo-400/60 mb-0.5">Think start tag</label>
                  <input id="wiz-think-start" type="text" value="${esc(this.wizardThinkStart)}"
                    class="bg-slate-950 border border-indigo-500/30 rounded px-2 py-1
                           text-xs font-mono text-indigo-300 w-28
                           focus:outline-none focus:border-indigo-400">
                </div>
                <div>
                  <label class="block text-[10px] text-indigo-400/60 mb-0.5">Think end tag</label>
                  <input id="wiz-think-end" type="text" value="${esc(this.wizardThinkEnd)}"
                    class="bg-slate-950 border border-indigo-500/30 rounded px-2 py-1
                           text-xs font-mono text-indigo-300 w-28
                           focus:outline-none focus:border-indigo-400">
                </div>
              </div>
              <p class="text-[10px] text-indigo-400/40">
                Saved to localStorage — PulseView uses these tags to parse &lt;think&gt; blocks.
              </p>
            </div>
          ` : ''}

          <!-- Load progress log (shown while loading is active) -->
          ${this.actionId ? `
            <div>
              <p class="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Load Progress</p>
              <div id="forge-load-progress"
                class="bg-slate-950 border border-slate-800 rounded-lg px-4 py-3
                       max-h-36 overflow-y-auto space-y-0.5 font-mono text-[10px] text-slate-400">
                ${this.loadProgress.length === 0
                  ? '<p class="text-slate-700">Initiating…</p>'
                  : this.loadProgress.map(l => `<p>${esc(l)}</p>`).join('')}
              </div>
              ${this.loadInstanceId
                ? `<p class="text-[10px] font-mono text-emerald-400 mt-1.5">
                     ✓ instance_id: ${esc(this.loadInstanceId)}
                   </p>`
                : ''}
            </div>
          ` : ''}

          <!-- Estimate + result -->
          <div class="flex flex-wrap items-start gap-4">

            <button id="wiz-estimate-btn"
              ${!this.wizardModel || this.wizardEstimating ? 'disabled' : ''}
              class="px-4 py-2 rounded-lg border text-xs font-bold transition-all
                     ${!this.wizardModel || this.wizardEstimating
                       ? 'border-slate-800 text-slate-600 cursor-not-allowed'
                       : 'border-indigo-500/40 bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 cursor-pointer'}">
              ${this.wizardEstimating ? '⏳ Estimating…' : '📐 Estimate VRAM'}
            </button>

            ${this.wizardEstErr ? `
              <p class="text-xs text-red-400 font-mono self-center">
                ⚠ ${esc(this.wizardEstErr)}
              </p>
            ` : est ? `
              <div class="flex flex-wrap gap-5 bg-slate-950 border border-slate-800 rounded-lg px-5 py-3">
                ${gpuGb !== null ? `
                  <div>
                    <p class="text-[10px] text-slate-600 uppercase tracking-wider">GPU Memory</p>
                    <p class="text-base font-mono font-bold ${
                      gpuGb > 20 ? 'text-red-400' : gpuGb > 12 ? 'text-orange-400' : 'text-emerald-400'
                    }">${gpuGb.toFixed(2)} GB</p>
                  </div>
                ` : ''}
                ${totalGb !== null ? `
                  <div>
                    <p class="text-[10px] text-slate-600 uppercase tracking-wider">Total Memory</p>
                    <p class="text-base font-mono font-bold text-slate-300">${totalGb.toFixed(2)} GB</p>
                  </div>
                ` : ''}
                ${est.context_length ? `
                  <div>
                    <p class="text-[10px] text-slate-600 uppercase tracking-wider">Context</p>
                    <p class="text-base font-mono font-bold text-slate-300">${esc(String(est.context_length))}</p>
                  </div>
                ` : ''}
                ${!gpuGb && !totalGb && est.raw ? `
                  <pre class="text-[10px] font-mono text-slate-400 whitespace-pre-wrap">${esc(String(est.raw))}</pre>
                ` : ''}
                <p class="text-[10px] text-slate-700 self-end w-full mt-1">
                  Actual usage will appear in Fleet → Memory State once the model is loaded.
                </p>
              </div>
            ` : ''}

          </div>
        </div>
      </section>
    `;
  }

  private renderCard(m: LMSModelRecord, mode: 'loaded' | 'available'): string {
    // /api/v0/models fields are flat — no nested info object
    const ctx    = m.max_context_length
      ? `${(m.max_context_length / 1024).toFixed(0)}K ctx`
      : null;
    const arch   = m.arch ?? m.type;
    const quant  = m.quantization ?? null;
    const pub    = m.publisher ?? null;
    const compat = m.compatibility_type ?? null;
    const meta   = [pub, arch, quant, compat, ctx].filter(Boolean).join(' · ');

    const isActioning = this.actionId === m.id;

    // Capability badges from model id heuristics
    const isReasoning = /r1|qwq|thinking|deepseek-r1/i.test(m.id);
    const isToolUse   = /tool|hammer|agent|claw|function/i.test(m.id) || m.type === 'tool';
    const isVision    = /vision|vl|llava|phi-?3.*vision/i.test(m.id);
    const capBadges = [
      isReasoning ? `<span title="Reasoning model — supports &lt;think&gt; blocks"
        class="px-1.5 py-0.5 rounded text-[10px] bg-indigo-500/15 text-indigo-400 font-mono">🧠 think</span>` : '',
      isToolUse   ? `<span title="Tool-use optimised"
        class="px-1.5 py-0.5 rounded text-[10px] bg-orange-500/15 text-orange-400 font-mono">🔨 tools</span>` : '',
      isVision    ? `<span title="Vision capable"
        class="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/15 text-emerald-400 font-mono">👁 vision</span>` : '',
    ].filter(Boolean).join('');

    const actionBtn = isActioning
      ? `<button disabled
              class="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-500 text-xs font-semibold
                     cursor-not-allowed opacity-50">
            ⏳ Working…
          </button>`
      : mode === 'loaded'
        ? `<button data-forge-action="eject" data-model-id="${esc(m.id)}"
              class="px-3 py-1.5 rounded-lg border border-red-500/30 bg-red-500/10
                     text-red-400 text-xs font-semibold hover:bg-red-500/20 transition-all cursor-pointer">
            Eject
          </button>`
        : `<button data-forge-action="load" data-model-id="${esc(m.id)}"
              class="px-3 py-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10
                     text-indigo-400 text-xs font-semibold hover:bg-indigo-500/20 transition-all cursor-pointer">
            Load Now
          </button>`;

    const borderColour = mode === 'loaded'
      ? 'border-indigo-500/30'
      : 'border-slate-700';

    const badge = mode === 'loaded'
      ? renderStatusBadge('Resident', 'active')
      : renderStatusBadge('On Disk', 'idle');

    return `
      <div class="bg-slate-900 border ${borderColour} rounded-xl p-4
                  transition-all ${isActioning ? 'opacity-60' : ''}">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0 flex-1">
            <p class="text-sm font-bold text-slate-100 truncate" title="${esc(m.id)}">${esc(m.id)}</p>
            <div class="flex flex-wrap items-center gap-1.5 mt-1">
              <span class="text-[11px] text-slate-500 font-mono">${esc(meta)}</span>
              ${capBadges}
            </div>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            ${badge}
            ${actionBtn}
          </div>
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Event wiring — re-bound after every render
  // ---------------------------------------------------------------------------

  private bindEvents(): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-forge-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset['forgeAction'];
        const id     = btn.dataset['modelId'] ?? '';
        if (action === 'load')    void this.handleLoad(id);
        if (action === 'eject')   void this.handleEject(id);
        if (action === 'refresh') {
          this.loading = true;
          this.error   = null;
          this.render();
          void this.fetchModels();
        }
      });
    });

    // Load Wizard bindings
    (document.getElementById('wiz-model') as HTMLSelectElement | null)
      ?.addEventListener('change', (e) => {
        this.wizardModel    = (e.target as HTMLSelectElement).value;
        this.wizardEstimate = null;
        this.wizardEstErr   = null;
        this.render();
      });

    (document.getElementById('wiz-ctx') as HTMLInputElement | null)
      ?.addEventListener('change', (e) => {
        const n = parseInt((e.target as HTMLInputElement).value, 10);
        if (!isNaN(n) && n >= 512) this.wizardCtxLen = n;
      });

    const ttlEl = document.getElementById('wiz-ttl') as HTMLInputElement | null;
    ttlEl?.addEventListener('input', () => {
      this.wizardTtl = parseInt(ttlEl.value, 10);
      // Update label without full re-render
      const lbl = ttlEl.closest('div')?.querySelector('label span');
      if (lbl) lbl.textContent = this.wizardTtl > 0 ? `${this.wizardTtl}s` : 'never';
    });

    const npEl = document.getElementById('wiz-np') as HTMLInputElement | null;
    npEl?.addEventListener('input', () => {
      const v = parseInt(npEl.value, 10);
      if (!isNaN(v) && v >= 1) {
        this.wizardNParallel = v;
        const lbl = document.getElementById('wiz-np-label');
        if (lbl) lbl.textContent = String(v);
      }
    });

    // GPU offload select
    (document.getElementById('wiz-gpu') as HTMLSelectElement | null)
      ?.addEventListener('change', (e) => {
        this.wizardGpu = (e.target as HTMLSelectElement).value;
      });

    this.root.querySelectorAll<HTMLButtonElement>('.wiz-overflow-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.wizardOverflow = btn.dataset['wizOverflow'] as 'rollingWindow' | 'stopAtLimit' | 'truncateMiddle';
        this.render();
      });
    });

    // Reasoning tag inputs — written to localStorage so PulseView can read them
    const thinkStartEl = document.getElementById('wiz-think-start') as HTMLInputElement | null;
    thinkStartEl?.addEventListener('change', () => {
      this.wizardThinkStart = thinkStartEl.value;
      localStorage.setItem('dp_think_start', this.wizardThinkStart);
    });
    const thinkEndEl = document.getElementById('wiz-think-end') as HTMLInputElement | null;
    thinkEndEl?.addEventListener('change', () => {
      this.wizardThinkEnd = thinkEndEl.value;
      localStorage.setItem('dp_think_end', this.wizardThinkEnd);
    });

    document.getElementById('wiz-estimate-btn')?.addEventListener('click', () => {
      void this.runEstimate();
    });
  }

  private async runEstimate(): Promise<void> {
    if (!this.wizardModel) return;
    this.wizardEstimating = true;
    this.wizardEstimate   = null;
    this.wizardEstErr     = null;
    this.render();

    try {
      const res = await fetch('/api/proxy/models/estimate', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization:  `Bearer ${AuthService.getToken() ?? ''}`,
        },
        body: JSON.stringify({
          model:         this.wizardModel,
          contextLength: this.wizardCtxLen,
        }),
      });
      const json = await res.json() as IEstimateResult & { error?: string };
      if (!res.ok || json.error) {
        this.wizardEstErr = json.error ?? `HTTP ${res.status}`;
      } else {
        this.wizardEstimate = json;
      }
    } catch (err) {
      this.wizardEstErr = String(err);
    }

    this.wizardEstimating = false;
    this.render();
  }
}
