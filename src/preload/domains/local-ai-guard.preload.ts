import type { IpcRenderer, IpcRendererEvent } from 'electron';
import type {
  LocalAiDiagnosticReport,
  LocalAiDiscoveredEndpoint,
  LocalAiEffectivenessSummary,
  LocalAiFallbackRequest,
  LocalAiFallbackResolveRequest,
  LocalAiGuardSnapshot,
  LocalAiIncident,
  LocalAiIncidentAcknowledgeRequest,
  LocalAiProbeResult,
  LocalAiRecheckRequest,
  LocalAiRepairRequest,
  LocalAiRepairResult,
  LocalAiSummaryRequest,
  LocalAiTarget,
  LocalAiTargetCreateRequest,
  LocalAiTargetLifecycleRequest,
  LocalAiTargetRequest,
  LocalAiTargetStatus,
  LocalAiTargetUpdateRequest,
  LocalAiValidateRequest,
} from '../../shared/types/local-ai-guard.types';
import type { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createLocalAiGuardDomain(
  ipcRenderer: IpcRenderer,
  ch: typeof IPC_CHANNELS,
) {
  return {
    localAiGuardGetSnapshot: (): Promise<IpcResponse<LocalAiGuardSnapshot>> =>
      ipcRenderer.invoke(ch.LOCAL_AI_GUARD_GET_SNAPSHOT),
    localAiGuardCreateTarget: (
      request: LocalAiTargetCreateRequest,
    ): Promise<IpcResponse<LocalAiTarget>> =>
      ipcRenderer.invoke(ch.LOCAL_AI_GUARD_TARGET_CREATE, request),
    localAiGuardUpdateTarget: (
      request: LocalAiTargetUpdateRequest,
    ): Promise<IpcResponse<LocalAiTarget>> =>
      ipcRenderer.invoke(ch.LOCAL_AI_GUARD_TARGET_UPDATE, request),
    localAiGuardSetTargetLifecycle: (
      request: LocalAiTargetLifecycleRequest,
    ): Promise<IpcResponse<LocalAiTarget>> =>
      ipcRenderer.invoke(ch.LOCAL_AI_GUARD_TARGET_SET_LIFECYCLE, request),
    localAiGuardDiscover: (): Promise<IpcResponse<LocalAiDiscoveredEndpoint[]>> =>
      ipcRenderer.invoke(ch.LOCAL_AI_GUARD_DISCOVER),
    localAiGuardValidate: (
      request: LocalAiValidateRequest,
    ): Promise<IpcResponse<LocalAiProbeResult[]>> =>
      ipcRenderer.invoke(ch.LOCAL_AI_GUARD_VALIDATE, request),
    localAiGuardRecheck: (
      request: LocalAiRecheckRequest,
    ): Promise<IpcResponse<LocalAiTargetStatus>> =>
      ipcRenderer.invoke(ch.LOCAL_AI_GUARD_RECHECK, request),
    localAiGuardAcknowledgeIncident: (
      request: LocalAiIncidentAcknowledgeRequest,
    ): Promise<IpcResponse<LocalAiIncident>> =>
      ipcRenderer.invoke(ch.LOCAL_AI_GUARD_INCIDENT_ACKNOWLEDGE, request),
    localAiGuardDiagnose: (
      request: LocalAiTargetRequest,
    ): Promise<IpcResponse<LocalAiDiagnosticReport>> =>
      ipcRenderer.invoke(ch.LOCAL_AI_GUARD_DIAGNOSE, request),
    localAiGuardRepair: (
      request: LocalAiRepairRequest,
    ): Promise<IpcResponse<LocalAiRepairResult>> =>
      ipcRenderer.invoke(ch.LOCAL_AI_GUARD_REPAIR, request),
    localAiGuardGetSummary: (
      request: LocalAiSummaryRequest,
    ): Promise<IpcResponse<LocalAiEffectivenessSummary>> =>
      ipcRenderer.invoke(ch.LOCAL_AI_GUARD_SUMMARY_QUERY, request),
    localAiGuardListPendingFallbacks: (): Promise<IpcResponse<LocalAiFallbackRequest[]>> =>
      ipcRenderer.invoke(ch.LOCAL_AI_GUARD_PENDING_FALLBACK_LIST),
    localAiGuardResolveFallback: (
      request: LocalAiFallbackResolveRequest,
    ): Promise<IpcResponse<LocalAiFallbackRequest>> =>
      ipcRenderer.invoke(ch.LOCAL_AI_GUARD_PENDING_FALLBACK_RESOLVE, request),
    onLocalAiGuardStatusDelta: (
      callback: (snapshot: LocalAiGuardSnapshot) => void,
    ): (() => void) => {
      const listener = (_event: IpcRendererEvent, snapshot: LocalAiGuardSnapshot): void => {
        callback(snapshot);
      };
      ipcRenderer.on(ch.LOCAL_AI_GUARD_STATUS_DELTA, listener);
      return () => ipcRenderer.removeListener(ch.LOCAL_AI_GUARD_STATUS_DELTA, listener);
    },
  };
}
