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
  ArchiveCleanupPayloadSchema,
  ArchiveDeletePayloadSchema,
  ArchiveGetMetaPayloadSchema,
  ArchiveListPayloadSchema,
  ArchiveRestorePayloadSchema,
  ArchiveSessionPayloadSchema,
  ArchiveUpdateTagsPayloadSchema,
  HistoryDeletePayloadSchema,
  HistoryListPayloadSchema,
  HistoryLoadPayloadSchema,
  HistoryRestorePayloadSchema,
  SessionCopyToClipboardPayloadSchema,
  SessionExportPayloadSchema,
  SessionForkPayloadSchema,
  SessionImportPayloadSchema,
  SessionRevealFilePayloadSchema,
  SessionSaveToFilePayloadSchema,
  SessionShareLoadPayloadSchema,
  SessionSharePreviewPayloadSchema,
  SessionShareReplayPayloadSchema,
  SessionShareSavePayloadSchema,
} from '@contracts/schemas/session';
import {
  inferConversationHistoryProvider,
} from '../../../shared/types/history.types';
import type { ExportedSession, InstanceProvider, OutputMessage } from '../../../shared/types/instance.types';
import type { InstanceManager } from '../../instance/instance-manager';
import { getHistoryManager } from '../../history';
import { getSessionArchiveManager } from '../../session/session-archive';
import { getSessionShareService } from '../../session/session-share-service';
import { getSessionContinuityManager } from '../../session/session-continuity';
import { buildReplayContinuityMessage } from '../../session/replay-continuity';
import { getOutputStorageManager } from '../../memory/output-storage';
import type { ResumeOptions } from '../../session/session-continuity';
import { generateId } from '../../../shared/utils/id-generator';
import { getLogger } from '../../logging/logger';
import { isRemoteNodeReachable } from './remote-node-check';

const logger = getLogger('SessionHandlers');

/**
 * Select the most recent messages within a count limit for display during restore.
 * Keeps tool_use/tool_result pairs together at the boundary.
 */
export function selectMessagesForRestore(
  messages: OutputMessage[],
  limit = 100
): { selected: OutputMessage[]; hidden: OutputMessage[]; truncatedCount: number } {
  if (!messages?.length || messages.length <= limit) {
    return { selected: messages || [], hidden: [], truncatedCount: 0 };
  }

  let startIdx = messages.length - limit;

  // Don't orphan tool_use/tool_result pairs at the boundary
  while (startIdx > 0 && messages[startIdx]?.type === 'tool_result') {
    startIdx--;
  }

  return {
    hidden: messages.slice(0, startIdx),
    selected: messages.slice(startIdx),
    truncatedCount: startIdx,
  };
}

function getProviderDisplayName(provider: InstanceProvider): string {
  switch (provider) {
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'copilot':
      return 'Copilot';
    case 'cursor':
      return 'Cursor';
    case 'claude':
    default:
      return 'Claude';
  }
}

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
}

/**
 * Register session, archive, and history IPC handlers
 */
