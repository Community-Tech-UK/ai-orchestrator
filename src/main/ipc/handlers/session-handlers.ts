/**
 * Session, Archive, and History IPC Handlers
 * Handles session management, archiving, and conversation history operations
 */

import { ipcMain, IpcMainInvokeEvent, dialog, clipboard, shell } from 'electron';
import { promises as fs } from 'fs';
import { IPC_CHANNELS } from '@contracts/channels';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  HistoryDeletePayloadSchema,
  HistoryListPayloadSchema,
  HistoryLoadPayloadSchema,
  HistoryRestorePayloadSchema,
  SessionCopyToClipboardPayloadSchema,
  SessionCreateSnapshotPayloadSchema,
  SessionExportPayloadSchema,
  SessionForkPayloadSchema,
  SessionGetStatsPayloadSchema,
  SessionImportPayloadSchema,
  SessionListResumablePayloadSchema,
  SessionListSnapshotsPayloadSchema,
  SessionRevealFilePayloadSchema,
  SessionResumePayloadSchema,
  SessionSaveToFilePayloadSchema,
  SessionShareLoadPayloadSchema,
  SessionSharePreviewPayloadSchema,
  SessionShareReplayPayloadSchema,
  SessionShareSavePayloadSchema,
  SessionHandlerEmptyPayloadSchema,
} from '@contracts/schemas/session';
import type { ExportedSession } from '../../../shared/types/instance.types';
import type { InstanceManager } from '../../instance/instance-manager';
import { getAutoTitleService } from '../../instance/auto-title-service';
import { getHistoryManager } from '../../history';
import { getSessionShareService } from '../../session/session-share-service';
import { getSessionContinuityManager } from '../../session/session-continuity';
import { SessionRevivalService } from '../../session/session-revival-service';
import { HistoryRestoreCoordinator } from '../../history/history-restore-coordinator';
import { isRemoteNodeReachable } from './remote-node-check';
import { validatedHandler } from '../validated-handler';
import { registerSessionAdmissionHandlers } from './session-admission-handlers';
import { registerSessionArchiveHandlers } from './session-archive-handlers';
import { registerSessionRecoveryHandlers } from './session-recovery-handlers';
import { registerSessionQueueHandlers } from './session-queue-handlers';

export {
  getNativeResumeSessionId,
  getMessagesForRestoreTranscript,
  selectMessagesForRestore,
} from '../../history/history-restore-helpers';

/**
 * Serializes history-restore spawns. When the user rapid-fires several
 * "restore from history" clicks, the main process would otherwise kick off
 * multiple concurrent `createInstance` + background-init + CLI spawn + poll
 * sequences. Each one runs codebase mining, CLI detection, RLM session setup,
 * instruction-prompt assembly, and a 5-15s context-usage poll, plus the spawned
 * CLI adapters start streaming in parallel — which starves the main process
 * event loop and can delay any single instance's spawn by 3+ minutes.
 *
 * Queueing restores through a single promise chain keeps heavy setup work
 * and the "has the CLI reported context?" poll strictly sequential, while
 * still allowing other IPC handlers to run in parallel.
 */
let historyRestoreChain: Promise<unknown> = Promise.resolve();

function withHistoryRestoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = historyRestoreChain.catch(() => undefined);
  const current = previous.then(() => fn());
  historyRestoreChain = current.catch(() => undefined);
  return current;
}

interface SessionHandlersDeps {
  instanceManager: InstanceManager;
  serializeInstance: (instance: unknown) => Record<string, unknown>;
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
}

/**
 * Register session, archive, and history IPC handlers
 */
