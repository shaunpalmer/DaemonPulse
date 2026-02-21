/**
 * DaemonController — Thin coordinator for daemon lifecycle actions.
 *
 * Controllers:
 *  1. Receive intent (from views via EventBus or direct call)
 *  2. Call the appropriate service(s)
 *  3. Emit result events for views to react to
 *
 * They never touch the DOM. They never hold business logic.
 */

import { EventBus } from '@/core/EventBus';
import { Store }    from '@/core/Store';
import type { DaemonService }    from '@/services/DaemonService';
import type { HeartbeatService } from '@/services/HeartbeatService';

export class DaemonController {
  constructor(
    private readonly daemon: DaemonService,
    private readonly heartbeat: HeartbeatService,
  ) {}

  async startDaemon(): Promise<void> {
    this.heartbeat.userActionDetected();
    const result = await this.daemon.daemonUp();
    if (result.success) {
      EventBus.emit({ type: 'DAEMON_STATE_CHANGED', payload: { nodeId: this.activeNodeId(), state: 'running' } });
    }
  }

  async stopDaemon(): Promise<void> {
    this.heartbeat.userActionDetected();
    const result = await this.daemon.daemonDown();
    if (result.success) {
      EventBus.emit({ type: 'DAEMON_STATE_CHANGED', payload: { nodeId: this.activeNodeId(), state: 'stopped' } });
    }
  }

  async startServer(): Promise<void> {
    this.heartbeat.userActionDetected();
    await this.daemon.serverStart();
  }

  async stopServer(): Promise<void> {
    this.heartbeat.userActionDetected();
    await this.daemon.serverStop();
  }

  /**
   * probe — fire-and-forget liveness check.
   * Called on module mount to show real daemon state immediately.
   */
  async probe(): Promise<void> {
    const result = await this.daemon.ping();
    const state: import('@/types').DaemonState = result.success ? 'running' : 'stopped';
    EventBus.emit({ type: 'DAEMON_STATE_CHANGED', payload: { nodeId: this.activeNodeId(), state } });
  }

  async refreshHardware(): Promise<void> {
    this.heartbeat.userActionDetected();
    const result = await this.daemon.runtimeSurvey();
    if (result.success && result.data) {
      const nodeId = this.activeNodeId();
      const node = Store.getState().nodes.get(nodeId);
      if (node) {
        Store.upsertNode({ ...node, hardware: result.data });
        EventBus.emit({ type: 'VRAM_UPDATED', payload: { nodeId, gpus: result.data.gpus } });
      }
    }
  }

  private activeNodeId(): string {
    return Store.getState().activeNodeId ?? 'local';
  }
}
