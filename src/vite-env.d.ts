/// <reference types="vite/client" />

/**
 * Vite client-side environment variable declarations.
 * Variables must be prefixed with VITE_ to be embedded in the client bundle.
 * Set them in a .env file at the project root (never commit secrets here).
 */
interface ImportMetaEnv {
  /**
   * Base URL of the DaemonPulse bridge server.
   * Leave empty (default) to use the same origin as the client.
   * Set to a full URL (e.g. https://bridge.example.com) for remote deployments
   * where the bridge runs on a different host from the static assets.
   *
   * Example in .env:
   *   VITE_DAEMON_BASE_URL=https://bridge.example.com
   */
  readonly VITE_DAEMON_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
