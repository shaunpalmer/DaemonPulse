/**
 * HeartbeatService — Synergistic Scout/Active/Reversion pattern.
 *
 * Scout  (Low Road):  Lightweight pulse every ~20s when idle.
 * Active (High Road): Kills Scout, dispatches immediately on user action.
 * Reversion:          Returns to Scout after 15s of inactivity.
 *
 * Spec reference: docs/Architecture & Design System.md section 2
 */

import { EventBus } from '@/core/EventBus';
import type { DaemonService } from './DaemonService';

type HeartbeatMode = 'IDLE' | 'ACTIVE' | 'SCOUTING';

const SCOUT_INTERVAL_MS   = 20_000;
const REVERSION_DELAY_MS  = 15_000;

export class HeartbeatService {
  private mode: HeartbeatMode = 'IDLE';
  private scoutTimer: ReturnType<typeof setInterval> | null = null;
  private reversionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly nodeId: string,
    private readonly daemon: DaemonService,
  ) {}

  start(): void {
    this.enterScoutMode();
  }

  stop(): void {
    this.clearScout();
    this.clearReversion();
    this.mode = 'IDLE';
  }

  /** Call this on any user-initiated action (model load, config change, etc.) */
  userActionDetected(): void {
    this.enterActiveMode();
  }

  private async pulse(): Promise<void> {
    const start = performance.now();
    const result = await this.daemon.getDaemonState();
    const latencyMs = performance.now() - start;

    // getDaemonState() now uses /v1/models as liveness check (LM Studio 0.4.2+)
    // success = server is up and running; failure = stopped or unreachable
    const state = result.success ? 'running' : 'stopped';
    EventBus.emit({ type: 'DAEMON_STATE_CHANGED', payload: { nodeId: this.nodeId, state } });
    EventBus.emit({ type: 'HEARTBEAT_TICK', payload: { nodeId: this.nodeId, latencyMs } });
  }

  private enterScoutMode(): void {
    this.clearScout();
    this.clearReversion();
    this.mode = 'SCOUTING';
    this.scoutTimer = setInterval(() => void this.pulse(), SCOUT_INTERVAL_MS);
    void this.pulse(); // Immediate first pulse
  }

  private enterActiveMode(): void {
    this.clearScout();      // Kill the Scout — it had its chance
    this.clearReversion();
    this.mode = 'ACTIVE';

    void this.pulse();      // Immediate high-priority pulse

    // Set reversion timer — drift back to Scout after inactivity
    this.reversionTimer = setTimeout(() => this.enterScoutMode(), REVERSION_DELAY_MS);
  }

  private clearScout(): void {
    if (this.scoutTimer !== null) {
      clearInterval(this.scoutTimer);
      this.scoutTimer = null;
    }
  }

  private clearReversion(): void {
    if (this.reversionTimer !== null) {
      clearTimeout(this.reversionTimer);
      this.reversionTimer = null;
    }
  }

  getMode(): HeartbeatMode {
    return this.mode;
  }
}
