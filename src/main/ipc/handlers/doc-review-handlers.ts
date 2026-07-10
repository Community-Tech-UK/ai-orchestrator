/**
 * Doc-review IPC handlers.
 *
 * Surfaces the DocReviewService to the renderer's doc-review pane: list/get pending
 * reviews, read the validated artifact HTML, submit James's decisions, dismiss, and open
 * the artifact in the external browser. Artifact bytes only leave the main process after
 * the stored path is re-validated inside `.aio-review/`.
 */

import { ipcMain, IpcMainInvokeEvent, shell } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  DocReviewDismissPayloadSchema,
  DocReviewGetPayloadSchema,
  DocReviewListPayloadSchema,
  DocReviewOpenExternalPayloadSchema,
  DocReviewReadArtifactPayloadSchema,
  DocReviewSubmitDecisionPayloadSchema,
} from '@contracts/schemas/doc-review';
import {
  DOC_REVIEW_CHANGED_EVENT,
  getDocReviewService,
} from '../../doc-review/doc-review-service';
import type { WindowManager } from '../../window-manager';

function fail(code: string, error: unknown): IpcResponse {
  return {
    success: false,
    error: { code, message: (error as Error).message, timestamp: Date.now() },
  };
}

export function registerDocReviewHandlers(deps: { windowManager: WindowManager }): void {
  const service = getDocReviewService();

  // Forward session-change events to the renderer.
  service.on(DOC_REVIEW_CHANGED_EVENT, (event: unknown) => {
    deps.windowManager.sendToRenderer(IPC_CHANNELS.DOC_REVIEW_CHANGED, event);
  });

  ipcMain.handle(
    IPC_CHANNELS.DOC_REVIEW_LIST,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(DocReviewListPayloadSchema, payload, 'DOC_REVIEW_LIST');
        return { success: true, data: service.listSessions(validated.status) };
      } catch (error) {
        return fail('DOC_REVIEW_LIST_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.DOC_REVIEW_GET,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(DocReviewGetPayloadSchema, payload, 'DOC_REVIEW_GET');
        const session = service.getSession(validated.reviewId);
        if (!session) return fail('DOC_REVIEW_GET_FAILED', new Error('Unknown review'));
        return { success: true, data: session };
      } catch (error) {
        return fail('DOC_REVIEW_GET_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.DOC_REVIEW_READ_ARTIFACT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          DocReviewReadArtifactPayloadSchema,
          payload,
          'DOC_REVIEW_READ_ARTIFACT',
        );
        const html = await service.readArtifact(validated.reviewId);
        return { success: true, data: { html } };
      } catch (error) {
        return fail('DOC_REVIEW_READ_ARTIFACT_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.DOC_REVIEW_SUBMIT_DECISION,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          DocReviewSubmitDecisionPayloadSchema,
          payload,
          'DOC_REVIEW_SUBMIT_DECISION',
        );
        const session = await service.submitDecision(validated.reviewId, {
          overall: validated.overall,
          decisions: validated.decisions,
          generalComment: validated.generalComment,
        });
        return { success: true, data: session };
      } catch (error) {
        return fail('DOC_REVIEW_SUBMIT_DECISION_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.DOC_REVIEW_DISMISS,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          DocReviewDismissPayloadSchema,
          payload,
          'DOC_REVIEW_DISMISS',
        );
        service.dismiss(validated.reviewId);
        return { success: true, data: { reviewId: validated.reviewId } };
      } catch (error) {
        return fail('DOC_REVIEW_DISMISS_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.DOC_REVIEW_OPEN_EXTERNAL,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          DocReviewOpenExternalPayloadSchema,
          payload,
          'DOC_REVIEW_OPEN_EXTERNAL',
        );
        const resolvedPath = service.resolveArtifactFile(validated.reviewId);
        const openError = await shell.openPath(resolvedPath);
        if (openError) throw new Error(openError);
        return { success: true, data: { reviewId: validated.reviewId } };
      } catch (error) {
        return fail('DOC_REVIEW_OPEN_EXTERNAL_FAILED', error);
      }
    },
  );
}
