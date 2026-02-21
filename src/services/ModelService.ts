/**
 * ModelService — Model lifecycle: list, pre-flight check, load, eject.
 *
 * Spec reference: docs/LMStudioDaemon.md section 5
 * VRAM reference table kept here as constants — single source of truth.
 */

import type { IModel, IModelLoadConfig, IVRAMEstimate } from '@/types';
import type { DaemonService } from './DaemonService';

/**
 * Q4_K_M VRAM estimates — from LMStudioDaemon.md section 5.
 * Kept intentionally for ForgeView memory guidance and OOM prevention UX.
 */
export const VRAM_GUIDE: readonly { params: string; minGb: number; maxGb: number; hardware: string }[] = [
  { params: '3B',      minGb: 3,  maxGb: 4,  hardware: 'Entry (GTX 1650, RTX 3050)' },
  { params: '7B–8B',   minGb: 6,  maxGb: 8,  hardware: 'Mid-range (RTX 4060, M1 16GB)' },
  { params: '13B–14B', minGb: 10, maxGb: 12, hardware: 'Performance (RTX 3060 12GB, RTX 4070)' },
  { params: '30B–34B', minGb: 20, maxGb: 24, hardware: 'High-end (RTX 3090, RTX 4090)' },
  { params: '70B+',    minGb: 40, maxGb: 999, hardware: 'Workstation (RTX 6000, M4 Ultra)' },
] as const;

export class ModelService {
  constructor(private readonly daemon: DaemonService) {}

  async listModels(): Promise<IModel[]> {
    const result = await this.daemon.listModels();
    if (!result.success || !result.data) return [];
    // Map flat LMSModelRecord → IModel (both keyed by id / state)
    return (result.data.data ?? []) as unknown as IModel[];
  }

  /** Run --estimate-only before committing to a load — prevents OOM crashes */
  async preflightCheck(config: IModelLoadConfig): Promise<IVRAMEstimate | null> {
    const result = await this.daemon.estimateVram(config);
    return result.success && result.data ? result.data : null;
  }

  async loadModel(config: IModelLoadConfig): Promise<boolean> {
    const result = await this.daemon.loadModel(config);
    return result.success;
  }

  async ejectModel(modelId: string): Promise<boolean> {
    const result = await this.daemon.ejectModel(modelId);
    return result.success;
  }
}
