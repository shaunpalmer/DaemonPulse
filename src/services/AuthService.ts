/**
 * AuthService — Client-side token storage and validation.
 *
 * Stores the JWT in sessionStorage (not localStorage) so it is
 * automatically cleared when the browser tab closes. Never hardcodes
 * credentials. Actual credential verification happens server-side.
 */

const TOKEN_KEY = 'dp_auth_token';

/**
 * Thrown by AuthService.apiFetch() when a 401 is received.
 * Callers should catch this and bail silently — the redirect to /login
 * is already in motion. Never display this as a user-facing error.
 */
export class AuthRedirectError extends Error {
  constructor() {
    super('AUTH_REDIRECT');
    this.name = 'AuthRedirectError';
  }
}

export class AuthService {
  static getToken(): string | null {
    return sessionStorage.getItem(TOKEN_KEY);
  }

  static setToken(token: string): void {
    sessionStorage.setItem(TOKEN_KEY, token);
  }

  static clearToken(): void {
    sessionStorage.removeItem(TOKEN_KEY);
  }

  static isAuthenticated(): boolean {
    const token = this.getToken();
    if (!token) return false;

    // Decode the JWT payload (no verification — server handles that)
    try {
      const [, payloadB64] = token.split('.');
      if (!payloadB64) return false;
      const payload = JSON.parse(atob(payloadB64)) as { exp?: number };
      if (payload.exp === undefined) return false;
      return Date.now() / 1000 < payload.exp;
    } catch {
      return false;
    }
  }

  /**
   * Thin fetch wrapper that intercepts 401 responses globally.
   * Views should prefer this over bare fetch() for authenticated requests.
   * On 401: clears the token and redirects to /login so users are never
   * stuck on a blank error banner.
   */
  static async apiFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    const authHeader: Record<string, string> = {
      Authorization: `Bearer ${this.getToken() ?? ''}`,
    };
    const existingHeaders = (init?.headers ?? {}) as Record<string, string>;
    const mergedHeaders: HeadersInit = {
      'Content-Type': 'application/json',
      ...existingHeaders,
      ...authHeader,
    };
    const res = await fetch(input, { ...init, headers: mergedHeaders });
    if (res.status === 401) {
      this.clearToken();
      // Lazy import to avoid circular dependency
      const { Router } = await import('@/core/Router');
      const { Store }  = await import('@/core/Store');
      Store.setUser(null);
      Router.navigate('/login');
      // Throw so the entire call chain aborts — callers must not render
      // an error banner while a redirect is already in progress.
      throw new AuthRedirectError();
    }
    return res;
  }

  /** Exchange username + password for a JWT from the bridge server */
  static async login(username: string, password: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      if (res.ok) {
        const { token } = await res.json() as { token: string };
        this.setToken(token);
        return { success: true };
      }

      const { error } = await res.json() as { error?: string };
      return { success: false, error: error ?? 'Login failed' };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  static logout(): void {
    this.clearToken();
  }
}
