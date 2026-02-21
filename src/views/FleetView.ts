/**
 * FleetView — Module 1: The Fleet (Hardware Discovery & Management)
 *
 * Spec reference: docs/LMStudioDaemon.md section 4
 * PRD reference:  docs/LMS Admin-PRD.txt Module 1
 *
 * Shows:
 *   - Daemon & server status strip (global header bar)
 *   - GPU diagnostic cards (VRAM, temp, utilisation, driver)
 *   - Multi-GPU allocation strategy toggles
 *   - System RAM overview
 */

import { EventBus }  from '@/core/EventBus';
import { Store }     from '@/core/Store';
import type { DaemonController } from '@/controllers/DaemonController';
import type { IGPUInfo, GPUAllocationStrategy, DaemonState, IRunningModel } from '@/types';
import { renderStatusBadge } from '@/views/components/StatusBadge';
import { AuthService }       from '@/services/AuthService';

// ---------------------------------------------------------------------------
// Mock data — replaced by live daemon data once connected
// ---------------------------------------------------------------------------

const MOCK_GPUS: IGPUInfo[] = [
  {
    index:        0,
    name:         'NVIDIA RTX 4090',
    totalVram:    24,
    usedVram:     9.4,
    temperature:  62,
    utilisation:  78,
    driverStatus: 'ok',
  },
  {
    index:        1,
    name:         'NVIDIA RTX 3060 12GB',
    totalVram:    12,
    usedVram:     0,
    temperature:  38,
    utilisation:  0,
    driverStatus: 'ok',
  },
];

const MOCK_RAM = { used: 18.2, total: 64 };

// ---------------------------------------------------------------------------

