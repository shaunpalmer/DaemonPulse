/**
 * RemoteView — Remote Node Orchestration
 *
 * Tabs:
 *   Connect   — SSH credential form + probe
 *   Status    — Daemon lifecycle (start / stop / restart via systemctl or lms-cli)
 *   Install   — Streaming lmstudio one-liner install terminal
 *   Hardware  — lms runtime survey (GPU, VRAM, architecture)
 *
 * All SSH operations are proxied through the bridge server (/api/remote/*)
 * so private keys and passwords are never transmitted over the network
 * beyond the browser→bridge hop (which is localhost in dev).
 */

import { AuthService } from '@/services/AuthService';

type AuthMethod  = 'key' | 'password';
type RemoteTab   = 'connect' | 'status' | 'install' | 'hardware';
type DaemonState = 'running' | 'starting' | 'stopped' | 'unknown';
type InstallMethod = 'official' | 'npm';

interface ProbeResult {
  host:          string;
  lmsInstalled:  boolean;
  lmsVersion:    string | null;
  serviceActive: boolean;
  serverUp:      boolean;
  daemonState:   DaemonState;
  os:            string;
}

interface SurveyResult {
  survey?: unknown;
  raw?:    string;
  stderr?: string;
}

interface TermLine {
  type: 'stdout' | 'stderr' | 'info' | 'warn' | 'error' | 'exit';
  text: string;
}

interface InstallStep {
  label:  string;
  status: 'pending' | 'active' | 'done' | 'error';
  note?:  string;
}

interface InstallStreamEvent {
  type:       'stdout' | 'stderr' | 'info' | 'warn' | 'error' | 'exit' | 'step';
  line?:      string;
  step?:      number;
  totalSteps?: number;
  label?:     string;
  status?:    'active' | 'done' | 'error';
}

export class RemoteView {
  private activeTab:    RemoteTab   = 'connect';
  private authMethod:   AuthMethod  = 'key';

  // Form values
  private host      = '';
  private port      = 22;
  private username  = 'ubuntu';
  private credential = '';   // privateKey content/path OR password

  // Operation state
  private probing   = false;
  private probe:    ProbeResult | null = null;
  private probeErr: string | null      = null;

  private actionBusy = false;
  private actionMsg: string | null = null;

  private streamAbort: AbortController | null = null;
  private streaming   = false;
  private termLines:  TermLine[] = [];
  private installMethod: InstallMethod = (localStorage.getItem('dp_install_method') === 'npm' ? 'npm' : 'official');
  private installSteps: InstallStep[] = this.defaultInstallSteps();

  private survey:    SurveyResult | null = null;
  private surveying  = false;

  private scrapedKey: string | null = null;
  private scraping    = false;
  private keyApplied  = false;

  private error: string | null = null;

  constructor(private readonly root: HTMLElement) {}

  mount(): void {
    this.render();
    this.bindEvents();
  }

