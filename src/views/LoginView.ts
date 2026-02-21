/**
 * LoginView — Full-screen login gate.
 *
 * Calls AuthController.login() on submit. Displays errors inline.
 * No framework, no library — just clean TypeScript DOM manipulation.
 */

import type { AuthController } from '@/controllers/AuthController';

export class LoginView {
  constructor(
    private readonly root: HTMLElement,
    private readonly auth: AuthController,
  ) {}

  mount(): void {
    this.root.innerHTML = `
      <div class="min-h-screen bg-[#0d0f14] flex items-center justify-center p-4">
        <div class="w-full max-w-sm">

          <!-- Logo / Brand -->
          <div class="text-center mb-10">
            <div class="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 mb-4">
              <span class="text-2xl text-indigo-400 font-mono">◎</span>
            </div>
            <h1 class="text-xl font-bold tracking-widest uppercase text-white">DaemonPulse</h1>
            <p class="text-xs text-slate-500 mt-1">LM Studio Control Plane</p>
          </div>

          <!-- Form card -->
          <div class="bg-slate-900 border border-slate-800 rounded-xl p-6">
            <h2 class="text-sm font-semibold text-slate-300 mb-5">Sign in to continue</h2>

            <form id="login-form" class="space-y-4" novalidate>
              <div>
                <label for="login-username" class="block text-[11px] font-medium text-slate-500 uppercase tracking-wider mb-1.5">
                  Username
                </label>
                <input
                  id="login-username"
                  type="text"
                  autocomplete="username"
                  required
                  placeholder="admin"
                  class="w-full bg-[#0d0f14] border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200
                         placeholder-slate-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50
                         transition-colors"
                />
              </div>

              <div>
                <label for="login-password" class="block text-[11px] font-medium text-slate-500 uppercase tracking-wider mb-1.5">
                  Password
                </label>
                <input
                  id="login-password"
                  type="password"
                  autocomplete="current-password"
                  required
                  placeholder="••••••••"
                  class="w-full bg-[#0d0f14] border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200
                         placeholder-slate-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50
                         transition-colors"
                />
              </div>

              <!-- Error message -->
              <p id="login-error" class="hidden text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2"></p>

              <button
                type="submit"
                id="login-submit"
                class="w-full bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700
                       text-white text-sm font-semibold py-2.5 rounded-lg
                       transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500/50
                       disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Sign In
              </button>
            </form>
          </div>

          <p class="text-center text-[11px] text-slate-600 mt-6">
            Unofficial project · Not affiliated with LM Studio
          </p>
        </div>
      </div>
    `;

    this.bindEvents();
  }

  private bindEvents(): void {
    const form    = document.getElementById('login-form') as HTMLFormElement;
    const errorEl = document.getElementById('login-error') as HTMLParagraphElement;
    const submit  = document.getElementById('login-submit') as HTMLButtonElement;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = (document.getElementById('login-username') as HTMLInputElement).value.trim();
      const password = (document.getElementById('login-password') as HTMLInputElement).value;

      if (!username || !password) {
        this.showError(errorEl, 'Username and password are required.');
        return;
      }

      submit.disabled = true;
      submit.textContent = 'Signing in…';
      errorEl.classList.add('hidden');

      const result = await this.auth.login(username, password);

      if (!result.success) {
        this.showError(errorEl, result.error ?? 'Login failed.');
        submit.disabled = false;
        submit.textContent = 'Sign In';
      }
      // On success AuthController navigates to /fleet automatically
    });
  }

  private showError(el: HTMLParagraphElement, msg: string): void {
    el.textContent = msg;
    el.classList.remove('hidden');
  }
}