export class FleetView {
  private gpus: IGPUInfo[]           = MOCK_GPUS;
  private ramUsed                    = MOCK_RAM.used;
  private ramTotal                   = MOCK_RAM.total;
  private daemonState: DaemonState   = 'stopped';
  private allocation: GPUAllocationStrategy = 'priority';
  private liveInterval: ReturnType<typeof setInterval> | null = null;
  private runningModels: IRunningModel[] = [];
  private surveyError    = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly daemon: DaemonController,
  ) {}

  mount(): void {
    this.render();
    this.bindEventBus();
    this.startMockLiveTick(); // Remove once real daemon is connected
    // Probe real daemon state immediately on mount
    void this.daemon.probe();
    void this.fetchRunning();
    void this.fetchSurvey();
  }

  unmount(): void {
    if (this.liveInterval !== null) {
      clearInterval(this.liveInterval);
      this.liveInterval = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  private render(): void {
    this.root.innerHTML = `
      <div class="space-y-6 max-w-6xl">

        <!-- Page title -->
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-lg font-bold text-white tracking-tight">The Fleet</h2>
            <p class="text-xs text-slate-500 mt-0.5">Hardware discovery &amp; compute routing</p>
          </div>
          <div id="fleet-daemon-badge">
            ${renderStatusBadge(this.daemonState === 'running' ? 'Daemon Online' : 'Daemon Offline',
              this.daemonState === 'running' ? 'active' : 'idle')}
          </div>
        </div>

        <!-- Global control strip -->
        ${this.renderControlStrip()}

        <!-- GPU cards grid -->
        <section>
          <h3 class="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-3">GPU Matrix</h3>
          <div id="gpu-grid" class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            ${this.gpus.map(gpu => this.renderGpuCard(gpu)).join('')}
          </div>
        </section>

        <!-- System RAM -->
        <section class="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-[11px] font-bold uppercase tracking-wider text-slate-500">System RAM</h3>
            <span class="text-xs font-mono text-slate-400" id="ram-text">
              ${this.ramUsed.toFixed(1)} / ${this.ramTotal} GB
            </span>
          </div>
          <div class="w-full bg-slate-800 rounded-full h-2">
            <div id="ram-bar"
              class="h-2 rounded-full transition-all duration-700 ${this.ramBarColour()}"
              style="width: ${this.pct(this.ramUsed, this.ramTotal)}%">
            </div>
          </div>
          <p class="text-[10px] text-slate-600 mt-2">
            Strict VRAM limits prevent model layers spilling into system RAM — keeping tok/sec high.
          </p>
        </section>

        <!-- GPU Allocation Strategy -->
        ${this.renderAllocationSection()}

        <!-- Memory State (lms ps) -->
        ${this.renderMemoryState()}

      </div>
    `;

    this.bindDomEvents();
  }

  // ---------------------------------------------------------------------------
  // Hardware survey + running model fetch
  // ---------------------------------------------------------------------------

  private async fetchSurvey(): Promise<void> {
    try {
      const res = await AuthService.apiFetch('/api/proxy/runtime/survey');
      if (!res.ok) { this.surveyError = true; return; }
      // Survey returns GPU list — map onto this.gpus if real data available
      const json = await res.json() as { gpus?: Array<{ index: number; name: string; totalVramGb: number; freeVramGb?: number; architecture?: string }> } | { error?: string };
      if ('error' in json) { this.surveyError = true; return; }
      const gpus = (json as { gpus?: Array<{ index: number; name: string; totalVramGb: number; freeVramGb?: number; architecture?: string }> }).gpus;
      if (gpus && gpus.length > 0) {
        this.gpus = gpus.map(g => {
          const gpu: IGPUInfo = {
            index:        g.index,
            name:         g.name,
            totalVram:    g.totalVramGb,
            usedVram:     g.freeVramGb !== undefined ? g.totalVramGb - g.freeVramGb : 0,
            driverStatus: 'ok',
          };
          return gpu;
        });
        const grid = document.getElementById('gpu-grid');
        if (grid) grid.innerHTML = this.gpus.map(g => this.renderGpuCard(g)).join('');
      }
    } catch { this.surveyError = true; }
  }

  private async fetchRunning(): Promise<void> {
    try {
      const res = await AuthService.apiFetch('/api/proxy/models/running');
      if (!res.ok) return;
      const json = await res.json() as IRunningModel[] | { models?: IRunningModel[] } | { error?: string };
      if (Array.isArray(json)) {
        this.runningModels = json;
      } else if ('models' in json && Array.isArray((json as { models?: IRunningModel[] }).models)) {
        this.runningModels = (json as { models: IRunningModel[] }).models;
      } else {
        this.runningModels = [];
      }
    } catch { /* keep empty */ }
    const memSection = document.getElementById('fleet-memory-state');
    if (memSection) memSection.outerHTML = this.renderMemoryState();
  }

  // ---------------------------------------------------------------------------
  // Sub-render: Memory State (lms ps)
  // ---------------------------------------------------------------------------

  private renderMemoryState(): string {
    return `
      <section id="fleet-memory-state">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-[11px] font-bold uppercase tracking-wider text-slate-500">
            Memory State <span class="font-mono">(lms ps)</span>
          </h3>
          <button id="btn-refresh-ps"
            class="px-2.5 py-1 rounded-lg border border-slate-700 text-[10px] font-semibold
                   text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-all">
            ↻ Refresh
          </button>
        </div>
        ${this.runningModels.length === 0
          ? `<div class="bg-slate-900 border border-slate-800 rounded-xl p-5 text-center">
               <p class="text-slate-600 text-[11px]">
                 ${this.surveyError
                   ? 'lms CLI not found on PATH — run <code class="font-mono">npm i -g lmstudio</code> on the server'
                   : 'No models currently resident in memory'}
               </p>
             </div>`
          : `<div class="space-y-2">
               ${this.runningModels.map(m => `
                 <div class="flex items-center gap-4 bg-slate-900 border border-slate-800 rounded-xl px-4 py-3">
                   <div class="flex-1 min-w-0">
                     <p class="text-xs font-mono text-slate-200 truncate">${m.instance_id}</p>
                     ${m.model_path ? `<p class="text-[10px] text-slate-600 font-mono truncate mt-0.5">${m.model_path}</p>` : ''}
                   </div>
                   <div class="flex items-center gap-4 flex-shrink-0 text-right">
                     ${m.vram_usage !== undefined
                       ? `<div>
                            <p class="text-[10px] text-slate-600 uppercase tracking-wider">VRAM</p>
                            <p class="text-xs font-mono font-bold text-indigo-400">${m.vram_usage.toFixed(1)} GB</p>
                          </div>`
                       : ''}
                     ${m.ram_usage !== undefined
                       ? `<div>
                            <p class="text-[10px] text-slate-600 uppercase tracking-wider">RAM</p>
                            <p class="text-xs font-mono font-bold text-slate-300">${m.ram_usage.toFixed(1)} GB</p>
                          </div>`
                       : ''}
                     ${renderStatusBadge(
                       m.state === 'loaded' ? 'Loaded' : m.state,
                       m.state === 'loaded' ? 'active' : 'warning'
                     )}
                   </div>
                 </div>
               `).join('')}
             </div>`
        }
      </section>
    `;
  }

  // ---------------------------------------------------------------------------
  // Sub-renders
  // ---------------------------------------------------------------------------

  private renderControlStrip(): string {
    const running = this.daemonState === 'running';

    return `
      <div class="space-y-3">

        <!-- Action bar -->
        <div class="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap gap-3 items-center">

          <button id="btn-refresh-hw"
            class="flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-700
                   text-xs font-semibold text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-all">
            <span class="font-mono text-base leading-none">↻</span>
            Refresh Hardware
          </button>

          <!-- Kill switch — right-aligned -->
          <div class="ml-auto">
            <button id="btn-kill-switch"
              class="flex items-center gap-2 px-4 py-2 rounded-lg border border-red-500/30
                     bg-red-500/10 text-red-400 text-xs font-bold hover:bg-red-500/20
                     transition-all uppercase tracking-wider">
              ⚡ Kill Switch
            </button>
          </div>
        </div>

        <!-- Service lifecycle info (LM Studio 0.4+ has no REST lifecycle endpoints) -->
        <div class="bg-slate-900 border border-slate-800 rounded-xl p-4 grid grid-cols-1 md:grid-cols-2 gap-4">

          <!-- Headless service -->
          <div>
            <p class="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">Headless Service</p>
            <p class="text-[11px] text-slate-500 mb-2">
              LM Studio 0.4+ manages server lifecycle through its app UI and the
              <span class="font-mono text-slate-400">lms</span> CLI — not via REST API.
            </p>
            <div class="flex flex-col gap-1">
              <div class="flex items-center gap-2 bg-slate-950 rounded-lg px-3 py-1.5">
                <span class="text-[10px] text-slate-600 font-mono">start</span>
                <code class="text-[11px] font-mono text-emerald-400 flex-1">lms server start</code>
              </div>
              <div class="flex items-center gap-2 bg-slate-950 rounded-lg px-3 py-1.5">
                <span class="text-[10px] text-slate-600 font-mono">stop&nbsp;</span>
                <code class="text-[11px] font-mono text-orange-400 flex-1">lms server stop</code>
              </div>
            </div>
          </div>

          <!-- JIT loading info -->
          <div>
            <p class="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">JIT Loading Mode</p>
            <p class="text-[11px] text-slate-500 mb-2">
              When JIT is ON, LM Studio loads any downloaded model into VRAM the first time it receives
              an inference request, then auto-unloads it after inactivity.
            </p>
            <div class="flex items-center gap-2 bg-slate-950 rounded-lg px-3 py-1.5">
              <span class="text-[10px] text-slate-600 font-mono">CLI&nbsp;</span>
              <code class="text-[11px] font-mono text-indigo-400 flex-1">lms server --jit on</code>
            </div>
            <p class="text-[10px] text-slate-600 mt-2">
              The Forge (Module 2) shows which models are resident vs. JIT-loadable in real time.
            </p>
          </div>

        </div>
      </div>
    `;
  }

  private renderGpuCard(gpu: IGPUInfo): string {
    const vramPct  = this.pct(gpu.usedVram, gpu.totalVram);
    const vramBar  = vramPct > 85 ? 'bg-red-500'
                   : vramPct > 65 ? 'bg-orange-400'
                   : 'bg-indigo-500';
    const tempColour = (gpu.temperature ?? 0) > 80 ? 'text-red-400'
                     : (gpu.temperature ?? 0) > 65 ? 'text-orange-400'
                     : 'text-emerald-400';
    const utilisationBar = gpu.utilisation && gpu.utilisation > 0
      ? 'bg-emerald-500' : 'bg-slate-700';
    const isActive = (gpu.usedVram ?? 0) > 0;

    return `
      <div class="bg-slate-900 border ${isActive ? 'border-indigo-500/40' : 'border-slate-800'}
                  rounded-xl p-5 transition-all duration-300">

        <!-- Header row -->
        <div class="flex items-start justify-between mb-4">
          <div>
            <p class="text-[10px] text-slate-500 font-mono">GPU ${gpu.index}</p>
            <h4 class="text-sm font-bold text-slate-100 mt-0.5">${gpu.name}</h4>
          </div>
          <div class="text-right">
            ${renderStatusBadge(
              gpu.driverStatus === 'ok' ? 'CUDA OK' : 'Driver Error',
              gpu.driverStatus === 'ok' ? 'active' : 'error'
            )}
          </div>
        </div>

        <!-- VRAM bar -->
        <div class="mb-3">
          <div class="flex justify-between text-[10px] text-slate-500 mb-1.5">
            <span class="uppercase tracking-wider">VRAM</span>
            <span class="font-mono">${gpu.usedVram.toFixed(1)} / ${gpu.totalVram} GB</span>
          </div>
          <div class="w-full bg-slate-800 rounded-full h-2">
            <div class="${vramBar} h-2 rounded-full transition-all duration-700"
                 style="width: ${vramPct}%"></div>
          </div>
        </div>

        <!-- Utilisation bar -->
        <div class="mb-4">
          <div class="flex justify-between text-[10px] text-slate-500 mb-1.5">
            <span class="uppercase tracking-wider">Core Utilisation</span>
            <span class="font-mono">${Math.round(gpu.utilisation ?? 0)}%</span>
          </div>
          <div class="w-full bg-slate-800 rounded-full h-1.5">
            <div class="${utilisationBar} h-1.5 rounded-full transition-all duration-700"
                 style="width: ${Math.round(gpu.utilisation ?? 0)}%"></div>
          </div>
        </div>

        <!-- Stats row -->
        <div class="flex gap-4 text-xs">
          <div>
            <p class="text-slate-600 text-[10px] uppercase tracking-wider">Temp</p>
            <p class="font-mono font-bold ${tempColour} mt-0.5">${gpu.temperature !== undefined ? gpu.temperature.toFixed(1) : '—'}°C</p>
          </div>
          <div>
            <p class="text-slate-600 text-[10px] uppercase tracking-wider">VRAM Free</p>
            <p class="font-mono font-bold text-slate-300 mt-0.5">
              ${(gpu.totalVram - gpu.usedVram).toFixed(1)} GB
            </p>
          </div>
          <div>
            <p class="text-slate-600 text-[10px] uppercase tracking-wider">Status</p>
            <p class="font-mono font-bold mt-0.5 ${isActive ? 'text-emerald-400' : 'text-slate-500'}">
              ${isActive ? 'Active' : 'Idle'}
            </p>
          </div>
        </div>
      </div>
    `;
  }

  private renderAllocationSection(): string {
    const options: { key: GPUAllocationStrategy; label: string; desc: string }[] = [
      {
        key:   'priority',
        label: 'Priority Order',
        desc:  'Fills GPU 0 to capacity before spilling to secondary cards. Best for single large models.',
      },
      {
        key:   'even',
        label: 'Even Distribution',
        desc:  'Slices weights equally across all GPUs. Balances thermal load — ideal for 24/7 servers.',
      },
      {
        key:   'dedicated',
        label: 'Strict VRAM',
        desc:  'Prevents layers spilling to system RAM. Avoids the tok/sec degradation of unified memory swapping.',
      },
    ];

    return `
      <section>
        <h3 class="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-3">
          GPU Allocation Strategy
        </h3>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          ${options.map(opt => `
            <button data-alloc="${opt.key}"
              class="alloc-btn text-left p-4 rounded-xl border transition-all
                     ${this.allocation === opt.key
                       ? 'border-indigo-500/60 bg-indigo-600/10 text-indigo-300'
                       : 'border-slate-800 bg-slate-900 text-slate-400 hover:border-slate-600 hover:text-slate-200'}">
              <div class="flex items-center gap-2 mb-2">
                <span class="w-2 h-2 rounded-full flex-shrink-0
                  ${this.allocation === opt.key ? 'bg-indigo-400' : 'bg-slate-600'}"></span>
                <span class="text-xs font-bold uppercase tracking-wider">${opt.label}</span>
              </div>
              <p class="text-[11px] leading-relaxed opacity-70">${opt.desc}</p>
            </button>
          `).join('')}
        </div>
      </section>
    `;
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------

  private bindDomEvents(): void {
    // Daemon and server lifecycle is not controllable via REST in LM Studio 0.4+.
    // Users must use the LM Studio app UI or `lms server start/stop` CLI.
    // The btn-daemon-toggle and btn-server-toggle no longer exist in the control strip.

    document.getElementById('btn-refresh-hw')?.addEventListener('click', () => {
      void this.daemon.refreshHardware();
      void this.fetchSurvey();
    });

    document.getElementById('btn-refresh-ps')?.addEventListener('click', () => {
      void this.fetchRunning();
    });

    document.getElementById('btn-kill-switch')?.addEventListener('click', async () => {
      if (!confirm('Kill switch: eject all models from VRAM via LM Studio. Continue?')) return;
      // lms unload --all is faster and atomic compared to iterating REST calls individually.
      try {
        await AuthService.apiFetch('/api/proxy/models/unload-all', { method: 'POST' });
      } catch { /* ignore — best-effort kill switch */ }
    });

    document.querySelectorAll<HTMLButtonElement>('.alloc-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.allocation = btn.dataset['alloc'] as GPUAllocationStrategy;
        this.render();
      });
    });
  }

  private bindEventBus(): void {
    EventBus.on('DAEMON_STATE_CHANGED', ({ payload }) => {
      if (payload.nodeId === (Store.getState().activeNodeId ?? 'local')) {
        this.daemonState = payload.state;
        this.render();
      }
    });

    EventBus.on('VRAM_UPDATED', ({ payload }) => {
      if (payload.nodeId === (Store.getState().activeNodeId ?? 'local')) {
        this.gpus = payload.gpus;
        const grid = document.getElementById('gpu-grid');
        if (grid) grid.innerHTML = this.gpus.map(g => this.renderGpuCard(g)).join('');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Mock live tick — simulates GPU activity until real daemon is wired
  // ---------------------------------------------------------------------------

  private startMockLiveTick(): void {
    this.liveInterval = setInterval(() => {
      this.gpus = this.gpus.map(gpu => ({
        ...gpu,
        usedVram:    gpu.index === 0
          ? Math.min(gpu.totalVram, Math.max(0, gpu.usedVram + (Math.random() - 0.4) * 0.3))
          : gpu.usedVram,
        utilisation: gpu.index === 0
          ? Math.min(100, Math.max(0, (gpu.utilisation ?? 0) + (Math.random() - 0.4) * 8))
          : 0,
        temperature: Math.min(85, Math.max(35, (gpu.temperature ?? 50) + (Math.random() - 0.5) * 2)),
      }));

      const grid = document.getElementById('gpu-grid');
      if (grid) grid.innerHTML = this.gpus.map(g => this.renderGpuCard(g)).join('');

      // Update RAM bar
      this.ramUsed = Math.min(this.ramTotal, Math.max(8, this.ramUsed + (Math.random() - 0.5) * 0.5));
      const ramBar  = document.getElementById('ram-bar');
      const ramText = document.getElementById('ram-text');
      if (ramBar)  { ramBar.style.width = `${this.pct(this.ramUsed, this.ramTotal)}%`; }
      if (ramText) { ramText.textContent = `${this.ramUsed.toFixed(1)} / ${this.ramTotal} GB`; }
    }, 2000);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private pct(used: number, total: number): number {
    return total > 0 ? Math.round((used / total) * 100) : 0;
  }

  private ramBarColour(): string {
    const p = this.pct(this.ramUsed, this.ramTotal);
    return p > 85 ? 'bg-red-500' : p > 65 ? 'bg-orange-400' : 'bg-indigo-500';
  }
}
