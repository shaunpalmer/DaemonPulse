/**
 * SettingsView — Multi-target manager, server defaults, dev/live mode, session.
 *
 * Stored keys (localStorage):
 *   dp_default_ttl          — integer seconds (0 = never)
 *   dp_default_n_parallel   — integer 1-16 (default 4)
 *   dp_default_context      — integer tokens (default 4096)
 *   dp_developer_mode       — 'true' | 'false'
 *   dp_daemon_key           — LM Studio Permission Key for default target
 *   dp_targets              — JSON IDaemonTarget[] (saved target list)
 */

import { AuthService }  from '@/services/AuthService';
import { Router }       from '@/core/Router';
import type { IDaemonTarget } from '@/types';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type TargetRow = Omit<IDaemonTarget, 'key'> & { keyHint?: string };

export class SettingsView {
  private targets:       TargetRow[] = [];
  private activeTargetId = '';
  private targetWorking  = false;   // spinner while activating/deleting

  private showAddForm    = false;
  private addLabel       = '';
  private addUrl         = 'http://';
  private addHost        = '';
  private addKey         = '';
  private addMode: 'local' | 'remote' = 'local';

  // Permission key state (for active target)
  private keyHint   = '';
  private keyHasKey = false;
  private keySaved  = false;

  // Defaults form values
  private defTtl  = parseInt(localStorage.getItem('dp_default_ttl')        ?? '0',    10);
  private defNp   = parseInt(localStorage.getItem('dp_default_n_parallel') ?? '4',    10);
  private defCtx  = parseInt(localStorage.getItem('dp_default_context')    ?? '4096', 10);
  private devMode =          localStorage.getItem('dp_developer_mode') === 'true';
  private saved   = false;

  constructor(private readonly root: HTMLElement) {}

  mount(): void {
    this.render();
    void this.fetchTargets();
    void this.fetchKeyStatus();
  }

  unmount(): void { this.root.innerHTML = ''; }

  // ── Data ────────────────────────────────────────────────────────────────────

  private async fetchTargets(): Promise<void> {
    try {
      const res = await AuthService.apiFetch('/api/proxy/config/targets');
      if (res.ok) {
        const d = (await res.json()) as { activeId: string; targets: TargetRow[] };
        this.activeTargetId = d.activeId;
        this.targets        = d.targets;
      }
    } catch { /* leave empty */ }
    this.render();
  }

  private async activateTarget(id: string): Promise<void> {
    this.targetWorking = true; this.render();
    try {
      const res = await AuthService.apiFetch(`/api/proxy/config/targets/${id}/activate`, { method: 'POST' });
      if (res.ok) { this.activeTargetId = id; void this.fetchKeyStatus(); }
    } catch { /* leave */ }
    this.targetWorking = false;
    void this.fetchTargets();
  }

  private async deleteTarget(id: string): Promise<void> {
    this.targetWorking = true; this.render();
    try {
      await AuthService.apiFetch(`/api/proxy/config/targets/${id}`, { method: 'DELETE' });
    } catch { /* leave */ }
    this.targetWorking = false;
    void this.fetchTargets();
  }

