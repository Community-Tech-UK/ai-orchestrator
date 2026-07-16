import { computed, Injectable, OnDestroy, signal } from '@angular/core';
import type {
  RlmMaintenancePreview,
  RlmMaintenanceProgress,
  RlmMaintenanceResult,
  RlmStorageHealth,
} from '../../../../shared/types/rlm-maintenance.types';
import type { IpcResponse } from '../../../../preload/domains/types';

interface RlmStorageApi {
  rlmStorageGetHealth(): Promise<IpcResponse<RlmStorageHealth>>;
  rlmStoragePreviewMaintenance(loopRunId?: string): Promise<IpcResponse<RlmMaintenancePreview>>;
  rlmStorageRunMaintenance(loopRunId?: string): Promise<IpcResponse<RlmMaintenanceResult>>;
  rlmStorageGetMaintenanceStatus(): Promise<IpcResponse<RlmMaintenanceResult | null>>;
  onRlmStorageMaintenanceProgress(callback: (progress: RlmMaintenanceProgress) => void): () => void;
}

@Injectable({ providedIn: 'root' })
export class RlmStorageMaintenanceStore implements OnDestroy {
  readonly health = signal<RlmStorageHealth | null>(null);
  readonly preview = signal<RlmMaintenancePreview | null>(null);
  readonly progress = signal<RlmMaintenanceProgress | null>(null);
  readonly result = signal<RlmMaintenanceResult | null>(null);
  readonly busy = signal(false);
  readonly modalOpen = signal(false);
  readonly dismissed = signal(false);
  readonly error = signal<string | null>(null);
  readonly visible = computed(() => {
    const health = this.health();
    if (health === null || health.level === 'healthy') {
      return false;
    }
    // Critical storage health (hard pause threshold) can never be dismissed;
    // warning-level dismissal only hides the warning tier.
    return health.level === 'critical' || !this.dismissed();
  });

  private readonly api: RlmStorageApi | null;
  private readonly unsubscribe: (() => void) | null;
  /**
   * The loop that initiated the current preview/run, remembered so the modal can
   * resume it even when the modal is rendered by a host (the app shell) that has
   * no selected instance and therefore no `loopRunId` of its own.
   */
  private pendingLoopRunId: string | undefined;

  constructor() {
    this.api = (window as unknown as { electronAPI?: Partial<RlmStorageApi> }).electronAPI as RlmStorageApi | null ?? null;
    this.unsubscribe = this.api?.onRlmStorageMaintenanceProgress
      ? this.api.onRlmStorageMaintenanceProgress((progress) => {
        this.progress.set(progress);
        if (progress.stage === 'complete' || progress.stage === 'failed') {
          void this.restoreStatus();
          void this.refreshHealth();
        }
      })
      : null;
  }

  destroy(): void {
    this.unsubscribe?.();
  }

  ngOnDestroy(): void {
    this.destroy();
  }

  dismiss(): void {
    this.dismissed.set(true);
    this.modalOpen.set(false);
  }

  async refreshHealth(): Promise<void> {
    if (!this.api) return;
    try {
      const response = await this.api.rlmStorageGetHealth();
      if (response.success && response.data) {
        this.health.set(response.data);
        this.error.set(null);
        return;
      }
      this.error.set(response.error?.message ?? 'Unable to measure RLM storage');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  async openPreview(loopRunId?: string): Promise<void> {
    if (!this.api || this.busy()) return;
    this.pendingLoopRunId = loopRunId;
    this.busy.set(true);
    this.error.set(null);
    try {
      const response = await this.api.rlmStoragePreviewMaintenance(loopRunId);
      if (!response.success || !response.data) {
        this.error.set(response.error?.message ?? 'Unable to preview maintenance');
        return;
      }
      this.preview.set(response.data);
      this.result.set(null);
      this.modalOpen.set(true);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }

  closePreview(): void {
    if (this.busy()) return;
    this.modalOpen.set(false);
  }

  async run(loopRunId?: string): Promise<void> {
    if (!this.api || this.busy() || !this.preview()?.canRun) return;
    // Fall back to the loop captured at preview time so a modal rendered outside
    // the selected-instance path (the app shell) still resumes the right loop.
    const targetLoopRunId = loopRunId ?? this.pendingLoopRunId;
    this.busy.set(true);
    this.error.set(null);
    this.result.set(null);
    try {
      const response = await this.api.rlmStorageRunMaintenance(targetLoopRunId);
      if (!response.success || !response.data) {
        this.error.set(response.error?.message ?? 'RLM maintenance failed');
        this.progress.set(null);
        return;
      }
      this.result.set(response.data);
      this.progress.set(null);
      await this.refreshHealth();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
      this.progress.set(null);
    } finally {
      this.busy.set(false);
    }
  }

  async restoreStatus(): Promise<void> {
    if (!this.api) return;
    try {
      const response = await this.api.rlmStorageGetMaintenanceStatus();
      if (response.success && response.data) {
        if (response.data.status === 'running') {
          this.progress.set({
            operationId: response.data.operationId,
            stage: response.data.stage,
            message: 'RLM storage maintenance is in progress',
            startedAt: response.data.startedAt,
            updatedAt: Date.now(),
          });
          this.busy.set(true);
          this.modalOpen.set(true);
          return;
        }
        this.result.set(response.data);
        this.progress.set(null);
        this.busy.set(false);
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }
}