  unmount(): void {
    this.streamAbort?.abort();
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  private defaultInstallSteps(): InstallStep[] {
    return [
      { label: 'SSH connection',          status: 'pending' },
      { label: 'Remote platform detection', status: 'pending' },
      { label: 'Installer preflight',     status: 'pending' },
      { label: 'Run installer',           status: 'pending' },
      { label: 'Verify lms CLI',          status: 'pending' },
      { label: 'Daemon bootstrap',        status: 'pending' },
    ];
  }

  private resetInstallSteps(): void {
    this.installSteps = this.defaultInstallSteps();
  }

  private installProgressPercent(): number {
    const total = this.installSteps.length || 1;
    const done = this.installSteps.filter(s => s.status === 'done').length;
    const active = this.installSteps.some(s => s.status === 'active') ? 1 : 0;
    return Math.min(100, Math.round(((done + active * 0.45) / total) * 100));
  }

  private applyInstallStepEvent(evt: InstallStreamEvent): void {
    if (!evt.step || !evt.status) return;
    const idx = evt.step - 1;
    if (idx < 0 || idx >= this.installSteps.length) return;
    const step = this.installSteps[idx];
    if (!step) return;
    step.status = evt.status;
    if (evt.label) step.label = evt.label;
    if (evt.line) step.note = evt.line;
    if (evt.status === 'active') {
      for (let i = 0; i < idx; i++) {
        const prev = this.installSteps[i];
        if (prev && prev.status === 'pending') prev.status = 'done';
      }
    }
  }

  private repaintInstallWizard(): void {
    const pct = this.installProgressPercent();
    const pctEl = document.getElementById('remote-install-progress-pct');
    if (pctEl) pctEl.textContent = `${pct}%`;
    const barEl = document.getElementById('remote-install-progress-bar') as HTMLDivElement | null;
    if (barEl) barEl.style.width = `${pct}%`;

    const stepsEl = document.getElementById('remote-install-steps');
    if (!stepsEl) return;
    stepsEl.innerHTML = this.installSteps.map(s => {
      const badge = s.status === 'done'
        ? '✓'
        : s.status === 'active'
          ? '…'
          : s.status === 'error'
            ? '✕'
            : '•';
      const cls = s.status === 'done'
        ? 'text-emerald-400 border-emerald-500/20 bg-emerald-500/5'
        : s.status === 'active'
          ? 'text-indigo-300 border-indigo-500/30 bg-indigo-500/10'
          : s.status === 'error'
            ? 'text-red-300 border-red-500/30 bg-red-500/10'
            : 'text-slate-500 border-slate-700 bg-slate-800/50';
      return `
        <div class="border rounded-lg px-2.5 py-2 ${cls}">
          <p class="text-[11px] font-semibold"><span class="font-mono mr-1.5">${badge}</span>${this.esc(s.label)}</p>
          ${s.note ? `<p class="text-[10px] mt-1 opacity-80">${this.esc(s.note)}</p>` : ''}
        </div>`;
    }).join('');
  }

  private connBody() {
    return {
      host:        this.host,
      port:        this.port,
      username:    this.username,
      ...(this.authMethod === 'key'
        ? { privateKey: this.credential }
        : { password:   this.credential }),
    };
  }

  private async runProbe(): Promise<void> {
    this.probing  = true;
    this.probe    = null;
    this.probeErr = null;
    this.render(); this.bindEvents();

    try {
      const res = await AuthService.apiFetch('/api/remote/probe', {
        method: 'POST',
        body:   JSON.stringify(this.connBody()),
      });
      const json = await res.json() as ProbeResult & { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      this.probe    = json;
      this.activeTab = 'status';   // auto-switch to Status once connected
    } catch (e) {
      this.probeErr = String(e);
    }

    this.probing = false;
    this.render(); this.bindEvents();
  }

  private async runDaemonAction(action: 'start' | 'stop' | 'restart'): Promise<void> {
    this.actionBusy = true;
    this.actionMsg  = null;
    this.render(); this.bindEvents();

    try {
      const res = await AuthService.apiFetch(`/api/remote/daemon/${action}`, {
        method: 'POST',
        body:   JSON.stringify(this.connBody()),
      });
      const json = await res.json() as { exitCode: number; stdout: string; stderr: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      this.actionMsg = json.exitCode === 0
        ? `✓ ${action} succeeded`
        : `⚠ Exit ${json.exitCode}: ${json.stderr || json.stdout}`;
      // Re-probe to refresh state badge
      void this.runProbe();
    } catch (e) {
      this.actionMsg = `Error: ${String(e)}`;
    }

    this.actionBusy = false;
    this.render(); this.bindEvents();
  }

  private async startInstall(): Promise<void> {
    this.termLines  = [];
    this.resetInstallSteps();
    this.streaming  = true;
    this.streamAbort = new AbortController();
    this.render(); this.bindEvents();

    try {
      const res = await AuthService.apiFetch('/api/remote/install/stream', {
        method: 'POST',
        body:   JSON.stringify({ ...this.connBody(), installMethod: this.installMethod }),
        signal: this.streamAbort.signal,
      });

      if (!res.body) throw new Error('No response body');

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
          const t = raw.trim();
          if (!t.startsWith('data:')) continue;
          try {
            const evt = JSON.parse(t.slice(5).trim()) as InstallStreamEvent;
            if (evt.type === 'step') {
              this.applyInstallStepEvent(evt);
              if (evt.line) {
                this.termLines.push({
                  type: evt.status === 'error' ? 'error' : 'info',
                  text: evt.line,
                });
              }
              this.repaintInstallWizard();
              this.repaintTerminal();
              continue;
            }
            if (evt.type === 'exit') {
              this.termLines.push({ type: 'info', text: `— process exited (code ${evt.line ?? '?'}) —` });
            } else {
              this.termLines.push({ type: evt.type as TermLine['type'], text: evt.line ?? '' });
            }
            this.repaintTerminal();
          } catch { /* skip */ }
        }
      }
    } catch (e: unknown) {
      if ((e as { name?: string }).name !== 'AbortError') {
        this.termLines.push({ type: 'error', text: String(e) });
        this.repaintTerminal();
      }
    }

    this.streaming   = false;
    this.streamAbort = null;
    // Refresh status after install attempt to reflect CLI presence + daemon state.
    if (this.host && this.username) {
      void this.runProbe();
    }
    this.render(); this.bindEvents();
  }

  private async runSurvey(): Promise<void> {
    this.surveying = true;
    this.survey    = null;
    this.render(); this.bindEvents();

    try {
      const res = await AuthService.apiFetch('/api/remote/survey', {
        method: 'POST',
        body:   JSON.stringify(this.connBody()),
      });
      const json = await res.json() as SurveyResult & { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      this.survey = json;
      this.activeTab = 'hardware';
    } catch (e) {
      this.error = String(e);
    }

    this.surveying = false;
    this.render(); this.bindEvents();
  }

  private async scrapeKey(): Promise<void> {
    this.scraping   = true;
    this.scrapedKey = null;
    this.keyApplied = false;
    this.render(); this.bindEvents();

    try {
      const res = await AuthService.apiFetch('/api/remote/key-scrape', {
        method: 'POST',
        body:   JSON.stringify(this.connBody()),
      });
      const json = await res.json() as { key: string | null; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      this.scrapedKey = json.key;
    } catch (e) {
      this.error = String(e);
    }

    this.scraping = false;
    this.render(); this.bindEvents();
  }

  private async applyKey(): Promise<void> {
    if (!this.scrapedKey) return;
    localStorage.setItem('dp_daemon_key', this.scrapedKey);
    try {
      await AuthService.apiFetch('/api/proxy/config/daemon-key', {
        method: 'POST',
        body:   JSON.stringify({ key: this.scrapedKey }),
      });
    } catch { /* proxy may not be running against the remote yet */ }
    this.keyApplied = true;
    this.render(); this.bindEvents();
  }

  // ---------------------------------------------------------------------------
  // DOM helpers (no full re-render for streaming)
  // ---------------------------------------------------------------------------

  private repaintTerminal(): void {
    const el = document.getElementById('remote-terminal');
    if (!el) return;
    const last = this.termLines.slice(-200);
    el.innerHTML = last.map(l => {
      const cls = l.type === 'stderr' || l.type === 'error'
        ? 'text-red-400'
        : l.type === 'warn'
          ? 'text-amber-400'
        : l.type === 'info'
          ? 'text-slate-500'
          : 'text-emerald-300';
      return `<div class="${cls}">${this.esc(l.text)}</div>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private render(): void {
    this.root.innerHTML = `
      <div class="space-y-6 max-w-4xl">

        <div>
          <h2 class="text-lg font-bold text-white tracking-tight">Remote Nodes</h2>
          <p class="text-xs text-slate-500 mt-0.5">SSH-based LM Studio daemon orchestration · install · lifecycle · hardware survey</p>
        </div>

        <!-- Tab row -->
        <div class="flex gap-1 border-b border-slate-800 pb-0">
          ${this.tabBtn('connect',  '⌁ Connect')}
          ${this.tabBtn('status',   '◎ Status')}
          ${this.tabBtn('install',  '↓ Install')}
          ${this.tabBtn('hardware', '⬡ Hardware')}
        </div>

        <!-- Tab content -->
        ${this.activeTab === 'connect'  ? this.renderConnect()  : ''}
        ${this.activeTab === 'status'   ? this.renderStatus()   : ''}
        ${this.activeTab === 'install'  ? this.renderInstall()  : ''}
        ${this.activeTab === 'hardware' ? this.renderHardware() : ''}

      </div>
    `;
  }

  private tabBtn(tab: RemoteTab, label: string): string {
    const active = this.activeTab === tab;
    return `
      <button data-tab="${tab}"
        class="remote-tab px-4 py-2 text-xs font-semibold transition-all border-b-2 -mb-px
               ${active
                 ? 'border-indigo-500 text-indigo-400'
                 : 'border-transparent text-slate-500 hover:text-slate-300'}">
        ${label}
      </button>`;
  }

  // ---- Connect tab -----------------------------------------------------------

  private renderConnect(): string {
    const credLabel = this.authMethod === 'key' ? 'Private Key (PEM content or file path)' : 'Password';
    const credPlaceholder = this.authMethod === 'key'
      ? '-----BEGIN OPENSSH PRIVATE KEY-----  …  or  /home/user/.ssh/id_rsa'
      : 'your-ssh-password';
    const credType = this.authMethod === 'password' ? 'password' : 'text';

    return `
      <section class="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <h3 class="text-sm font-bold text-slate-200">SSH Connection</h3>

        <div class="grid grid-cols-3 gap-3">
          <div class="col-span-2">
            <label class="block text-[11px] text-slate-500 font-semibold uppercase tracking-wider mb-1">Host / IP</label>
            <input id="r-host" type="text" value="${this.esc(this.host)}" placeholder="203.0.113.10 or myserver.example.com"
              class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 text-xs font-mono
                     focus:outline-none focus:border-indigo-500 placeholder:text-slate-600" />
          </div>
          <div>
            <label class="block text-[11px] text-slate-500 font-semibold uppercase tracking-wider mb-1">Port</label>
            <input id="r-port" type="number" value="${this.port}" min="1" max="65535"
              class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 text-xs font-mono
                     focus:outline-none focus:border-indigo-500 text-center" />
          </div>
        </div>

        <div>
          <label class="block text-[11px] text-slate-500 font-semibold uppercase tracking-wider mb-1">Username</label>
          <input id="r-user" type="text" value="${this.esc(this.username)}" placeholder="ubuntu"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 text-xs font-mono
                   focus:outline-none focus:border-indigo-500 placeholder:text-slate-600" />
        </div>

        <!-- Auth method toggle -->
        <div>
          <label class="block text-[11px] text-slate-500 font-semibold uppercase tracking-wider mb-2">Auth Method</label>
          <div class="flex rounded-lg overflow-hidden border border-slate-700 text-[11px] font-semibold w-fit">
            <button id="r-auth-key"
              class="px-4 py-1.5 transition-all ${this.authMethod === 'key'
                ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}">
              🔑 SSH Key
            </button>
            <button id="r-auth-pw"
              class="px-4 py-1.5 transition-all ${this.authMethod === 'password'
                ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}">
              🔒 Password
            </button>
          </div>
        </div>

        <div>
          <label class="block text-[11px] text-slate-500 font-semibold uppercase tracking-wider mb-1">${credLabel}</label>
          <textarea id="r-cred" rows="${this.authMethod === 'key' ? 4 : 1}"
            placeholder="${credPlaceholder}"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 text-xs font-mono
                   resize-none focus:outline-none focus:border-indigo-500 placeholder:text-slate-600
                   ${credType === 'password' ? 'tracking-widest' : ''}">${this.esc(this.credential)}</textarea>
          ${this.authMethod === 'key' ? `
            <p class="text-[10px] text-slate-600 mt-0.5">
              Paste the raw PEM block or enter the absolute path to the key file on this machine.
              The key is sent to the bridge server only and never leaves your host.
            </p>` : ''}
        </div>

        ${this.probeErr ? `
          <div class="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">
            <p class="text-xs font-mono text-red-300">${this.esc(this.probeErr)}</p>
          </div>` : ''}

        <div class="flex justify-end gap-3">
          <button id="r-probe"
            class="px-5 py-2 rounded-lg text-xs font-semibold transition-all
                   ${this.probing
                     ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                     : 'bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer'}"
            ${this.probing ? 'disabled' : ''}>
            ${this.probing ? '⏳ Connecting…' : '⌁ Probe Connection'}
          </button>
        </div>
      </section>`;
  }

  // ---- Status tab ------------------------------------------------------------

  private renderStatus(): string {
    if (!this.probe) {
      return `
        <section class="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center">
          <p class="text-slate-500 text-sm">Run <span class="text-indigo-400 font-semibold">Probe Connection</span> first to load remote status.</p>
        </section>`;
    }

    const p = this.probe;
    const stateDot = p.daemonState === 'running'  ? 'bg-emerald-400' :
                     p.daemonState === 'starting' ? 'bg-amber-400 animate-pulse' :
                                                    'bg-red-500';
    return `
      <section class="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-5">

        <!-- Summary badges -->
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          ${this.statusCard('Daemon', p.daemonState, p.daemonState === 'running' ? 'emerald' : p.daemonState === 'starting' ? 'amber' : 'red')}
          ${this.statusCard('LMS CLI', p.lmsInstalled ? (p.lmsVersion ?? 'installed') : 'not found', p.lmsInstalled ? 'emerald' : 'red')}
          ${this.statusCard('systemd', p.serviceActive ? 'active' : 'inactive', p.serviceActive ? 'emerald' : 'slate')}
          ${this.statusCard('HTTP :1234', p.serverUp ? 'up' : 'down', p.serverUp ? 'emerald' : 'red')}
        </div>

        <div class="flex items-center gap-2 text-[11px] text-slate-400 font-mono border-t border-slate-800 pt-4">
          <span class="w-2 h-2 rounded-full flex-shrink-0 ${stateDot}"></span>
          <span>${this.esc(p.host)}</span>
          <span class="text-slate-600">·</span>
          <span class="text-slate-500">${this.esc(p.os)}</span>
        </div>

        <!-- Lifecycle controls -->
        <div>
          <p class="text-[11px] text-slate-500 font-semibold uppercase tracking-wider mb-3">Daemon Lifecycle</p>
          <div class="flex gap-2 flex-wrap">
            ${this.actionBtn('r-start',   '▶ Start',   'emerald', this.actionBusy)}
            ${this.actionBtn('r-stop',    '■ Stop',    'red',     this.actionBusy)}
            ${this.actionBtn('r-restart', '↻ Restart', 'amber',   this.actionBusy)}
            ${this.actionBtn('r-survey',  '⬡ Survey',  'indigo',  this.surveying)}
            ${this.actionBtn('r-scrape',  '⚿ Scrape Key', 'slate', this.scraping)}
          </div>
          ${this.actionMsg ? `
            <p class="mt-3 text-xs font-mono text-slate-400 border border-slate-700 rounded-lg px-3 py-2 bg-slate-800/60">
              ${this.esc(this.actionMsg)}
            </p>` : ''}
        </div>

        <!-- Scraped key result -->
        ${this.scrapedKey !== null ? `
          <div class="border border-emerald-500/20 bg-emerald-500/5 rounded-lg p-4 space-y-3">
            <p class="text-[11px] font-bold uppercase tracking-wider text-emerald-400">Permission Key Found</p>
            <p class="font-mono text-xs text-slate-300 break-all">${this.esc(this.scrapedKey)}</p>
            ${this.keyApplied
              ? `<p class="text-xs text-emerald-400">✓ Applied to Live Mode — dashboard will use this key for API calls</p>`
              : `<button id="r-apply-key"
                  class="mt-1 px-4 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600/20 hover:bg-emerald-600/30
                         text-emerald-400 border border-emerald-500/30 cursor-pointer transition-all">
                  ⚿ Apply to Dashboard
                </button>`
            }
          </div>` : ''}
        ${this.scrapedKey === null && !this.scraping && this.probe ? `
          <!-- shown only after a scrape attempt returned null -->` : ''}

      </section>`;
  }

  private statusCard(label: string, value: string, color: 'emerald' | 'red' | 'amber' | 'slate'): string {
    const colors: Record<string, string> = {
      emerald: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
      red:     'text-red-400     bg-red-500/10     border-red-500/20',
      amber:   'text-amber-400   bg-amber-500/10   border-amber-500/20',
      slate:   'text-slate-400   bg-slate-800       border-slate-700',
    };
    return `
      <div class="border rounded-lg p-3 ${colors[color] ?? colors['slate']}">
        <p class="text-[10px] font-semibold uppercase tracking-wider opacity-60 mb-1">${this.esc(label)}</p>
        <p class="text-xs font-bold font-mono">${this.esc(value)}</p>
      </div>`;
  }

  private actionBtn(id: string, label: string, color: string, disabled: boolean): string {
    const colors: Record<string, string> = {
      emerald: 'bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 border-emerald-500/30',
      red:     'bg-red-600/20     hover:bg-red-600/30     text-red-400     border-red-500/30',
      amber:   'bg-amber-600/20   hover:bg-amber-600/30   text-amber-400   border-amber-500/30',
      indigo:  'bg-indigo-600/20  hover:bg-indigo-600/30  text-indigo-400  border-indigo-500/30',
      slate:   'bg-slate-700/40   hover:bg-slate-700/60   text-slate-400   border-slate-600/30',
    };
    const cls = disabled
      ? 'bg-slate-800 text-slate-600 border-slate-700 cursor-not-allowed opacity-50'
      : `${colors[color] ?? colors['slate']} border cursor-pointer`;
    return `
      <button id="${id}" class="px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${cls}"
              ${disabled ? 'disabled' : ''}>
        ${label}
      </button>`;
  }

  // ---- Install tab -----------------------------------------------------------

  private renderInstall(): string {
    const pct = this.installProgressPercent();
    return `
      <section class="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div class="flex items-center justify-between gap-4">
          <div class="min-w-0">
            <h3 class="text-sm font-bold text-slate-200">Install Wizard</h3>
            <p class="text-[11px] text-slate-500 mt-0.5">
              Guided remote install via SSH with step-by-step status and live output.
            </p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <div class="flex rounded-lg overflow-hidden border border-slate-700 text-[11px] font-semibold">
              <button id="r-install-method-official"
                class="px-3 py-1.5 transition-all ${this.installMethod === 'official'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}"
                ${this.streaming ? 'disabled' : ''}>
                Official Script
              </button>
              <button id="r-install-method-npm"
                class="px-3 py-1.5 transition-all ${this.installMethod === 'npm'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}"
                ${this.streaming ? 'disabled' : ''}>
                npm Package
              </button>
            </div>
            ${!this.streaming
              ? `<button id="r-install"
                  class="px-5 py-2 rounded-lg text-xs font-semibold transition-all
                         ${!this.host
                           ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                           : 'bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer'}"
                         ${!this.host ? 'disabled' : ''}>
                  ↓ Start Install
                </button>`
              : `<button id="r-install-stop"
                  class="px-5 py-2 rounded-lg text-xs font-semibold bg-red-600/20 hover:bg-red-600/30
                         text-red-400 border border-red-500/30 cursor-pointer transition-all">
                  ✕ Abort
                </button>`}
          </div>
        </div>

        <div class="bg-slate-800/60 border border-slate-700 rounded-lg px-3 py-3 space-y-2.5">
          <div class="flex items-center justify-between text-[11px]">
            <span class="uppercase tracking-wider font-semibold text-slate-500">Installation Progress</span>
            <span id="remote-install-progress-pct" class="font-mono text-slate-300">${pct}%</span>
          </div>
          <div class="w-full h-2 bg-slate-800 rounded-full overflow-hidden border border-slate-700">
            <div id="remote-install-progress-bar" class="h-full bg-indigo-500 transition-all duration-300" style="width:${pct}%"></div>
          </div>
          <div id="remote-install-steps" class="grid grid-cols-1 md:grid-cols-2 gap-2">
            ${this.installSteps.map(s => {
              const badge = s.status === 'done'
                ? '✓'
                : s.status === 'active'
                  ? '…'
                  : s.status === 'error'
                    ? '✕'
                    : '•';
              const cls = s.status === 'done'
                ? 'text-emerald-400 border-emerald-500/20 bg-emerald-500/5'
                : s.status === 'active'
                  ? 'text-indigo-300 border-indigo-500/30 bg-indigo-500/10'
                  : s.status === 'error'
                    ? 'text-red-300 border-red-500/30 bg-red-500/10'
                    : 'text-slate-500 border-slate-700 bg-slate-800/50';
              return `
                <div class="border rounded-lg px-2.5 py-2 ${cls}">
                  <p class="text-[11px] font-semibold"><span class="font-mono mr-1.5">${badge}</span>${this.esc(s.label)}</p>
                  ${s.note ? `<p class="text-[10px] mt-1 opacity-80">${this.esc(s.note)}</p>` : ''}
                </div>`;
            }).join('')}
          </div>
        </div>

        <div class="flex items-start gap-3 bg-amber-500/5 border border-amber-500/20 rounded-lg px-4 py-3">
          <span class="text-amber-400 text-sm flex-shrink-0">⚠</span>
          <p class="text-[11px] text-amber-400/70 leading-relaxed">
            This command modifies the remote system. Ensure you have a working SSH key and admin/sudo
            rights before proceeding. Method: <span class="font-mono text-amber-300/60">${this.installMethod}</span>
            (${this.installMethod === 'official' ? 'install.sh/install.ps1' : 'npm install -g lmstudio'}).
          </p>
        </div>

        <!-- Terminal output -->
        <div class="bg-[#080a0e] border border-slate-800 rounded-lg">
          <div class="flex items-center justify-between px-3 py-1.5 border-b border-slate-800">
            <span class="text-[10px] font-semibold uppercase tracking-wider text-slate-600">Terminal Output</span>
            ${this.streaming
              ? '<span class="text-[10px] text-emerald-400 animate-pulse font-mono">● receiving</span>'
              : this.termLines.length > 0
                ? '<span class="text-[10px] text-slate-600 font-mono">● done</span>'
                : '<span class="text-[10px] text-slate-700 font-mono">● idle</span>'}
          </div>
          <div id="remote-terminal"
            class="h-72 overflow-y-auto p-3 font-mono text-[11px] leading-5 space-y-0.5">
            ${this.termLines.length === 0
              ? '<p class="text-slate-700">[ waiting for output ]</p>'
              : this.termLines.slice(-200).map(l => {
                  const cls = l.type === 'stderr' || l.type === 'error'
                    ? 'text-red-400'
                    : l.type === 'info' ? 'text-slate-500' : 'text-emerald-300';
                  return `<div class="${cls}">${this.esc(l.text)}</div>`;
                }).join('')}
          </div>
        </div>

        <p class="text-[10px] text-slate-600">
          After install, the bridge now performs a version check and attempts daemon startup automatically.
        </p>
      </section>`;
  }

  // ---- Hardware tab ----------------------------------------------------------

  private renderHardware(): string {
    return `
      <section class="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <h3 class="text-sm font-bold text-slate-200">Hardware Survey</h3>
            <p class="text-[11px] text-slate-500 mt-0.5">Remote GPU · VRAM · architecture · driver status via <span class="font-mono">lms runtime survey</span></p>
          </div>
          <button id="r-survey-tab"
            class="px-4 py-1.5 rounded-lg text-xs font-semibold transition-all
                   ${this.surveying
                     ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                     : 'bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-400 border border-indigo-500/30 cursor-pointer'}"
            ${this.surveying ? 'disabled' : ''}>
            ${this.surveying ? '⏳ Surveying…' : '↻ Re-run Survey'}
          </button>
        </div>

        ${!this.survey
          ? `<div class="text-center py-10 text-slate-500 text-sm">
               No survey data — use the
               <span class="text-indigo-400 font-semibold">⬡ Survey</span> button on the Status tab
               or click Re-run Survey above.
             </div>`
          : this.survey.raw
            ? `<pre class="bg-[#0d0f14] border border-slate-800 rounded-lg p-4 text-[11px] font-mono
                          text-slate-300 overflow-x-auto whitespace-pre-wrap max-h-96">${this.esc(this.survey.raw)}</pre>`
            : `<pre class="bg-[#0d0f14] border border-slate-800 rounded-lg p-4 text-[11px] font-mono
                          text-slate-300 overflow-x-auto whitespace-pre-wrap max-h-96">${this.esc(JSON.stringify(this.survey.survey, null, 2))}</pre>`
        }
      </section>`;
  }

  // ---------------------------------------------------------------------------
  // Event binding
  // ---------------------------------------------------------------------------

  private bindEvents(): void {
    // Tab switcher
    for (const btn of document.querySelectorAll<HTMLButtonElement>('.remote-tab')) {
      btn.addEventListener('click', () => {
        this.activeTab = btn.dataset['tab'] as RemoteTab;
        this.render(); this.bindEvents();
      });
    }

    // Auth method toggle
    document.getElementById('r-auth-key')?.addEventListener('click', () => {
      this.authMethod = 'key'; this.credential = '';
      this.render(); this.bindEvents();
    });
    document.getElementById('r-auth-pw')?.addEventListener('click', () => {
      this.authMethod = 'password'; this.credential = '';
      this.render(); this.bindEvents();
    });

    // Form field sync (live read on action)
    const sync = () => {
      this.host       = (document.getElementById('r-host') as HTMLInputElement | null)?.value.trim() ?? this.host;
      this.port       = parseInt((document.getElementById('r-port') as HTMLInputElement | null)?.value ?? String(this.port), 10);
      this.username   = (document.getElementById('r-user') as HTMLInputElement | null)?.value.trim() ?? this.username;
      this.credential = (document.getElementById('r-cred') as HTMLTextAreaElement | null)?.value ?? this.credential;
    };

    // Probe
    document.getElementById('r-probe')?.addEventListener('click', () => { sync(); void this.runProbe(); });

    // Lifecycle actions
    document.getElementById('r-start')?.addEventListener('click',   () => { sync(); void this.runDaemonAction('start');   });
    document.getElementById('r-stop')?.addEventListener('click',    () => { sync(); void this.runDaemonAction('stop');    });
    document.getElementById('r-restart')?.addEventListener('click', () => { sync(); void this.runDaemonAction('restart'); });

    // Survey (from status or hardware tab)
    document.getElementById('r-survey')?.addEventListener('click',     () => { sync(); void this.runSurvey(); });
    document.getElementById('r-survey-tab')?.addEventListener('click', () => { sync(); void this.runSurvey(); });

    // Key scrape + apply
    document.getElementById('r-scrape')?.addEventListener('click',    () => { sync(); void this.scrapeKey(); });
    document.getElementById('r-apply-key')?.addEventListener('click', () => { void this.applyKey(); });

    // Install
    document.getElementById('r-install')?.addEventListener('click', () => {
      sync(); void this.startInstall();
    });
    document.getElementById('r-install-stop')?.addEventListener('click', () => {
      this.streamAbort?.abort();
    });
    document.getElementById('r-install-method-official')?.addEventListener('click', () => {
      if (this.streaming) return;
      this.installMethod = 'official';
      localStorage.setItem('dp_install_method', this.installMethod);
      this.render(); this.bindEvents();
    });
    document.getElementById('r-install-method-npm')?.addEventListener('click', () => {
      if (this.streaming) return;
      this.installMethod = 'npm';
      localStorage.setItem('dp_install_method', this.installMethod);
      this.render(); this.bindEvents();
    });
  }

  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
