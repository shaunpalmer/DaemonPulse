/**
 * Sidebar — Left navigation (the vertical bar of the L-shape).
 *
 * Renders the five module links and a status indicator strip.
 * Highlights the active route. Never initiates data fetching.
 */

import { Store }  from '@/core/Store';
import { Router } from '@/core/Router';
import type { Route } from '@/core/Router';

const NAV_ITEMS: { route: Route; label: string; icon: string }[] = [
  { route: '/fleet',     label: 'The Fleet',     icon: '⬡' },
  { route: '/forge',     label: 'The Forge',     icon: '⚙' },
  { route: '/pulse',     label: 'The Pulse',     icon: '◎' },
  { route: '/toolchain', label: 'The Toolchain', icon: '⎘' },
  { route: '/console',   label: 'The Console',   icon: '>' },
  { route: '/settings',  label: 'Settings',      icon: '⚊' },
];

export class Sidebar {
  constructor(private readonly root: HTMLElement) {}

  mount(): void {
    this.render(Store.getState().currentRoute);
    Store.subscribe(state => this.render(state.currentRoute));
  }

  private render(activeRoute: string): void {
    const state = Store.getState();
    const user  = state.currentUser;

    this.root.innerHTML = `
      <div class="flex flex-col h-full">
        <!-- Logo -->
        <div class="px-4 py-5 border-b border-slate-800">
          <h1 class="text-sm font-bold tracking-widest uppercase text-indigo-400">DaemonPulse</h1>
          <p class="text-[10px] text-slate-600 mt-0.5">LM Studio Control Plane</p>
        </div>

        <!-- Nav -->
        <nav class="flex-1 py-4 space-y-1 px-2">
          ${NAV_ITEMS.map(item => this.navItem(item, activeRoute)).join('')}
        </nav>

        <!-- User strip -->
        <div class="px-4 py-3 border-t border-slate-800 text-[11px] text-slate-500">
          ${user ? `<span>${user.username}</span> · <span class="text-indigo-500">${user.role}</span>` : '<span>Not logged in</span>'}
        </div>
      </div>
    `;

    // Attach nav click handlers
    NAV_ITEMS.forEach(item => {
      document.getElementById(`nav-${item.route.slice(1)}`)
        ?.addEventListener('click', () => Router.navigate(item.route));
    });
  }

  private navItem(item: { route: Route; label: string; icon: string }, activeRoute: string): string {
    const isActive = activeRoute === item.route;
    const base  = 'flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer text-sm transition-colors';
    const style = isActive
      ? `${base} bg-indigo-600/20 text-indigo-400 border border-indigo-500/30`
      : `${base} text-slate-400 hover:bg-slate-800 hover:text-slate-200`;

    return `
      <div id="nav-${item.route.slice(1)}" class="${style}">
        <span class="font-mono text-xs w-4 text-center">${item.icon}</span>
        <span>${item.label}</span>
      </div>
    `;
  }
}