export function registerSessionHandlers(deps: SessionHandlersDeps): void {
  const { instanceManager, serializeInstance } = deps;

  // ============================================
  // Session Handlers
  // ============================================

  // Fork session
  ipcMain.handle(
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
          displayName: validated.displayName,
          initialPrompt: validated.initialPrompt
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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

  // ============================================
  // Archive Handlers
  // ============================================

  const archiveManager = getSessionArchiveManager();

  // Archive session - requires an Instance object
  ipcMain.handle(
    IPC_CHANNELS.ARCHIVE_SESSION,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ArchiveSessionPayloadSchema, payload, 'ARCHIVE_SESSION');
        // Get the instance from instance manager
        const instance = instanceManager.getInstance(validated.instanceId);
        if (!instance) {
          throw new Error(`Instance not found: ${validated.instanceId}`);
        }
        const meta = archiveManager.archiveSession(instance, validated.tags);
        return { success: true, data: meta };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'ARCHIVE_SESSION_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // List archives
  ipcMain.handle(
    IPC_CHANNELS.ARCHIVE_LIST,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ArchiveListPayloadSchema, payload, 'ARCHIVE_LIST');
        const filter = validated
          ? {
              beforeDate: validated.beforeDate,
              afterDate: validated.afterDate,
              tags: validated.tags,
              searchTerm: validated.searchTerm
            }
          : undefined;
        const archives = archiveManager.listArchivedSessions(filter);
        return { success: true, data: archives };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'ARCHIVE_LIST_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Restore archive
  ipcMain.handle(
    IPC_CHANNELS.ARCHIVE_RESTORE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ArchiveRestorePayloadSchema, payload, 'ARCHIVE_RESTORE');
        const sessionData = archiveManager.restoreSession(validated.sessionId);
        return { success: true, data: sessionData };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'ARCHIVE_RESTORE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Delete archive
  ipcMain.handle(
    IPC_CHANNELS.ARCHIVE_DELETE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ArchiveDeletePayloadSchema, payload, 'ARCHIVE_DELETE');
        const success = archiveManager.deleteArchivedSession(
          validated.sessionId
        );
        return { success: true, data: { deleted: success } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'ARCHIVE_DELETE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get archive metadata
  ipcMain.handle(
    IPC_CHANNELS.ARCHIVE_GET_META,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ArchiveGetMetaPayloadSchema, payload, 'ARCHIVE_GET_META');
        const meta = archiveManager.getArchivedSessionMeta(validated.sessionId);
        return { success: true, data: meta };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'ARCHIVE_GET_META_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Update tags
  ipcMain.handle(
    IPC_CHANNELS.ARCHIVE_UPDATE_TAGS,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ArchiveUpdateTagsPayloadSchema, payload, 'ARCHIVE_UPDATE_TAGS');
        const success = archiveManager.updateTags(
          validated.sessionId,
          validated.tags
        );
        return { success: true, data: { updated: success } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'ARCHIVE_UPDATE_TAGS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get archive stats
  ipcMain.handle(
    IPC_CHANNELS.ARCHIVE_GET_STATS,
    async (): Promise<IpcResponse> => {
      try {
        const stats = archiveManager.getArchiveStats();
        return { success: true, data: stats };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'ARCHIVE_GET_STATS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Cleanup old archives
  ipcMain.handle(
    IPC_CHANNELS.ARCHIVE_CLEANUP,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ArchiveCleanupPayloadSchema, payload, 'ARCHIVE_CLEANUP');
        const deleted = archiveManager.cleanupOldArchives(validated.maxAgeDays);
        return { success: true, data: { deletedCount: deleted } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'ARCHIVE_CLEANUP_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // History Handlers
  // ============================================

  const history = getHistoryManager();

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
  ipcMain.handle(
    IPC_CHANNELS.HISTORY_LIST,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(HistoryListPayloadSchema, payload, 'HISTORY_LIST');
        const entries = history.getEntries(validated);
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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

  // Restore conversation as new instance
  // Uses a two-phase approach: try --resume first, fall back to fresh instance
  //
  // Each restore's heavy path (createInstance → readyPromise → CLI spawn →
  // post-spawn poll) runs behind a single-slot mutex so rapid-fire restores
  // don't overload the main process event loop. See withHistoryRestoreLock.
  ipcMain.handle(
    IPC_CHANNELS.HISTORY_RESTORE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => withHistoryRestoreLock(async () => {
      try {
        const validated = validateIpcPayload(HistoryRestorePayloadSchema, payload, 'HISTORY_RESTORE');
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

        const workingDir =
          validated.workingDirectory || data.entry.workingDirectory;
        // Use the saved displayName directly — getConversationHistoryTitle
        // prefers firstUserMessage over the auto-generated displayName,
        // which would overwrite a good title on restore.
        const displayName = data.entry.displayName;
        const historyThreadId =
          data.entry.historyThreadId || data.entry.sessionId || data.entry.id;
        const restoreProvider = inferConversationHistoryProvider(data.entry);
        const restoreModel = data.entry.currentModel?.trim() || undefined;

        // If the session originally ran on a remote node, extract the nodeId
        // so createInstance routes the CLI to the same node.
        const restoreNodeId = data.entry.executionLocation?.type === 'remote'
          ? data.entry.executionLocation.nodeId
          : undefined;

        // For remote sessions, check whether the node is still connected.
        // Native resume (--resume <sessionId>) only works on the node that
        // holds the session — attempting it locally is guaranteed to fail.
        const remoteNodeAvailable = restoreNodeId
          ? isRemoteNodeReachable(restoreNodeId)
          : true;
        if (restoreNodeId && !remoteNodeAvailable) {
          logger.info('History restore: remote node unavailable, skipping native resume', {
            nodeId: restoreNodeId,
          });
        }

        const canAttemptNativeResume =
          Boolean(data.entry.sessionId?.trim())
          && !data.entry.nativeResumeFailedAt
          && remoteNodeAvailable;
        let resumeFailed = false;

        // Phase 1: Try to resume the CLI session
        if (canAttemptNativeResume) {
          let resumeInstanceId: string | undefined;
          try {
            const instance = await instanceManager.createInstance({
              workingDirectory: workingDir,
              displayName,
              isRenamed: data.entry.isRenamed,
              historyThreadId,
              sessionId: data.entry.sessionId,
              resume: true,
              initialOutputBuffer: data.messages,
              provider: restoreProvider,
              modelOverride: restoreModel,
              forceNodeId: restoreNodeId,
            });
            resumeInstanceId = instance.id;

            // Wait for Phase 2 (background init) to complete before checking resume.
            // Phase 2 spawns the CLI process — without this, the poll races against
            // instruction loading + CLI detection (~10-15s) and always times out.
            try {
              await instance.readyPromise;
            } catch {
              // Phase 2 itself failed (e.g., CLI not found, spawn error)
              throw new Error('Instance initialization failed during resume');
            }

            // Now the CLI process is spawned with --resume <sessionId>.
            // Check for definitive signals:
            // - context usage > 0 → CLI loaded the session (success)
            // - process exited → session not found or error (failure)
            // - process alive, no context → session loaded, waiting for input (success)
            //
            // In --print --input-format stream-json mode, the CLI may not emit
            // any output until it receives user input. So "alive after grace period"
            // is treated as success — if the session ID was invalid, the CLI exits fast.
            // Remote sessions need more time due to network latency and remote CLI
            // startup. Scale the timeout based on whether this is a remote resume.
            const POST_SPAWN_TIMEOUT_MS = restoreNodeId ? 15_000 : 5_000;
            const POLL_INTERVAL_MS = 200;

            // Track whether resume was confirmed via context usage or merely assumed
            // from a live process. Unconfirmed resumes need a replay continuity
            // preamble because the provider may have silently started a fresh thread.
            let resumeConfirmed = false;

            const resumeAlive = await new Promise<boolean>((resolve) => {
              const timeout = setTimeout(() => {
                cleanup();
                const inst = instanceManager.getInstance(instance.id);
                const alive = inst != null
                  && inst.status !== 'error'
                  && inst.status !== 'terminated';
                const hasContext = inst?.contextUsage != null && inst.contextUsage.used > 0;

                if (alive) {
                  if (hasContext) {
                    resumeConfirmed = true;
                    logger.info('History restore: resume confirmed via context usage', {
                      instanceId: instance.id,
                      contextUsed: inst?.contextUsage?.used,
                    });
                  } else {
                    // Process is alive but no context usage — resume is unconfirmed.
                    // The provider may have silently fallen back to a fresh thread.
                    logger.info('History restore: resume unconfirmed — process alive but no context usage', {
                      instanceId: instance.id,
                      status: inst?.status,
                      contextUsed: inst?.contextUsage?.used,
                    });
                  }
                  resolve(true);
                } else {
                  // Process died during the grace period, so native resume failed.
                  logger.warn('History restore: resume failed after grace period', {
                    instanceId: instance.id,
                    status: inst?.status,
                    alive,
                    hasContext,
                    contextUsed: inst?.contextUsage?.used,
                  });
                  resolve(false);
                }
              }, POST_SPAWN_TIMEOUT_MS);

              const poll = setInterval(() => {
                const inst = instanceManager.getInstance(instance.id);
                if (!inst) {
                  cleanup();
                  resolve(false);
                  return;
                }

                // Definitive failure: process exited
                if (inst.status === 'error' || inst.status === 'terminated') {
                  cleanup();
                  resolve(false);
                  return;
                }

                // Definitive success: CLI reported token usage from the resumed session
                if (inst.contextUsage && inst.contextUsage.used > 0) {
                  cleanup();
                  resumeConfirmed = true;
                  logger.info('History restore: resume confirmed early via context usage', {
                    instanceId: instance.id,
                    contextUsed: inst.contextUsage.used,
                  });
                  resolve(true);
                  return;
                }
              }, POLL_INTERVAL_MS);

              function cleanup() {
                clearTimeout(timeout);
                clearInterval(poll);
              }
            });

            if (resumeAlive) {
              if (resumeConfirmed) {
                // Resume confirmed — context usage observed, session truly restored
                logger.info('History restore: CLI session resumed successfully (confirmed)', {
                  instanceId: instance.id,
                  sessionId: data.entry.sessionId,
                });
                return {
                  success: true,
                  data: {
                    instanceId: instance.id,
                    restoredMessages: instance.outputBuffer,
                    restoreMode: 'native-resume'
                  }
                };
              }

              // Resume unconfirmed — process is alive but provider may have
              // silently started a fresh thread. Send a replay continuity
              // preamble so the agent has conversation context either way.
              logger.info('History restore: resume unconfirmed — injecting replay preamble as safety net', {
                instanceId: instance.id,
                sessionId: data.entry.sessionId,
              });

              try {
                const preamble = buildReplayContinuityMessage(data.messages, { reason: 'resume-unconfirmed' });
                if (preamble) {
                  instanceManager.queueContinuityPreamble(instance.id, preamble);
                }
              } catch (preambleErr) {
                logger.warn('History restore: failed to queue replay preamble', {
                  instanceId: instance.id,
                  error: preambleErr instanceof Error ? preambleErr.message : String(preambleErr),
                });
              }

              return {
                success: true,
                data: {
                  instanceId: instance.id,
                  restoredMessages: instance.outputBuffer,
                  restoreMode: 'native-resume'
                }
              };
            }

            // Process died — fall through to fallback
            resumeFailed = true;
            const currentInstance = instanceManager.getInstance(instance.id);
            logger.warn('History restore: CLI session resume failed, falling back to fresh instance', {
              instanceId: instance.id,
              sessionId: data.entry.sessionId,
              status: currentInstance?.status
            });

            // Clean up the failed instance.
            // Clear outputBuffer so archiveInstance() skips it (it checks length === 0).
            if (currentInstance) {
              currentInstance.outputBuffer = [];
            }
            try {
              await instanceManager.terminateInstance(instance.id, false);
            } catch {
              // Ignore cleanup errors
            }
          } catch (err) {
            // createInstance or readyPromise threw — fall through to fallback.
            // If an instance was created before the error (e.g. readyPromise
            // rejection when remote spawn fails), clean it up so we don't
            // leave a ghost instance in the sidebar alongside the fallback.
            resumeFailed = true;
            logger.warn('History restore: resume attempt threw', {
              error: err instanceof Error ? err.message : String(err),
              resumeInstanceId,
            });
            if (resumeInstanceId) {
              const staleInstance = instanceManager.getInstance(resumeInstanceId);
              if (staleInstance) {
                staleInstance.outputBuffer = [];
              }
              try {
                await instanceManager.terminateInstance(resumeInstanceId, false);
              } catch {
                // Ignore cleanup errors — terminateInstance already handles
                // adapter failures internally after the fix above.
              }
            }
          }
        } else {
          resumeFailed = true;
          logger.info('History restore: skipping native resume', {
            entryId: validated.entryId,
            sessionId: data.entry.sessionId,
            nativeResumeFailedAt: data.entry.nativeResumeFailedAt ?? null,
            remoteNodeAvailable: restoreNodeId ? remoteNodeAvailable : undefined,
            restoreNodeId: restoreNodeId ?? null,
          });
        }

        // Phase 2: Fallback — create fresh instance with messages as display context
        if (resumeFailed) {
          if (canAttemptNativeResume) {
            try {
              await history.markNativeResumeFailed(validated.entryId);
            } catch (markError) {
              logger.warn('History restore: failed to persist native resume failure state', {
                entryId: validated.entryId,
                error: markError instanceof Error ? markError.message : String(markError),
              });
            }
          }

          const { selected: displayMessages, hidden: hiddenMessages, truncatedCount } =
            selectMessagesForRestore(data.messages, 100);

          // Only route the fallback to the remote node if it's still connected.
          // When the node is unavailable, fall back to a local session and resolve
          // the working directory to something that exists on this machine (the
          // remote workingDir is likely a path on the worker node's filesystem).
          const fallbackNodeId = remoteNodeAvailable ? restoreNodeId : undefined;
          // When falling back to local, ALWAYS use process.cwd() — the stored
          // working directory is a path on the remote node's filesystem (e.g.,
          // C:\Users\shutu\Documents\Work) which doesn't exist locally.
          // validated.workingDirectory is the entry's saved path and is equally
          // invalid on the local machine.
          const fallbackWorkingDir = (restoreNodeId && !remoteNodeAvailable)
            ? process.cwd()
            : workingDir;

          const instance = await instanceManager.createInstance({
            workingDirectory: fallbackWorkingDir,
            displayName,
            isRenamed: data.entry.isRenamed,
            historyThreadId,
            initialOutputBuffer: displayMessages,
            provider: restoreProvider,
            modelOverride: restoreModel,
            forceNodeId: fallbackNodeId,
            // No resume, no sessionId — fresh session
          });

          let canLoadEarlierMessages = hiddenMessages.length > 0;
          if (canLoadEarlierMessages) {
            try {
              await getOutputStorageManager().storeMessages(instance.id, hiddenMessages);
              logger.info('History restore: persisted truncated messages for lazy loading', {
                instanceId: instance.id,
                storedCount: hiddenMessages.length,
              });
            } catch (storageError) {
              canLoadEarlierMessages = false;
              logger.error(
                'History restore: failed to persist truncated messages',
                storageError instanceof Error ? storageError : undefined,
                {
                  instanceId: instance.id,
                  storedCount: hiddenMessages.length,
                }
              );
            }
          }

          const replayContinuity = buildReplayContinuityMessage(data.messages, {
            reason: canAttemptNativeResume ? 'history-restore-fallback' : 'history-restore-replay',
          });
          if (replayContinuity) {
            instanceManager.queueContinuityPreamble(instance.id, replayContinuity);
          }

          const providerName = getProviderDisplayName(restoreProvider);

          // Add a system message informing the user that CLI context was lost
          const systemMessage: OutputMessage = {
            id: generateId(),
            timestamp: Date.now(),
            type: 'system' as const,
            content: truncatedCount > 0 && canLoadEarlierMessages
              ? `Previous ${providerName} CLI session could not be restored natively. Your conversation history is displayed above (${truncatedCount} earlier messages available via "Load earlier messages"), and a condensed transcript will be attached automatically to your next message.`
              : truncatedCount > 0
                ? `Previous ${providerName} CLI session could not be restored natively. The latest ${displayMessages.length} messages are displayed above, and a condensed transcript of the earlier conversation will be attached automatically to your next message.`
                : `Previous ${providerName} CLI session could not be restored natively. Your conversation history is displayed above, and a condensed transcript will be attached automatically to your next message.`,
            metadata: {
              isRestoreNotice: true,
              systemMessageKind: 'restore-fallback',
              provider: restoreProvider,
              restoredMessageCount: data.messages.length,
              hiddenMessageCount: hiddenMessages.length,
              continuityInjectionQueued: Boolean(replayContinuity),
              nativeResumeFailedAt: canAttemptNativeResume ? Date.now() : (data.entry.nativeResumeFailedAt ?? null),
              originalSessionId: data.entry.sessionId,
              restoreNodeId: restoreNodeId ?? null,
              remoteNodeAvailable: restoreNodeId ? remoteNodeAvailable : undefined,
            }
          };
          instance.outputBuffer.push(systemMessage);
          const restoredMessages: OutputMessage[] = [...displayMessages, systemMessage];

          logger.info('History restore: created fresh instance with restored messages', {
            instanceId: instance.id,
            messageCount: restoredMessages.length,
            provider: restoreProvider,
            restoreNodeId: restoreNodeId ?? null,
          });

          return {
            success: true,
            data: {
              instanceId: instance.id,
              restoredMessages,
              restoreMode: 'replay-fallback'
            }
          };
        }

        // Should not reach here, but satisfy TypeScript
        return {
          success: false,
          error: {
            code: 'HISTORY_RESTORE_FAILED',
            message: 'Unexpected state in restore handler',
            timestamp: Date.now()
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
  ipcMain.handle(
    IPC_CHANNELS.HISTORY_CLEAR,
    async (): Promise<IpcResponse> => {
      try {
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

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST_RESUMABLE, async () => {
    try {
      return getSessionContinuityManager().getResumableSessions();
    } catch (error) {
      logger.error('Failed to list resumable sessions', error instanceof Error ? error : undefined);
      return [];
    }
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_RESUME, async (_event: IpcMainInvokeEvent, payload: { instanceId: string; options?: ResumeOptions }) => {
    try {
      return await getSessionContinuityManager().resumeSession(payload.instanceId, payload.options);
    } catch (error) {
      logger.error('Failed to resume session', error instanceof Error ? error : undefined);
      return null;
    }
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST_SNAPSHOTS, async (_event: IpcMainInvokeEvent, payload?: { instanceId?: string }) => {
    try {
      return getSessionContinuityManager().listSnapshots(payload?.instanceId);
    } catch (error) {
      logger.error('Failed to list snapshots', error instanceof Error ? error : undefined);
      return [];
    }
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE_SNAPSHOT, async (_event: IpcMainInvokeEvent, payload: { instanceId: string; name?: string; description?: string }) => {
    try {
      return getSessionContinuityManager().createSnapshot(payload.instanceId, payload.name, payload.description, 'manual');
    } catch (error) {
      logger.error('Failed to create snapshot', error instanceof Error ? error : undefined);
      return null;
    }
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_GET_STATS, async () => {
    try {
      return getSessionContinuityManager().getStats();
    } catch (error) {
      logger.error('Failed to get session stats', error instanceof Error ? error : undefined);
      return null;
    }
  });
}
