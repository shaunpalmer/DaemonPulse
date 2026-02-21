/**
 * Router — Client-side SPA navigation.
 *
 * Maps URL hash routes to view names. Keeps navigation decoupled
 * from views — views never call each other directly.
 */

import { Store } from './Store';
import { EventBus } from './EventBus';

export type Route =
  | '/fleet'
  | '/forge'
  | '/pulse'
  | '/toolchain'
  | '/console'
  | '/settings'
  | '/remote'
  | '/login';

const VALID_ROUTES = new Set<Route>([
  '/fleet', '/forge', '/pulse', '/toolchain', '/console', '/settings', '/remote', '/login',
]);

function isValidRoute(path: string): path is Route {
  return VALID_ROUTES.has(path as Route);
}

class RouterClass {
  init(): void {
    window.addEventListener('hashchange', () => this.handleChange());
    this.handleChange();
  }

  navigate(route: Route): void {
    window.location.hash = route;
  }

  private handleChange(): void {
    const hash = window.location.hash.slice(1) || '/fleet';
    const route = isValidRoute(hash) ? hash : '/fleet';
    Store.navigate(route);
  }
}

// Listen to NAVIGATION events so the EventBus can also trigger navigation
EventBus.on('NAVIGATION', ({ payload }) => {
  if (window.location.hash.slice(1) !== payload.route) {
    window.location.hash = payload.route;
  }
});

export const Router = new RouterClass();
