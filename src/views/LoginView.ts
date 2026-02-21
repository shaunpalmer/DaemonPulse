/**
 * LoginView — Full-screen login gate.
 *
 * Features: show/hide password toggle, remember username (localStorage),
 * security notice, inline error display.
 */

import type { AuthController } from '@/controllers/AuthController';

const REMEMBER_KEY   = 'dp_remember_username';
const SAVED_USER_KEY = 'dp_saved_username';

const EYE_OPEN = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;

const EYE_CLOSED = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

export class LoginView {
  constructor(
    private readonly root: HTMLElement,
    private readonly auth: AuthController,
  ) {}

  mount(): void {
    const rememberedUser  = localStorage.getItem(SAVED_USER_KEY) ?? '';
    const rememberChecked = localStorage.getItem(REMEMBER_KEY) === 'true';

    this.root.innerHTML = `
      <div class="min-h-screen bg-[#0d0f14] flex items-center justify-center p-4">
        <div class="w-full max-w-sm">
          <div class="text-center mb-10">
            <div class="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 mb-4">
              <span class="text-2xl text-indigo-400 font-mono">&#9678;</span>
            </div>
            <h1 class="text-xl font-bold tracking-widest uppercase text-white">DaemonPulse</h1>
            <p class="text-xs text-slate-500 mt-1">LM Studio Control Plane</p>
          </div>
          <div class="bg-slate-900 border border-slate-800 rounded-xl p-6">
            <h2 class="text-sm font-semibold text-slate-300 mb-5">Sign in to continue</h2>
            <form id="login-form" class="space-y-4" novalidate>
              <div>
                <label for="login-username" class="block text-[11px] font-medium text-slate-500 uppercase tracking-wider mb-1.5">Username</label>
                <input id="login-username" type="text" autocomplete="username" required placeholder="admin"
                  value="${rememberedUser}"
                  class="w-full bg-[#0d0f14] border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 transition-colors"/>
              </div>
              <div>
                <label for="login-password" class="block text-[11px] font-medium text-slate-500 uppercase tracking-wider mb-1.5">Password</label>
                <div class="relative">
                  <input id="login-password" type="password" autocomplete="current-password" required placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;"
                    class="w-full bg-[#0d0f14] border border-slate-700 rounded-lg px-3 py-2.5 pr-10 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 transition-colors"/>
                  <button type="button" id="login-pw-toggle" title="Show password" aria-label="Toggle password visibility"
                    class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 focus:outline-none transition-colors cursor-pointer"
                  >${EYE_OPEN}</button>
                </div>
              </div>
              <label class="flex items-center gap-2.5 cursor-pointer select-none group">
                <input id="login-remember" type="checkbox" ${rememberChecked ? 'checked' : ''}
                  class="w-3.5 h-3.5 rounded border-slate-600 bg-[#0d0f14] accent-indigo-500 cursor-pointer"/>
                <span class="text-[11px] text-slate-500 group-hover:text-slate-400 transition-colors">Remember my username on this device</span>
              </label>
              <p id="login-error" class="hidden text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2"></p>
              <button type="submit" id="login-submit"
                class="w-full bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white text-sm font-semibold py-2.5 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500/50 disabled:opacity-50 disabled:cursor-not-allowed">
                Sign In
              </button>
              <div class="text-center pt-1">
                <button type="button" id="login-forgot"
                  class="text-[11px] text-slate-600 hover:text-indigo-400 transition-colors focus:outline-none">
                  Forgot password?
                </button>
              </div>
            </form>
          </div>

          <!-- Forgot-password modal (shown when reset flow not yet active) -->
          <div id="forgot-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4">
            <div id="forgot-modal-backdrop" class="absolute inset-0 bg-black/60 backdrop-blur-sm"></div>
            <div class="relative bg-slate-900 border border-slate-700 rounded-xl p-6 w-full max-w-sm shadow-2xl">
              <div class="flex items-start gap-3 mb-4">
                <div class="flex-shrink-0 w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                    class="text-indigo-400">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                  </svg>
                </div>
                <div>
                  <h3 class="text-sm font-semibold text-slate-200">Password Reset</h3>
                  <p class="text-[11px] text-slate-500 mt-0.5">Email-based reset &mdash; coming soon</p>
                </div>
              </div>
              <p class="text-xs text-slate-400 leading-relaxed mb-5">
                Automated password reset via email is on the roadmap but not yet active.
                In the meantime, an admin can reset your password directly via the server CLI:
              </p>
              <pre class="bg-[#0d0f14] border border-slate-800 rounded-lg px-3 py-2.5 text-[11px] text-indigo-300 font-mono overflow-x-auto mb-5">npm run seed</pre>
              <p class="text-[10px] text-slate-600 mb-5">Re-running the seed script resets the default admin credentials.</p>
              <button id="forgot-modal-close"
                class="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium py-2 rounded-lg transition-colors focus:outline-none">
                Got it
              </button>
            </div>
          </div>
          <div class="mt-4 bg-amber-500/5 border border-amber-500/20 rounded-xl px-4 py-3">
            <p class="text-[10px] text-amber-500/70 leading-relaxed">
              <span class="font-semibold text-amber-400/80">Heads up &mdash;</span>
              This panel has direct control over your AI server: load/eject models, tail live logs, issue lifecycle commands.
              Only sign in on a device and network you trust. Session expires after 8&nbsp;hours.
            </p>
          </div>
          <p class="text-center text-[11px] text-slate-600 mt-4">Unofficial project &middot; Not affiliated with LM Studio</p>
        </div>
      </div>
    `;

    this.bindEvents();
    const pwInput = document.getElementById('login-password') as HTMLInputElement;
    const unInput = document.getElementById('login-username') as HTMLInputElement;
    if (rememberedUser) { pwInput.focus(); } else { unInput.focus(); }
  }