export function registerSessionHandlers(deps: SessionHandlersDeps): void {
  const { instanceManager, serializeInstance } = deps;
  const rawIpcHandle = ipcMain.handle.bind(ipcMain);
  const registerTrustedIpcHandler = (
    channel: string,
    listener: Parameters<typeof ipcMain.handle>[1],
  ): void => {
    rawIpcHandle(channel, (event, ...args) => {
      const trustError = deps.ensureTrustedSender?.(event, channel);
      return trustError ?? listener(event, ...args);
    });
  };

  // ============================================
  // Session Handlers
  // ============================================

  // Fork session
  registerTrustedIpcHandler(
    IPC_CHANNELS.SESSION_FORK,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SessionForkPayloadSchema, payload, 'SESSION_FORK');
        const forkedInstance = await instanceManager.forkInstance({
          instanceId: validated.instanceId,
          atMessageIndex: validated.atMessageIndex,
          atMessageId: validated.atMessageId,
          sourceMessageId: validated.sourceMessageId,
          forkAfterMessageId: validated.forkAfterMessageId,
          displayName: validated.displayName,
          initialPrompt: validated.initialPrompt,
          attachments: validated.attachments?.map((attachment) => ({
            ...attachment,
            data: attachment.data ?? '',
          })),
          preserveRuntimeSettings: validated.preserveRuntimeSettings,
          supersedeSource: validated.supersedeSource,
        });
        return {
          success: true,
          data: serializeInstance(forkedInstance)
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SESSION_FORK_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Export session
  registerTrustedIpcHandler(
    IPC_CHANNELS.SESSION_EXPORT,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SessionExportPayloadSchema, payload, 'SESSION_EXPORT');
        if (validated.format === 'json') {
          const exported = instanceManager.exportSession(validated.instanceId);
          return {
            success: true,
            data: exported
          };
        } else {
          const markdown = instanceManager.exportSessionMarkdown(
            validated.instanceId
          );
          return {
            success: true,
            data: markdown
          };
        }
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SESSION_EXPORT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Import session
  registerTrustedIpcHandler(
    IPC_CHANNELS.SESSION_IMPORT,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SessionImportPayloadSchema, payload, 'SESSION_IMPORT');
        // Read and parse the file
        const content = await fs.readFile(validated.filePath, 'utf-8');
        const session: ExportedSession = JSON.parse(content);

        // Validate version
        if (!session.version || !session.messages) {
          return {
            success: false,
            error: {
              code: 'INVALID_SESSION_FORMAT',
              message: 'Invalid session file format',
              timestamp: Date.now()
            }
          };
        }

        const instance = await instanceManager.importSession(
          session,
          validated.workingDirectory
        );

        return {
          success: true,
          data: serializeInstance(instance)
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SESSION_IMPORT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Copy session to clipboard
  registerTrustedIpcHandler(
    IPC_CHANNELS.SESSION_COPY_TO_CLIPBOARD,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SessionCopyToClipboardPayloadSchema, payload, 'SESSION_COPY_TO_CLIPBOARD');
        let content: string;
        if (validated.format === 'json') {
          const exported = instanceManager.exportSession(validated.instanceId);
          content = JSON.stringify(exported, null, 2);
        } else {
          content = instanceManager.exportSessionMarkdown(validated.instanceId);
        }

        clipboard.writeText(content);
        return {
          success: true,
          data: { copied: true, format: validated.format }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SESSION_COPY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Save session to file
  registerTrustedIpcHandler(
    IPC_CHANNELS.SESSION_SAVE_TO_FILE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SessionSaveToFilePayloadSchema, payload, 'SESSION_SAVE_TO_FILE');
        let filePath = validated.filePath;

        // Show save dialog if no path provided
        if (!filePath) {
          const instance = instanceManager.getInstance(validated.instanceId);
          const defaultName =
            instance?.displayName?.replace(/[^a-z0-9]/gi, '_') || 'session';
          const extension = validated.format === 'json' ? 'json' : 'md';

          const result = await dialog.showSaveDialog({
            title: 'Save Session',
            defaultPath: `${defaultName}.${extension}`,
            filters: [
              validated.format === 'json'
                ? { name: 'JSON', extensions: ['json'] }
                : { name: 'Markdown', extensions: ['md'] }
            ]
          });

          if (result.canceled || !result.filePath) {
            return {
              success: false,
              error: {
                code: 'SAVE_CANCELLED',
                message: 'Save cancelled',
                timestamp: Date.now()
              }
            };
          }
          filePath = result.filePath;
        }

        // Export and write
        let content: string;
        if (validated.format === 'json') {
          const exported = instanceManager.exportSession(validated.instanceId);
          content = JSON.stringify(exported, null, 2);
        } else {
          content = instanceManager.exportSessionMarkdown(validated.instanceId);
        }

        await fs.writeFile(filePath, content, 'utf-8');

        return { success: true, data: { filePath, format: validated.format } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SESSION_SAVE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Reveal file in system file manager
  registerTrustedIpcHandler(
    IPC_CHANNELS.SESSION_REVEAL_FILE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SessionRevealFilePayloadSchema, payload, 'SESSION_REVEAL_FILE');
        shell.showItemInFolder(validated.filePath);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REVEAL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  const sessionShare = getSessionShareService();

  // Preview a redacted share bundle for an active or historical session
  registerTrustedIpcHandler(
    IPC_CHANNELS.SESSION_SHARE_PREVIEW,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          SessionSharePreviewPayloadSchema,
          payload,
          'SESSION_SHARE_PREVIEW',
        );

        const bundle = validated.instanceId
          ? await buildShareBundleForInstance(validated.instanceId)
          : await buildShareBundleForHistory(validated.entryId!);

        return {
          success: true,
          data: bundle,
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SESSION_SHARE_PREVIEW_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          }
        };
      }
    }
  );

  // Save a redacted share bundle to disk
  registerTrustedIpcHandler(
    IPC_CHANNELS.SESSION_SHARE_SAVE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          SessionShareSavePayloadSchema,
          payload,
          'SESSION_SHARE_SAVE',
        );

        const bundle = validated.instanceId
          ? await buildShareBundleForInstance(validated.instanceId)
          : await buildShareBundleForHistory(validated.entryId!);

        let filePath = validated.filePath;
        if (!filePath) {
          const safeName = bundle.source.displayName
            .replace(/[^a-z0-9]+/gi, '-')
            .replace(/^-+|-+$/g, '')
            .toLowerCase() || 'session-share';

          const result = await dialog.showSaveDialog({
            title: 'Save Redacted Session Share Bundle',
            defaultPath: `${safeName}.share.json`,
            filters: [{ name: 'JSON', extensions: ['json'] }],
          });

          if (result.canceled || !result.filePath) {
            return {
              success: false,
              error: {
                code: 'SAVE_CANCELLED',
                message: 'Save cancelled',
                timestamp: Date.now(),
              }
            };
          }

          filePath = result.filePath;
        }

        await sessionShare.saveBundle(bundle, filePath);

        return {
          success: true,
          data: {
            filePath,
            bundle,
          }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SESSION_SHARE_SAVE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          }
        };
      }
    }
  );

  // Load a saved share bundle from disk
  registerTrustedIpcHandler(
    IPC_CHANNELS.SESSION_SHARE_LOAD,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          SessionShareLoadPayloadSchema,
          payload,
          'SESSION_SHARE_LOAD',
        );
        const bundle = await sessionShare.loadBundle(validated.filePath);
        return {
          success: true,
          data: bundle,
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SESSION_SHARE_LOAD_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          }
        };
      }
    }
  );

  // Replay a share bundle as a new local instance
  registerTrustedIpcHandler(
    IPC_CHANNELS.SESSION_SHARE_REPLAY,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          SessionShareReplayPayloadSchema,
          payload,
          'SESSION_SHARE_REPLAY',
        );
        const bundle = await sessionShare.loadBundle(validated.filePath);
        const exportedSession = sessionShare.toExportedSession(
          bundle,
          validated.workingDirectory,
          validated.displayName,
        );
        const instance = await instanceManager.importSession(exportedSession, validated.workingDirectory);
        return {
          success: true,
          data: serializeInstance(instance),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SESSION_SHARE_REPLAY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          }
        };
      }
    }
  );

  registerSessionArchiveHandlers({
    instanceManager,
    registerIpcHandler: registerTrustedIpcHandler,
  });

  // ============================================
  // History Handlers
  // ============================================

  const history = getHistoryManager();
  const sessionRevival = new SessionRevivalService(instanceManager, {
    history: () => history,
    historyRestore: new HistoryRestoreCoordinator({
      history: () => history,
      isRemoteNodeReachable,
    }),
  });

  async function buildShareBundleForInstance(instanceId: string) {
    const instance = instanceManager.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }
    return sessionShare.createBundle({ instance });
  }

  async function buildShareBundleForHistory(entryId: string) {
    const conversation = await history.loadConversation(entryId);
    if (!conversation) {
      throw new Error(`History entry not found: ${entryId}`);
    }
    return sessionShare.createBundle({ conversation });
  }

  // List history entries
  registerTrustedIpcHandler(
    IPC_CHANNELS.HISTORY_LIST,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(HistoryListPayloadSchema, payload, 'HISTORY_LIST');
        const entries = history.getEntries(validated);
        if (process.env['VITEST'] !== 'true') void history.backfillMissingAiTitles(entries, (text) => getAutoTitleService().generateLocalTitle(text));
        return {
          success: true,
          data: entries
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HISTORY_LIST_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Load full conversation data
  registerTrustedIpcHandler(
    IPC_CHANNELS.HISTORY_LOAD,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(HistoryLoadPayloadSchema, payload, 'HISTORY_LOAD');
        const data = await history.loadConversation(validated.entryId);
        if (!data) {
          return {
            success: false,
            error: {
              code: 'HISTORY_NOT_FOUND',
              message: `History entry ${validated.entryId} not found`,
              timestamp: Date.now()
            }
          };
        }
        return {
          success: true,
          data
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HISTORY_LOAD_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Delete history entry
  registerTrustedIpcHandler(
    IPC_CHANNELS.HISTORY_DELETE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(HistoryDeletePayloadSchema, payload, 'HISTORY_DELETE');
        const deleted = await history.deleteEntry(validated.entryId);
        return {
          success: deleted,
          error: deleted
            ? undefined
            : {
                code: 'HISTORY_NOT_FOUND',
                message: `History entry ${validated.entryId} not found`,
                timestamp: Date.now()
              }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HISTORY_DELETE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Archive history entry
  registerTrustedIpcHandler(
    IPC_CHANNELS.HISTORY_ARCHIVE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(HistoryDeletePayloadSchema, payload, 'HISTORY_ARCHIVE');
        const archived = await history.archiveEntry(validated.entryId);
        return {
          success: archived,
          error: archived
            ? undefined
            : {
                code: 'HISTORY_NOT_FOUND',
                message: `History entry ${validated.entryId} not found`,
                timestamp: Date.now()
              }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HISTORY_ARCHIVE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Restore conversation as a live instance.
  // Each heavy restore path runs behind the same single-slot mutex as before;
  // the implementation now lives in SessionRevivalService/HistoryRestoreCoordinator.
  registerTrustedIpcHandler(
    IPC_CHANNELS.HISTORY_RESTORE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => withHistoryRestoreLock(async () => {
      try {
        const validated = validateIpcPayload(HistoryRestorePayloadSchema, payload, 'HISTORY_RESTORE');
        const result = await sessionRevival.revive({
          historyEntryId: validated.entryId,
          workingDirectory: validated.workingDirectory,
          reviveIfArchived: true,
          reason: 'history-restore',
        });

        if (result.status === 'failed') {
          const notFound = result.failureCode === 'target_missing';
          return {
            success: false,
            error: {
              code: notFound ? 'HISTORY_NOT_FOUND' : 'HISTORY_RESTORE_FAILED',
              message: notFound
                ? `History entry ${validated.entryId} not found`
                : result.error ?? 'History restore failed',
              timestamp: Date.now()
            }
          };
        }

        return {
          success: true,
          data: {
            instanceId: result.instanceId,
            restoredMessages: result.restoredMessages ?? [],
            restoreMode: result.restoreMode
          }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HISTORY_RESTORE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    })
  );

  // Clear all history
  registerTrustedIpcHandler(
    IPC_CHANNELS.HISTORY_CLEAR,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        validateIpcPayload(SessionHandlerEmptyPayloadSchema, payload, 'HISTORY_CLEAR');
        await history.clearAll();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HISTORY_CLEAR_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // --- Session Continuity ---

  const continuityHandlerOptions = (errorCode: string) => ({ errorCode });

  registerTrustedIpcHandler(
    IPC_CHANNELS.SESSION_LIST_RESUMABLE,
    validatedHandler(
      IPC_CHANNELS.SESSION_LIST_RESUMABLE,
      SessionListResumablePayloadSchema,
      async () => ({
        success: true,
        data: await getSessionContinuityManager().getResumableSessions(),
      }),
      continuityHandlerOptions('SESSION_LIST_RESUMABLE_FAILED'),
    ),
  );

  registerTrustedIpcHandler(
    IPC_CHANNELS.SESSION_RESUME,
    validatedHandler(
      IPC_CHANNELS.SESSION_RESUME,
      SessionResumePayloadSchema,
      async (payload) => ({
        success: true,
        data: await getSessionContinuityManager().resumeSession(payload.instanceId, payload.options),
      }),
      continuityHandlerOptions('SESSION_RESUME_FAILED'),
    ),
  );
  registerSessionRecoveryHandlers({ instanceManager, registerIpcHandler: registerTrustedIpcHandler });

  registerTrustedIpcHandler(
    IPC_CHANNELS.SESSION_LIST_SNAPSHOTS,
    validatedHandler(
      IPC_CHANNELS.SESSION_LIST_SNAPSHOTS,
      SessionListSnapshotsPayloadSchema,
      async (payload) => ({
        success: true,
        data: getSessionContinuityManager().listSnapshots(payload?.instanceId),
      }),
      continuityHandlerOptions('SESSION_LIST_SNAPSHOTS_FAILED'),
    ),
  );

  registerTrustedIpcHandler(
    IPC_CHANNELS.SESSION_CREATE_SNAPSHOT,
    validatedHandler(
      IPC_CHANNELS.SESSION_CREATE_SNAPSHOT,
      SessionCreateSnapshotPayloadSchema,
      async (payload) => ({
        success: true,
        data: await getSessionContinuityManager().createSnapshot(
          payload.instanceId,
          payload.name,
          payload.description,
          'manual',
        ),
      }),
      continuityHandlerOptions('SESSION_CREATE_SNAPSHOT_FAILED'),
    ),
  );

  registerTrustedIpcHandler(
    IPC_CHANNELS.SESSION_GET_STATS,
    validatedHandler(
      IPC_CHANNELS.SESSION_GET_STATS,
      SessionGetStatsPayloadSchema,
      async () => ({
        success: true,
        data: await getSessionContinuityManager().getStats(),
      }),
      continuityHandlerOptions('SESSION_GET_STATS_FAILED'),
    ),
  );

  registerSessionAdmissionHandlers({ ensureTrustedSender: deps.ensureTrustedSender });
  registerSessionQueueHandlers({ ensureTrustedSender: deps.ensureTrustedSender });
}
