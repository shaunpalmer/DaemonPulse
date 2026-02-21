/**
 * AuthService — Client-side token storage and validation.
 *
 * Stores the JWT with persistence across tabs/reloads:
 *   1) sessionStorage (fast path)
 *   2) localStorage  (survives browser restarts)
 *   3) cookie fallback (same-origin, SameSite=Lax)
 *
 * Never hardcodes credentials. Actual credential verification happens server-side.
 */

const TOKEN_KEY = 'dp_auth_token';
const TOKEN_COOKIE = 'dp_auth_token';

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
    const inSession = sessionStorage.getItem(TOKEN_KEY);
    if (inSession) return inSession;

    const inLocal = localStorage.getItem(TOKEN_KEY);
    if (inLocal) {
      sessionStorage.setItem(TOKEN_KEY, inLocal);
      return inLocal;
    }

    const inCookie = this.readCookie(TOKEN_COOKIE);
    if (inCookie) {
      sessionStorage.setItem(TOKEN_KEY, inCookie);
      localStorage.setItem(TOKEN_KEY, inCookie);
      return inCookie;
    }

    return null;
  }

  static setToken(token: string): void {
    sessionStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(TOKEN_KEY, token);

    const maxAge = this.tokenMaxAgeSeconds(token);
    this.writeCookie(TOKEN_COOKIE, token, maxAge ?? 8 * 60 * 60);
  }

  static clearToken(): void {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
    this.clearCookie(TOKEN_COOKIE);
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
      const valid = Date.now() / 1000 < payload.exp;
      if (!valid) this.clearToken();
      return valid;
    } catch {
      this.clearToken();
      return false;
    }
  }

  static getPersistenceStatus(): {
    persisted: boolean;
    source: 'local' | 'cookie' | 'session' | 'none';
  } {
    const token = this.getToken();
    if (!token || !this.isAuthenticated()) {
      return { persisted: false, source: 'none' };
    }

    const inLocal = localStorage.getItem(TOKEN_KEY) === token;
    if (inLocal) return { persisted: true, source: 'local' };

    const inCookie = this.readCookie(TOKEN_COOKIE) === token;
    if (inCookie) return { persisted: true, source: 'cookie' };

    return { persisted: false, source: 'session' };
  }

  private static tokenMaxAgeSeconds(token: string): number | null {
    try {
      const [, payloadB64] = token.split('.');
      if (!payloadB64) return null;
      const payload = JSON.parse(atob(payloadB64)) as { exp?: number };
      if (payload.exp === undefined) return null;
      return Math.max(1, Math.floor(payload.exp - Date.now() / 1000));
    } catch {
      return null;
    }
  }

  private static readCookie(name: string): string | null {
    const prefix = `${name}=`;
    const entry = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith(prefix));
    if (!entry) return null;
    return decodeURIComponent(entry.slice(prefix.length));
  }

  private static writeCookie(name: string, value: string, maxAgeSeconds: number): void {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure}`;
  }

  private static clearCookie(name: string): void {
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
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