  private bindEvents(): void {
    const form     = document.getElementById('login-form')      as HTMLFormElement;
    const errorEl  = document.getElementById('login-error')     as HTMLParagraphElement;
    const submit   = document.getElementById('login-submit')    as HTMLButtonElement;
    const pwInput  = document.getElementById('login-password')  as HTMLInputElement;
    const pwToggle = document.getElementById('login-pw-toggle') as HTMLButtonElement;
    const remember    = document.getElementById('login-remember')    as HTMLInputElement;
    const forgotBtn   = document.getElementById('login-forgot')       as HTMLButtonElement;
    const forgotModal = document.getElementById('forgot-modal')        as HTMLDivElement;
    const forgotClose = document.getElementById('forgot-modal-close')  as HTMLButtonElement;
    const forgotBack  = document.getElementById('forgot-modal-backdrop') as HTMLDivElement;

    const openForgot  = () => forgotModal.classList.remove('hidden');
    const closeForgot = () => forgotModal.classList.add('hidden');

    forgotBtn.addEventListener('click', openForgot);
    forgotClose.addEventListener('click', closeForgot);
    forgotBack.addEventListener('click', closeForgot);
    forgotModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeForgot(); });

    pwToggle.addEventListener('click', () => {
      const revealing    = pwInput.type === 'password';
      pwInput.type       = revealing ? 'text' : 'password';
      pwToggle.innerHTML = revealing ? EYE_CLOSED : EYE_OPEN;
      pwToggle.title     = revealing ? 'Hide password' : 'Show password';
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = (document.getElementById('login-username') as HTMLInputElement).value.trim();
      const password = pwInput.value;

      if (!username || !password) {
        this.showError(errorEl, 'Username and password are required.');
        return;
      }

      if (remember.checked) {
        localStorage.setItem(REMEMBER_KEY,   'true');
        localStorage.setItem(SAVED_USER_KEY, username);
      } else {
        localStorage.removeItem(REMEMBER_KEY);
        localStorage.removeItem(SAVED_USER_KEY);
      }

      submit.disabled    = true;
      submit.textContent = 'Signing in\u2026';
      errorEl.classList.add('hidden');

      const result = await this.auth.login(username, password);

      if (!result.success) {
        this.showError(errorEl, result.error ?? 'Login failed.');
        submit.disabled    = false;
        submit.textContent = 'Sign In';
        pwInput.type       = 'password';
        pwToggle.innerHTML = EYE_OPEN;
        pwToggle.title     = 'Show password';
      }
    });
  }

  private showError(el: HTMLParagraphElement, msg: string): void {
    el.textContent = msg;
    el.classList.remove('hidden');
  }
}
