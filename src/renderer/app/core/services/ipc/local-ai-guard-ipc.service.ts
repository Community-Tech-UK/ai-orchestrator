import { Injectable, inject } from '@angular/core';
import type {
  LocalAiDiagnosticReport,
  LocalAiDiscoveredEndpoint,
  LocalAiEffectivenessSummary,
  LocalAiFallbackRequest,
  LocalAiFallbackResolution,
  LocalAiGuardSnapshot,
  LocalAiIncident,
  LocalAiProbeResult,
  LocalAiRepairAction,
  LocalAiRepairResult,
  LocalAiTarget,
  LocalAiTargetConfig,
  LocalAiTargetLifecycle,
  LocalAiTargetLifecycleOptions,
  LocalAiTargetPatch,
  LocalAiTargetStatus,
} from '../../../../../shared/types/local-ai-guard.types';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class LocalAiGuardIpcService {
  private readonly base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  getSnapshot(): Promise<IpcResponse<LocalAiGuardSnapshot>> {
    return this.call((api) => api.localAiGuardGetSnapshot());
  }

  createTarget(config: LocalAiTargetConfig): Promise<IpcResponse<LocalAiTarget>> {
    return this.call((api) => api.localAiGuardCreateTarget({ config }));
  }

  updateTarget(
    targetId: string,
    patch: LocalAiTargetPatch,
  ): Promise<IpcResponse<LocalAiTarget>> {
    return this.call((api) => api.localAiGuardUpdateTarget({ targetId, patch }));
  }

  setTargetLifecycle(
    targetId: string,
    lifecycle: Extract<LocalAiTargetLifecycle, 'enrolled' | 'paused' | 'retired'>,
    options: LocalAiTargetLifecycleOptions = {},
  ): Promise<IpcResponse<LocalAiTarget>> {
    return this.call((api) => api.localAiGuardSetTargetLifecycle({
      targetId,
      lifecycle,
      ...(options.pausedUntil === undefined ? {} : { pausedUntil: options.pausedUntil }),
    }));
  }

  discover(): Promise<IpcResponse<LocalAiDiscoveredEndpoint[]>> {
    return this.call((api) => api.localAiGuardDiscover());
  }

  validate(config: LocalAiTargetConfig): Promise<IpcResponse<LocalAiProbeResult[]>> {
    return this.call((api) => api.localAiGuardValidate({ config }));
  }

  recheck(
    targetId: string,
    kind: 'lightweight' | 'functional',
  ): Promise<IpcResponse<LocalAiTargetStatus>> {
    return this.call((api) => api.localAiGuardRecheck({ targetId, kind }));
  }

  acknowledgeIncident(incidentId: string): Promise<IpcResponse<LocalAiIncident>> {
    return this.call((api) => api.localAiGuardAcknowledgeIncident({ incidentId }));
  }

  diagnose(targetId: string): Promise<IpcResponse<LocalAiDiagnosticReport>> {
    return this.call((api) => api.localAiGuardDiagnose({ targetId }));
  }

  repair(
    targetId: string,
    action: LocalAiRepairAction,
    mode: 'guided' | 'automatic',
  ): Promise<IpcResponse<LocalAiRepairResult>> {
    return this.call((api) => api.localAiGuardRepair({ targetId, action, mode }));
  }

  getSummary(
    window: LocalAiEffectivenessSummary['window'],
  ): Promise<IpcResponse<LocalAiEffectivenessSummary>> {
    return this.call((api) => api.localAiGuardGetSummary({ window }));
  }

  listPendingFallbacks(): Promise<IpcResponse<LocalAiFallbackRequest[]>> {
    return this.call((api) => api.localAiGuardListPendingFallbacks());
  }

  resolveFallback(
    requestId: string,
    resolution: LocalAiFallbackResolution,
  ): Promise<IpcResponse<LocalAiFallbackRequest>> {
    return this.call((api) => api.localAiGuardResolveFallback({ requestId, resolution }));
  }

  onStatusDelta(callback: (snapshot: LocalAiGuardSnapshot) => void): () => void {
    if (!this.api) return () => undefined;
    return this.api.onLocalAiGuardStatusDelta((snapshot) => {
      this.base.getNgZone().run(() => callback(snapshot));
    });
  }

  private call<T>(
    operation: (api: NonNullable<ReturnType<ElectronIpcService['getApi']>>) =>
      Promise<IpcResponse<T>>,
  ): Promise<IpcResponse<T>> {
    if (!this.api) {
      return Promise.resolve({ success: false, error: { message: 'Not in Electron' } });
    }
    return operation(this.api);
  }
}