  private async addTarget(): Promise<void> {
    if (!this.addLabel.trim() || !this.addUrl.trim()) return;
    this.targetWorking = true; this.render();
    try {
      await AuthService.apiFetch('/api/proxy/config/targets', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: this.addLabel.trim(),
          url:   this.addUrl.trim().replace(/\/$/, ''),
          host:  this.addHost.trim() || undefined,
          key:   this.addKey.trim()  || undefined,
          mode:  this.addMode,
        }),
      });
      this.addLabel = ''; this.addUrl = 'http://'; this.addHost = '';
      this.addKey   = ''; this.showAddForm = false;
    } catch { /* leave */ }
    this.targetWorking = false;
    void this.fetchTargets();
  }

  private async fetchKeyStatus(): Promise<void> {
    try {
      const res = await AuthService.apiFetch('/api/proxy/config/daemon-key');
      if (res.ok) {
        const d = (await res.json()) as { hasKey: boolean; hint: string };
        this.keyHasKey = d.hasKey;
        this.keyHint   = d.hint;
      }
    } catch { /* leave defaults */ }
    this.render();
  }

  private async savePermissionKey(key: string): Promise<void> {
    try {
      const res = await AuthService.apiFetch('/api/proxy/config/daemon-key', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (res.ok) {
        if (key) localStorage.setItem('dp_daemon_key', key);
        else     localStorage.removeItem('dp_daemon_key');
        this.keySaved = true;
        void this.fetchKeyStatus();
        setTimeout(() => { this.keySaved = false; this.render(); }, 2000);
      }
    } catch { /* ignore */ }
  }

  // ── Save ────────────────────────────────────────────────────────────────────

  private save(): void {
    localStorage.setItem('dp_default_ttl',        String(this.defTtl));
    localStorage.setItem('dp_default_n_parallel', String(this.defNp));
    localStorage.setItem('dp_default_context',    String(this.defCtx));
    localStorage.setItem('dp_developer_mode',     String(this.devMode));
    this.saved = true;
    this.render();
    // Clear "Saved" badge after 2 s
    setTimeout(() => { this.saved = false; this.render(); }, 2000);
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  private render(): void {
    this.root.innerHTML = `
      <div class="max-w-xl mx-auto py-8 px-4 space-y-8 text-sm">

        <!-- Header -->
        <div class="flex items-center justify-between">
          <h1 class="text-base font-bold text-slate-200 tracking-wide">Settings</h1>
          ${this.saved ? '<span class="text-[11px] font-semibold text-emerald-400 bg-emerald-950 border border-emerald-800 rounded-full px-3 py-0.5">Saved ✓</span>' : ''}
        </div>

        <!-- Daemon Targets -->
        <section class="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4 space-y-3">
          <div class="flex items-center justify-between">
            <h2 class="text-[11px] font-bold uppercase tracking-wider text-slate-500">Daemon Targets</h2>
            <button id="set-add-target-toggle"
              class="text-[11px] font-semibold text-indigo-400 hover:text-indigo-300
                     border border-indigo-800 hover:border-indigo-600 rounded-lg px-3 py-1 transition-colors">
              ${this.showAddForm ? '× Cancel' : '+ Add target'}
            </button>
          </div>

          <!-- Target list -->
          <div class="space-y-1.5">
            ${this.targets.length === 0
              ? '<p class="text-[11px] text-slate-700 font-mono">Loading…</p>'
              : this.targets.map(t => `
                <div class="flex items-center gap-2.5 rounded-lg px-3 py-2
                            ${t.id === this.activeTargetId ? 'bg-indigo-500/10 border border-indigo-500/30' : 'bg-slate-800/50'}">
                  <span class="w-2 h-2 rounded-full flex-shrink-0
                               ${t.id === this.activeTargetId ? 'bg-emerald-400' : 'bg-slate-700'}"></span>
                  <div class="flex-1 min-w-0">
                    <p class="text-[12px] font-semibold text-slate-200 truncate">${esc(t.label)}</p>
                    <p class="text-[10px] font-mono text-slate-500 truncate">${esc(t.url)}</p>
                  </div>
                  <span class="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded
                               ${t.mode === 'remote' ? 'bg-amber-500/15 text-amber-400' : 'bg-slate-700/60 text-slate-500'}">
                    ${t.mode}
                  </span>
                  ${t.id !== this.activeTargetId
                    ? `<button data-activate-id="${t.id}"
                         class="text-[10px] font-semibold text-indigo-400 hover:text-indigo-300
                                border border-indigo-800 rounded px-2 py-0.5 transition-colors
                                ${this.targetWorking ? 'opacity-40 pointer-events-none' : ''}">
                         Activate
                       </button>`
                    : '<span class="text-[10px] font-semibold text-emerald-400">Active</span>'}
                  ${t.id !== 'default'
                    ? `<button data-delete-id="${t.id}"
                         class="text-[10px] text-slate-600 hover:text-red-400 transition-colors
                                ${this.targetWorking ? 'opacity-40 pointer-events-none' : ''}">
                         ×
                       </button>`
                    : ''}
                </div>
              `).join('')}
          </div>

          <!-- Add Target form -->
          ${this.showAddForm ? `
            <div class="mt-3 space-y-2.5 border-t border-slate-800 pt-3">
              <div class="grid grid-cols-2 gap-2">
                <div>
                  <label class="block text-[10px] text-slate-500 mb-0.5">Label</label>
                  <input id="set-add-label" type="text" value="${esc(this.addLabel)}"
                    placeholder="e.g. AWS g6.2xlarge"
                    class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5
                           text-sm text-slate-200 placeholder-slate-600
                           focus:outline-none focus:ring-1 focus:ring-indigo-500">
                </div>
                <div>
                  <label class="block text-[10px] text-slate-500 mb-0.5">Mode</label>
                  <select id="set-add-mode"
                    class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5
                           text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer">
                    <option value="local"  ${this.addMode === 'local'  ? 'selected' : ''}>Local</option>
                    <option value="remote" ${this.addMode === 'remote' ? 'selected' : ''}>Remote</option>
                  </select>
                </div>
              </div>
              <div>
                <label class="block text-[10px] text-slate-500 mb-0.5">API URL</label>
                <input id="set-add-url" type="url" value="${esc(this.addUrl)}"
                  placeholder="http://18.x.x.x:1234"
                  class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5
                         text-sm font-mono text-slate-200 placeholder-slate-600
                         focus:outline-none focus:ring-1 focus:ring-indigo-500">
              </div>
              <div class="grid grid-cols-2 gap-2">
                <div>
                  <label class="block text-[10px] text-slate-500 mb-0.5">
                    lms --host
                    <span class="text-slate-700">(optional — if different from URL host)</span>
                  </label>
                  <input id="set-add-host" type="text" value="${esc(this.addHost)}"
                    placeholder="192.168.1.70"
                    class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5
                           text-sm font-mono text-slate-200 placeholder-slate-600
                           focus:outline-none focus:ring-1 focus:ring-indigo-500">
                </div>
                <div>
                  <label class="block text-[10px] text-slate-500 mb-0.5">Permission Key</label>
                  <input id="set-add-key" type="password" value="${esc(this.addKey)}"
                    placeholder="lms-key-…"
                    class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5
                           text-sm font-mono text-slate-200 placeholder-slate-600
                           focus:outline-none focus:ring-1 focus:ring-indigo-500">
                </div>
              </div>
              <div class="flex justify-end">
                <button id="set-add-target-submit"
                  class="px-5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs
                         font-semibold rounded-lg transition-colors">
                  Save target
                </button>
              </div>
            </div>
          ` : ''}
        </section>

        <!-- Permission Key -->
        <section class="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4 space-y-3">
          <div class="flex items-center justify-between">
            <h2 class="text-[11px] font-bold uppercase tracking-wider text-slate-500">Permission Key</h2>
            ${this.keySaved ? '<span class="text-[11px] font-semibold text-emerald-400">Key saved ✓</span>' : ''}
          </div>
          <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full flex-shrink-0 ${this.keyHasKey ? 'bg-emerald-500' : 'bg-slate-700'}"></span>
            <span class="text-[12px] font-mono ${this.keyHasKey ? 'text-emerald-400' : 'text-slate-600'}">
              ${this.keyHasKey ? `Active &nbsp;${esc(this.keyHint)}` : 'No key configured — requests sent without auth'}
            </span>
          </div>
          <div class="flex gap-2">
            <input id="set-daemon-key" type="password"
              placeholder="Paste LM Studio Permission Key (leave blank to clear)"
              class="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5
                     text-sm font-mono text-slate-200 placeholder-slate-600
                     focus:outline-none focus:ring-1 focus:ring-indigo-500">
            <button id="set-daemon-key-save"
              class="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs
                     font-semibold rounded-lg transition-colors flex-shrink-0">
              Apply
            </button>
          </div>
          <p class="text-[10px] text-slate-600">
            LM Studio &rsaquo; Settings &rsaquo; Server &rsaquo; Permission Keys.
            Leave blank to disable. Key is held in proxy memory and not written to disk.
          </p>
        </section>

        <!-- Server Defaults -->
        <section class="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4 space-y-4">
          <h2 class="text-[11px] font-bold uppercase tracking-wider text-slate-500">
            Server Defaults
            <span class="text-slate-700 normal-case tracking-normal font-normal ml-1">
              (pre-filled in Load Wizard — volatile, not persisted in daemon)
            </span>
          </h2>

          <!-- Default TTL -->
          <div>
            <label class="block text-[11px] font-semibold text-slate-400 mb-1">
              Idle TTL
              <span id="set-ttl-label" class="font-mono text-slate-300 ml-1">
                ${this.defTtl > 0 ? `${this.defTtl} s` : 'never'}
              </span>
            </label>
            <input id="set-ttl" type="range" min="0" max="3600" step="60" value="${this.defTtl}"
              class="w-full accent-indigo-500 cursor-pointer">
            <p class="text-[10px] text-slate-600 mt-1">
              Seconds until an idle model is auto-ejected. 0 = never unload.
            </p>
          </div>

          <!-- Default n_parallel -->
          <div>
            <label class="block text-[11px] font-semibold text-slate-400 mb-1">
              Inference slots (n_parallel)
              <span id="set-np-label" class="font-mono text-slate-300 ml-1">${this.defNp}</span>
            </label>
            <input id="set-np" type="range" min="1" max="16" step="1" value="${this.defNp}"
              class="w-full accent-indigo-500 cursor-pointer">
            <p class="text-[10px] text-slate-600 mt-1">
              Concurrent inference slots per loaded model. LM Studio default is 4.
            </p>
          </div>

          <!-- Default context -->
          <div>
            <label class="block text-[11px] font-semibold text-slate-400 mb-1">
              Default context length
            </label>
            <input id="set-ctx" type="number" min="512" max="131072" step="512" value="${this.defCtx}"
              class="w-40 bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5
                     text-slate-200 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500">
            <p class="text-[10px] text-slate-600 mt-1">Tokens. Min 512.</p>
          </div>
        </section>

        <!-- Developer / Live Mode -->
        <section class="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4 space-y-4">
          <div class="flex items-center justify-between">
            <h2 class="text-[11px] font-bold uppercase tracking-wider text-slate-500">Mode</h2>
            <div class="flex items-center gap-2 text-[11px] font-semibold">
              <span class="${!this.devMode ? 'text-amber-400' : 'text-slate-600'}">Live</span>
              <label class="relative inline-flex items-center cursor-pointer">
                <input id="set-devmode" type="checkbox" ${this.devMode ? 'checked' : ''} class="sr-only peer">
                <div class="w-10 h-5 bg-amber-900/50 peer-checked:bg-indigo-600
                            rounded-full transition-colors
                            peer-focus:ring-2 peer-focus:ring-indigo-500"></div>
                <div class="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full
                            transition-transform peer-checked:translate-x-5"></div>
              </label>
              <span class="${this.devMode ? 'text-indigo-400' : 'text-slate-600'}">Dev</span>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-3 text-[11px]">
            ${([
              {
                icon: '🔐',
                label: 'Auth',
                dev:  'No Permission Key required — faster local iteration.',
                live: 'Permission Key enforced on every request.',
              },
              {
                icon: '🎮',
                label: 'Controls',
                dev:  'All sliders exposed: n_parallel, GPU %, CPU MoE flags.',
                live: 'Locked to production presets — prevents remote OOM stalls.',
              },
              {
                icon: '📝',
                label: 'Logs',
                dev:  'Full runtime log stream — every inference event.',
                live: 'High-level events only: model load, server start, errors.',
              },
            ] as const).map(row => `
              <div class="flex gap-3 rounded-lg px-3 py-2.5 bg-slate-800/50">
                <span class="text-base leading-none">${row.icon}</span>
                <div class="flex-1">
                  <p class="font-semibold text-slate-300 mb-0.5">${row.label}</p>
                  <p class="${this.devMode ? 'text-indigo-400' : 'text-slate-500'}">
                    ${this.devMode ? row.dev : row.live}
                  </p>
                </div>
              </div>
            `).join('')}
          </div>
        </section>

        <!-- Session -->
        <section class="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4 space-y-3">
          <h2 class="text-[11px] font-bold uppercase tracking-wider text-slate-500">Session</h2>
          <div class="flex items-center justify-between">
            <div class="text-[12px] text-slate-400">
              Signed in as
              <span class="font-mono text-slate-200 ml-1">${esc(localStorage.getItem('dp_username') ?? 'admin')}</span>
            </div>
            <button id="set-logout"
              class="text-xs font-semibold text-red-400 hover:text-red-300
                     border border-red-900 hover:border-red-700 rounded-lg px-4 py-1.5 transition-colors">
              Sign out
            </button>
          </div>
        </section>

        <!-- Save -->
        <div class="flex justify-end">
          <button id="set-save"
            class="bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700
                   text-white text-sm font-semibold px-6 py-2 rounded-xl transition-colors">
            Save defaults
          </button>
        </div>

      </div>
    `;

    this.bindEvents();
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  private bindEvents(): void {
    // Target management
    document.getElementById('set-add-target-toggle')?.addEventListener('click', () => {
      this.showAddForm = !this.showAddForm;
      this.render();
    });

    // Activate / delete via event delegation
    this.root.querySelectorAll<HTMLButtonElement>('[data-activate-id]').forEach(btn => {
      btn.addEventListener('click', () => void this.activateTarget(btn.dataset['activateId'] ?? ''));
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-delete-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (confirm(`Delete target "${btn.closest('.flex')?.querySelector('p')?.textContent ?? ''}"?`)) {
          void this.deleteTarget(btn.dataset['deleteId'] ?? '');
        }
      });
    });

    // Add form live fields
    (document.getElementById('set-add-label') as HTMLInputElement | null)
      ?.addEventListener('input', (e) => { this.addLabel = (e.target as HTMLInputElement).value; });
    (document.getElementById('set-add-url') as HTMLInputElement | null)
      ?.addEventListener('input', (e) => { this.addUrl = (e.target as HTMLInputElement).value; });
    (document.getElementById('set-add-host') as HTMLInputElement | null)
      ?.addEventListener('input', (e) => { this.addHost = (e.target as HTMLInputElement).value; });
    (document.getElementById('set-add-key') as HTMLInputElement | null)
      ?.addEventListener('input', (e) => { this.addKey = (e.target as HTMLInputElement).value; });
    (document.getElementById('set-add-mode') as HTMLSelectElement | null)
      ?.addEventListener('change', (e) => {
        this.addMode = (e.target as HTMLSelectElement).value as 'local' | 'remote';
      });
    document.getElementById('set-add-target-submit')?.addEventListener('click', () => void this.addTarget());

    // TTL slider
    const ttlEl = document.getElementById('set-ttl') as HTMLInputElement | null;
    ttlEl?.addEventListener('input', () => {
      const v = parseInt(ttlEl.value, 10);
      this.defTtl = v;
      const lbl = document.getElementById('set-ttl-label');
      if (lbl) lbl.textContent = v > 0 ? `${v} s` : 'never';
    });

    // n_parallel slider
    const npEl = document.getElementById('set-np') as HTMLInputElement | null;
    npEl?.addEventListener('input', () => {
      const v = parseInt(npEl.value, 10);
      if (!isNaN(v)) {
        this.defNp = v;
        const lbl = document.getElementById('set-np-label');
        if (lbl) lbl.textContent = String(v);
      }
    });

    // Context input
    const ctxEl = document.getElementById('set-ctx') as HTMLInputElement | null;
    ctxEl?.addEventListener('change', () => {
      const v = parseInt(ctxEl.value, 10);
      if (!isNaN(v) && v >= 512) this.defCtx = v;
    });

    // Dev/Live mode toggle — re-render immediately to update behavioral description
    const devEl = document.getElementById('set-devmode') as HTMLInputElement | null;
    devEl?.addEventListener('change', () => {
      this.devMode = devEl.checked;
      this.render();   // re-render so behavioral diff text updates instantly
    });

    // Save defaults
    document.getElementById('set-save')?.addEventListener('click', () => this.save());

    // Permission key apply
    document.getElementById('set-daemon-key-save')?.addEventListener('click', () => {
      const el = document.getElementById('set-daemon-key') as HTMLInputElement | null;
      if (el) void this.savePermissionKey(el.value.trim());
    });

    // Logout
    document.getElementById('set-logout')?.addEventListener('click', () => {
      AuthService.logout();
      Router.navigate('/login');
    });
  }
}
