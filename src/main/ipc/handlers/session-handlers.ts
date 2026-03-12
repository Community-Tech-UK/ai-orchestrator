/**
 * Session, Archive, and History IPC Handlers
 * Handles session management, archiving, and conversation history operations
 */

import { ipcMain, IpcMainInvokeEvent, dialog, clipboard, shell } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import {
  validateIpcPayload,
  SessionForkPayloadSchema,
  SessionExportPayloadSchema,
  SessionImportPayloadSchema,
  SessionCopyToClipboardPayloadSchema,
  SessionSaveToFilePayloadSchema,
  SessionRevealFilePayloadSchema,
  SessionSharePreviewPayloadSchema,
  SessionShareSavePayloadSchema,
  SessionShareLoadPayloadSchema,
  SessionShareReplayPayloadSchema,
  ArchiveSessionPayloadSchema,
  ArchiveListPayloadSchema,
  ArchiveRestorePayloadSchema,
  ArchiveDeletePayloadSchema,
  ArchiveGetMetaPayloadSchema,
  ArchiveUpdateTagsPayloadSchema,
  ArchiveCleanupPayloadSchema,
  HistoryListPayloadSchema,
  HistoryLoadPayloadSchema,
  HistoryDeletePayloadSchema,
  HistoryRestorePayloadSchema,
} from '../../../shared/validation/ipc-schemas';
import { getConversationHistoryTitle } from '../../../shared/types/history.types';
import type { ExportedSession } from '../../../shared/types/instance.types';
import type { InstanceManager } from '../../instance/instance-manager';
import { getHistoryManager } from '../../history';
import { getSessionArchiveManager } from '../../session/session-archive';
import { getSessionShareService } from '../../session/session-share-service';
import { getSessionContinuityManager } from '../../session/session-continuity';
import type { ResumeOptions } from '../../session/session-continuity';
import { generateId } from '../../../shared/utils/id-generator';
import { getLogger } from '../../logging/logger';

const logger = getLogger('SessionHandlers');

interface SessionHandlersDeps {
  instanceManager: InstanceManager;
  serializeInstance: (instance: any) => Record<string, unknown>;
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
          displayName: validated.displayName
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
        const fs = require('fs').promises;
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

        const fs = require('fs').promises;
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
  ipcMain.handle(
    IPC_CHANNELS.HISTORY_RESTORE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
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
        const displayName = getConversationHistoryTitle(data.entry);
        let resumeFailed = false;

        // Phase 1: Try to resume the CLI session
        try {
          const instance = await instanceManager.createInstance({
            workingDirectory: workingDir,
            displayName,
            sessionId: data.entry.sessionId,
            resume: true,
            initialOutputBuffer: data.messages
          });

          // Wait for a definitive signal rather than a fixed timeout.
          // A successful --resume will report context usage > 0 (since there's
          // an existing conversation). A failed --resume will cause the process
          // to exit, setting status to 'error' or 'terminated'.
          const RESUME_TIMEOUT_MS = 8000;
          const POLL_INTERVAL_MS = 150;

          const resumeAlive = await new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => {
              cleanup();
              // Timeout with no signal — check final state
              const inst = instanceManager.getInstance(instance.id);
              const alive = !!inst && inst.status !== 'error' && inst.status !== 'terminated';
              logger.warn('History restore: resume check timed out', {
                instanceId: instance.id,
                status: inst?.status,
                contextUsed: inst?.contextUsage?.used,
                alive
              });
              resolve(alive);
            }, RESUME_TIMEOUT_MS);

            const poll = setInterval(() => {
              const inst = instanceManager.getInstance(instance.id);
              if (!inst) {
                // Instance was removed
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
            // Resume succeeded
            logger.info('History restore: CLI session resumed successfully', {
              instanceId: instance.id,
              sessionId: data.entry.sessionId
            });
            return {
              success: true,
              data: {
                instanceId: instance.id,
                restoredMessages: data.messages,
                resumed: true
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
          // createInstance itself threw — fall through to fallback
          resumeFailed = true;
          logger.warn('History restore: createInstance with resume threw', {
            error: err instanceof Error ? err.message : String(err)
          });
        }

        // Phase 2: Fallback — create fresh instance with messages as display context
        if (resumeFailed) {
          const instance = await instanceManager.createInstance({
            workingDirectory: workingDir,
            displayName,
            initialOutputBuffer: data.messages
            // No resume, no sessionId — fresh session
          });

          // Add a system message informing the user that CLI context was lost
          const systemMessage = {
            id: generateId(),
            timestamp: Date.now(),
            type: 'system' as const,
            content:
              'Previous CLI session could not be restored. Your conversation history is displayed above, but Claude does not have this context. You may need to re-summarize what you were working on.'
          };
          instance.outputBuffer.push(systemMessage);

          logger.info('History restore: created fresh instance with restored messages', {
            instanceId: instance.id,
            messageCount: data.messages.length
          });

          return {
            success: true,
            data: {
              instanceId: instance.id,
              restoredMessages: data.messages,
              resumed: false
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
    }
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
