/**
 * DaemonPulse — Entry point.
 *
 * Wires up singletons, bootstraps auth check, hands off to the Shell view.
 */

import './style.css';
import { Router }           from '@/core/Router';
import { Store }            from '@/core/Store';
import { EventBus }         from '@/core/EventBus';
import { AuthService }      from '@/services/AuthService';
import { DaemonService }    from '@/services/DaemonService';
import { HeartbeatService } from '@/services/HeartbeatService';
import { ModelService }     from '@/services/ModelService';
import { DaemonController } from '@/controllers/DaemonController';
import { ModelController }  from '@/controllers/ModelController';
import { AuthController }   from '@/controllers/AuthController';
import { Shell }            from '@/views/layout/Shell';

// --- Compose the service/controller graph ---

const daemonService    = new DaemonService('');          // baseUrl injected from env at build time
const heartbeatService = new HeartbeatService('local', daemonService);
const modelService     = new ModelService(daemonService);

export const controllers = {
  daemon: new DaemonController(daemonService, heartbeatService),
  model:  new ModelController(modelService, heartbeatService),
  auth:   new AuthController(),
} as const;

// --- Bootstrap ---

function boot(): void {
  const appEl = document.getElementById('app');
  if (!appEl) throw new Error('#app element not found');

  // Restore user into Store if a valid token already exists in sessionStorage.
  // Without this, the Sidebar always shows "Not logged in" after a page refresh
  // even when the session is still live.
  if (AuthService.isAuthenticated()) {
    const token = AuthService.getToken()!;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]!)) as {
        sub: number; username: string; role: 'admin' | 'viewer';
      };
      Store.setUser({ id: payload.sub, username: payload.username, role: payload.role, createdAt: new Date() });
    } catch { /* malformed token — ignore, middleware will reject it */ }
  }

  // If not authenticated, go straight to login
  if (!AuthService.isAuthenticated()) {
    Router.navigate('/login');
  }

  // Mount the shell — it owns all view rendering
  const shell = new Shell(appEl, controllers);
  shell.mount();

  // Start routing
  Router.init();

  // Start heartbeat if we have a node
  if (AuthService.isAuthenticated()) {
    heartbeatService.start();
  }

  // Restore daemon permission key from localStorage to the running proxy server.
  // This ensures the key survives a browser refresh even if the proxy was restarted
  // without DAEMON_API_KEY set in .env.
  const storedDaemonKey = localStorage.getItem('dp_daemon_key');
  if (storedDaemonKey) {
    void fetch('/api/proxy/config/daemon-key', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ key: storedDaemonKey }),
    });
  }

  // Begin heartbeat after login
  EventBus.on('AUTH_SUCCESS', () => heartbeatService.start());
}

boot();
