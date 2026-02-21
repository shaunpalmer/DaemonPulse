/**
 * AuthController — Login / logout flow.
 */

import { EventBus }    from '@/core/EventBus';
import { Store }       from '@/core/Store';
import { AuthService } from '@/services/AuthService';
import { Router }      from '@/core/Router';

export class AuthController {
  async login(username: string, password: string): Promise<{ success: boolean; error?: string }> {
    const result = await AuthService.login(username, password);
    if (result.success) {
      // Decode user info from the token and push into the store
      const token = AuthService.getToken()!;
      const payload = JSON.parse(atob(token.split('.')[1]!)) as {
        sub: number;
        username: string;
        role: 'admin' | 'viewer';
      };
      const user = { id: payload.sub, username: payload.username, role: payload.role, createdAt: new Date() };
      Store.setUser(user);
      // Navigate BEFORE emitting AUTH_SUCCESS so the Shell's Store subscriber
      // already sees the /fleet route when it reacts to the state change.
      Router.navigate('/fleet');
      EventBus.emit({ type: 'AUTH_SUCCESS', payload: user });
    } else {
      EventBus.emit({ type: 'AUTH_FAILED', payload: { reason: result.error ?? 'Unknown error' } });
    }
    return result;
  }

  logout(): void {
    AuthService.logout();
    Store.setUser(null);
    Router.navigate('/login');
  }

  isAuthenticated(): boolean {
    return AuthService.isAuthenticated();
  }
}
