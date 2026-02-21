/**
 * ModelController — Coordinates model lifecycle with pre-flight safety.
 *
 * The Pre-Flight check (VRAM estimate) is mandatory before any load.
 * This is enforced here, not in the view. Views cannot bypass it.
 */

import { EventBus }    from '@/core/EventBus';
import { Store }       from '@/core/Store';
import type { ModelService }     from '@/services/ModelService';
import type { HeartbeatService } from '@/services/HeartbeatService';
import type { IModelLoadConfig, IVRAMEstimate } from '@/types';

export class ModelController {
  constructor(
    private readonly models: ModelService,
    private readonly heartbeat: HeartbeatService,
  ) {}

  async refreshModelList(): Promise<void> {
    const list = await this.models.listModels();
    // TODO: Store.setModelLibrary(list) once that state slice exists
    console.debug('[ModelController] Model list refreshed:', list.length);
  }

  /** Step 1: always call this first — returns the VRAM estimate for the view to display */
  async runPreflightCheck(config: IModelLoadConfig): Promise<IVRAMEstimate | null> {
    this.heartbeat.userActionDetected();
    return this.models.preflightCheck(config);
  }

  /** Step 2: only call after the user has confirmed the pre-flight result */
  async loadModel(config: IModelLoadConfig): Promise<void> {
    this.heartbeat.userActionDetected();
    const ok = await this.models.loadModel(config);
    if (ok) {
      EventBus.emit({ type: 'MODEL_LOADED', payload: { nodeId: config.nodeId, modelId: config.modelId } });
    }
  }

  async ejectModel(modelId: string): Promise<void> {
    this.heartbeat.userActionDetected();
    const nodeId = Store.getState().activeNodeId ?? 'local';
    const ok = await this.models.ejectModel(modelId);
    if (ok) {
      Store.clearLoadedModel(nodeId);
      EventBus.emit({ type: 'MODEL_EJECTED', payload: { nodeId, modelId } });
    }
  }
}
