import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';
import type {
  DocReviewItemDecision,
  DocReviewOverall,
  DocReviewStatus,
} from '@contracts/schemas/doc-review';

export function createDocReviewDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    docReviewList: (payload?: { status?: DocReviewStatus }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.DOC_REVIEW_LIST, payload ?? {}),

    docReviewGet: (payload: { reviewId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.DOC_REVIEW_GET, payload),

    docReviewReadArtifact: (payload: { reviewId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.DOC_REVIEW_READ_ARTIFACT, payload),

    docReviewSubmitDecision: (payload: {
      reviewId: string;
      overall: DocReviewOverall;
      decisions: DocReviewItemDecision[];
      generalComment?: string;
    }): Promise<IpcResponse> => ipcRenderer.invoke(ch.DOC_REVIEW_SUBMIT_DECISION, payload),

    docReviewDismiss: (payload: { reviewId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.DOC_REVIEW_DISMISS, payload),

    docReviewOpenExternal: (payload: { reviewId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.DOC_REVIEW_OPEN_EXTERNAL, payload),

    onDocReviewChanged: (callback: (event: unknown) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.DOC_REVIEW_CHANGED, listener);
      return () => ipcRenderer.removeListener(ch.DOC_REVIEW_CHANGED, listener);
    },
  };
}
