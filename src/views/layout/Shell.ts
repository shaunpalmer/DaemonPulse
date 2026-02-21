/**
 * Shell — Top-level view. Owns the L-shaped layout:
 *   [ Sidebar ] [ Main Canvas ]
 *
 * Listens to Store changes and swaps the main canvas content
 * based on the current route. No controllers here — Shell is
 * purely responsible for layout and view composition.
 */

import { Store }       from '@/core/Store';
import { EventBus }    from '@/core/EventBus';
import { AuthService } from '@/services/AuthService';
import { Router }      from '@/core/Router';
import { Sidebar }     from './Sidebar';

import { LoginView }     from '@/views/LoginView';
import { FleetView }     from '@/views/FleetView';
import { ForgeView }     from '@/views/ForgeView';
import { PulseView }     from '@/views/PulseView';
import { ToolchainView } from '@/views/ToolchainView';
import { ConsoleView }   from '@/views/ConsoleView';
import { SettingsView }  from '@/views/SettingsView';
import { RemoteView }    from '@/views/RemoteView';
import type { DaemonController } from '@/controllers/DaemonController';
import type { AuthController }   from '@/controllers/AuthController';

// Any view that holds intervals/subscriptions must expose unmount()
interface IView {
  mount(): void;
  unmount?(): void;
}

interface IControllers {
  daemon: DaemonController;
  auth:   AuthController;
}

export class Shell {
  private sidebar!: Sidebar;
  private currentView: IView | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly controllers: IControllers,
  ) {}

  mount(): void {
    this.root.innerHTML = `
      <div class="flex h-screen overflow-hidden">
        <div id="sidebar-host" class="w-56 flex-shrink-0 bg-slate-900 border-r border-slate-800"></div>
        <main id="main-canvas" class="flex-1 overflow-y-auto p-6"></main>
      </div>
    `;

    const sidebarHost = document.getElementById('sidebar-host')!;
    this.sidebar = new Sidebar(sidebarHost);
    this.sidebar.mount();

    // Re-render main canvas on route change
    Store.subscribe(state => this.renderCanvas(state.currentRoute));
    // NOTE: no separate AUTH_SUCCESS listener here — AuthController.login() calls
    // Router.navigate('/fleet') before emitting AUTH_SUCCESS, so the Store
    // subscriber above already fires with the correct /fleet route.

    // Initial render
    this.renderCanvas(Store.getState().currentRoute);
  }

  private renderCanvas(route: string): void {
    const canvas = document.getElementById('main-canvas');
    if (!canvas) return;

    // Auth guard — any protected route requires a valid session.
    // If the token has expired or was never set, bounce to /login.
    if (route !== '/login' && !AuthService.isAuthenticated()) {
      Router.navigate('/login');
      return;
    }

    // Tear down previous view (clears intervals, event listeners, etc.)
    this.currentView?.unmount?.();
    this.currentView = null;
    canvas.innerHTML = '';

    let view: IView;

    switch (route) {
      case '/login':     view = new LoginView(canvas, this.controllers.auth);   break;
      case '/fleet':     view = new FleetView(canvas, this.controllers.daemon); break;
      case '/forge':     view = new ForgeView(canvas);     break;
      case '/pulse':     view = new PulseView(canvas);     break;
      case '/toolchain': view = new ToolchainView(canvas); break;
      case '/console':   view = new ConsoleView(canvas);   break;
      case '/remote':    view = new RemoteView(canvas);    break;
      case '/settings':  view = new SettingsView(canvas);  break;
      default:
        canvas.innerHTML = `
          <div class="text-slate-500 font-mono text-sm p-4">
            [ ${route} — no view registered ]
          </div>`;
        return;
    }

    this.currentView = view;
    view.mount();
  }
}
