import type { IpcRenderer, IpcRendererEvent } from 'electron';
import type {
  ContextEvidenceCardResponse,
  ContextEvidenceCompareRequest,
  ContextEvidenceCompareResponse,
  ContextEvidenceGetCardRequest,
  ContextEvidenceGetMetricsRequest,
  ContextEvidenceListRequest,
  ContextEvidenceReadRequest,
  ContextEvidenceRendererMetrics,
  ContextEvidenceSearchMatch,
  ContextEvidenceSearchRequest,
  ContextEvidenceStateChanged,
  ContextEvidenceVerifyRequest,
  ContextEvidenceVerifyResponse,
  EvidenceRecord,
  EvidenceRetrievalResponse,
} from '@contracts/types/context-evidence';
import type { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createContextEvidenceDomain(
  ipcRenderer: IpcRenderer,
  ch: typeof IPC_CHANNELS,
) {
  return {
    contextEvidenceList: (
      request: ContextEvidenceListRequest,
    ): Promise<IpcResponse<EvidenceRecord[]>> =>
      ipcRenderer.invoke(ch.CONTEXT_EVIDENCE_LIST, request),

    contextEvidenceGetCard: (
      request: ContextEvidenceGetCardRequest,
    ): Promise<IpcResponse<ContextEvidenceCardResponse>> =>
      ipcRenderer.invoke(ch.CONTEXT_EVIDENCE_GET_CARD, request),

    contextEvidenceSearch: (
      request: ContextEvidenceSearchRequest,
    ): Promise<IpcResponse<ContextEvidenceSearchMatch[]>> =>
      ipcRenderer.invoke(ch.CONTEXT_EVIDENCE_SEARCH, request),

    contextEvidenceRead: (
      request: ContextEvidenceReadRequest,
    ): Promise<IpcResponse<EvidenceRetrievalResponse>> =>
      ipcRenderer.invoke(ch.CONTEXT_EVIDENCE_READ, request),

    contextEvidenceCompare: (
      request: ContextEvidenceCompareRequest,
    ): Promise<IpcResponse<ContextEvidenceCompareResponse>> =>
      ipcRenderer.invoke(ch.CONTEXT_EVIDENCE_COMPARE, request),

    contextEvidenceVerify: (
      request: ContextEvidenceVerifyRequest,
    ): Promise<IpcResponse<ContextEvidenceVerifyResponse>> =>
      ipcRenderer.invoke(ch.CONTEXT_EVIDENCE_VERIFY, request),

    contextEvidenceGetMetrics: (
      request: ContextEvidenceGetMetricsRequest,
    ): Promise<IpcResponse<ContextEvidenceRendererMetrics>> =>
      ipcRenderer.invoke(ch.CONTEXT_EVIDENCE_GET_METRICS, request),

    onContextEvidenceStateChanged: (
      callback: (update: ContextEvidenceStateChanged) => void,
    ): (() => void) => {
      const listener = (_event: IpcRendererEvent, update: ContextEvidenceStateChanged): void => {
        callback(update);
      };
      ipcRenderer.on(ch.CONTEXT_EVIDENCE_STATE_CHANGED, listener);
      return () => ipcRenderer.removeListener(ch.CONTEXT_EVIDENCE_STATE_CHANGED, listener);
    },
  };
}
