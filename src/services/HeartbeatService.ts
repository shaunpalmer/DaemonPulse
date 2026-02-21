/**
 * HeartbeatService — Daemon health monitoring via proxy SSE health stream.
 *
 * The proxy owns the poll cycle (GET /api/v0/models every 15 s server-side).
 * The client subscribes to the resulting SSE stream and re-emits EventBus events.
 *
 * Scout / Active / Reversion pattern is preserved at the *reconnect* level:
 *   SCOUTING  — SSE connected, receiving server-driven 15 s pulses (idle state).
 *   ACTIVE    — user action detected; fires POST /health/probe for immediate reading.
 *   REVERSION — returns to SCOUTING 15 s after the last user action.
 *
 * Architecture note: moving the poll to the server reduces client network overhead
 * and ensures the daemon is probed from the bridge host (useful for remote targets).
 */

import { AuthService } from './AuthService';
import { EventBus }    from '@/core/EventBus';
import type { DaemonService } from './DaemonService';

type HeartbeatMode = 'IDLE' | 'SCOUTING' | 'ACTIVE';
type DaemonState   = 'running' | 'stopped' | 'stalled';

const REVERSION_DELAY_MS = 15_000;
const RECONNECT_DELAY_MS  = 5_000;

interface HealthEvent {
  state:     DaemonState;
  latencyMs: number;
}

export class HeartbeatService {
  private mode:           HeartbeatMode = 'IDLE';
  private abortCtrl:      AbortController | null = null;
  private reversionTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * DaemonService is accepted for API compatibility with existing callers
   * (DaemonController, ModelController) but is no longer used for polling.
   */
  constructor(
    private readonly nodeId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private readonly _daemon: DaemonService,
  ) {}

  start(): void {
    if (this.mode !== 'IDLE') return;
    this.mode = 'SCOUTING';   // mark before async call so guard inside connectStream passes
    void this.connectStream();
  }

  stop(): void {
    this.abortCtrl?.abort();
    this.abortCtrl = null;
    this.clearReversion();
    this.mode = 'IDLE';
  }

  /**
   * Call on any user-initiated action (model load, config change, etc.).
   * Fires an immediate one-shot probe without waiting for the next 15 s pulse.
   */
  userActionDetected(): void {
    this.clearReversion();
    this.mode = 'ACTIVE';
    void this.probe();
    this.reversionTimer = setTimeout(() => {
      this.mode = 'SCOUTING';
    }, REVERSION_DELAY_MS);
  }

  getMode(): HeartbeatMode {
    return this.mode;
  }

  // ---------------------------------------------------------------------------
  // SSE subscriber
  // ---------------------------------------------------------------------------

  private async connectStream(): Promise<void> {
    if (this.mode === 'IDLE') return;   // stop() was called concurrently
    this.abortCtrl?.abort();
    this.abortCtrl = new AbortController();
    this.mode      = 'SCOUTING';

    try {
      const res = await AuthService.apiFetch('/api/proxy/health/stream', {
        signal: this.abortCtrl.signal,
      });

      if (!res.ok || !res.body) {
        this.scheduleReconnect();
        return;
      }

      const reader = res.body.getReader();
      const dec    = new TextDecoder();
      let   buf    = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const raw of lines) {
          const trimmed = raw.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload) continue;
          try {
            const evt = JSON.parse(payload) as HealthEvent;
            this.dispatch(evt.state, evt.latencyMs);
          } catch { /* malformed event — skip */ }
        }
      }
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'AbortError') return;
      this.dispatch('stopped', 0);
    }

    this.scheduleReconnect();
  }

  // ---------------------------------------------------------------------------
  // One-shot immediate probe (POST — returns JSON directly, not SSE)
  // ---------------------------------------------------------------------------

  private async probe(): Promise<void> {
    const start = performance.now();
    try {
      const res = await AuthService.apiFetch('/api/proxy/health/probe', { method: 'POST' });
      const latencyMs = performance.now() - start;
      if (res.ok) {
        const evt = await res.json() as HealthEvent;
        this.dispatch(evt.state, evt.latencyMs);
      } else {
        this.dispatch('stopped', latencyMs);
      }
    } catch {
      this.dispatch('stopped', performance.now() - start);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private dispatch(state: DaemonState, latencyMs: number): void {
    EventBus.emit({ type: 'DAEMON_STATE_CHANGED', payload: { nodeId: this.nodeId, state } });
    EventBus.emit({ type: 'HEARTBEAT_TICK',        payload: { nodeId: this.nodeId, latencyMs } });
  }

  private scheduleReconnect(): void {
    if (this.mode === 'IDLE') return;
    setTimeout(() => { void this.connectStream(); }, RECONNECT_DELAY_MS);
  }

  private clearReversion(): void {
    if (this.reversionTimer !== null) {
      clearTimeout(this.reversionTimer);
      this.reversionTimer = null;
    }
  }
}
