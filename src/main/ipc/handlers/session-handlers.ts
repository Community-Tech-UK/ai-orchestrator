/**
 * Session, Archive, and History IPC Handlers
 * Handles session management, archiving, and conversation history operations
 */

import { IpcMainInvokeEvent, dialog, clipboard, shell } from 'electron';
import { promises as fs } from 'fs';
import type { z } from 'zod';
import { IPC_CHANNELS } from '@contracts/channels';
import type { IpcResponse } from '../../../shared/types/ipc.types';
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
import { isVisibleOutputMessage } from '../../../shared/types/tool-outcome';
import type { InstanceManager } from '../../instance/instance-manager';
import { getAutoTitleService } from '../../instance/auto-title-service';
import { getHistoryManager } from '../../history';
import { getSessionShareService } from '../../session/session-share-service';
import { getSessionContinuityManager } from '../../session/session-continuity';
import { SessionRevivalService } from '../../session/session-revival-service';
import { HistoryRestoreCoordinator } from '../../history/history-restore-coordinator';
import { isRemoteNodeReachable } from './remote-node-check';
import { registerValidatedIpcHandler } from '../validated-handler';
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
  const register = <T>(
    channel: string,
    schema: z.ZodSchema<T>,
    fn: (validated: T, event: IpcMainInvokeEvent) => Promise<IpcResponse>,
    errorCode?: string,
  ): void => {
    registerValidatedIpcHandler(channel, schema, fn, {
      ensureTrustedSender: deps.ensureTrustedSender,
      errorCode,
    });
  };

  // ============================================
  // Session Handlers
  // ============================================

  // Fork session
  register(
    IPC_CHANNELS.SESSION_FORK,
    SessionForkPayloadSchema,
    async (validated) => {
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
        data: serializeInstance(forkedInstance),
      };
    },
    'SESSION_FORK_FAILED',
  );

  // Export session
  register(
    IPC_CHANNELS.SESSION_EXPORT,
    SessionExportPayloadSchema,
    async (validated) => {
      if (validated.format === 'json') {
        return {
          success: true,
          data: instanceManager.exportSession(validated.instanceId),
        };
      }
      return {
        success: true,
        data: instanceManager.exportSessionMarkdown(validated.instanceId),
      };
    },
    'SESSION_EXPORT_FAILED',
  );

  // Import session
  register(
    IPC_CHANNELS.SESSION_IMPORT,
    SessionImportPayloadSchema,
    async (validated) => {
      const content = await fs.readFile(validated.filePath, 'utf-8');
      const session: ExportedSession = JSON.parse(content);

      if (!session.version || !session.messages) {
        return {
          success: false,
          error: {
            code: 'INVALID_SESSION_FORMAT',
            message: 'Invalid session file format',
            timestamp: Date.now(),
          },
        };
      }

      const instance = await instanceManager.importSession(
        session,
        validated.workingDirectory,
      );

      return {
        success: true,
        data: serializeInstance(instance),
      };
    },
    'SESSION_IMPORT_FAILED',
  );

  // Copy session to clipboard
  register(
    IPC_CHANNELS.SESSION_COPY_TO_CLIPBOARD,
    SessionCopyToClipboardPayloadSchema,
    async (validated) => {
      const content = validated.format === 'json'
        ? JSON.stringify(instanceManager.exportSession(validated.instanceId), null, 2)
        : instanceManager.exportSessionMarkdown(validated.instanceId);

      clipboard.writeText(content);
      return {
        success: true,
        data: { copied: true, format: validated.format },
      };
    },
    'SESSION_COPY_FAILED',
  );

  // Save session to file
  register(
    IPC_CHANNELS.SESSION_SAVE_TO_FILE,
    SessionSaveToFilePayloadSchema,
    async (validated) => {
      let filePath = validated.filePath;

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
              : { name: 'Markdown', extensions: ['md'] },
          ],
        });

        if (result.canceled || !result.filePath) {
          return {
            success: false,
            error: {
              code: 'SAVE_CANCELLED',
              message: 'Save cancelled',
              timestamp: Date.now(),
            },
          };
        }
        filePath = result.filePath;
      }

      const content = validated.format === 'json'
        ? JSON.stringify(instanceManager.exportSession(validated.instanceId), null, 2)
        : instanceManager.exportSessionMarkdown(validated.instanceId);

      await fs.writeFile(filePath, content, 'utf-8');

      return { success: true, data: { filePath, format: validated.format } };
    },
    'SESSION_SAVE_FAILED',
  );

  // Reveal file in system file manager
  register(
    IPC_CHANNELS.SESSION_REVEAL_FILE,
    SessionRevealFilePayloadSchema,
    async (validated) => {
      shell.showItemInFolder(validated.filePath);
      return { success: true };
    },
    'REVEAL_FAILED',
  );

  const sessionShare = getSessionShareService();

  // Preview a redacted share bundle for an active or historical session
  register(
    IPC_CHANNELS.SESSION_SHARE_PREVIEW,
    SessionSharePreviewPayloadSchema,
    async (validated) => {
      const bundle = validated.instanceId
        ? await buildShareBundleForInstance(validated.instanceId)
        : await buildShareBundleForHistory(validated.entryId!);

      return {
        success: true,
        data: bundle,
      };
    },
    'SESSION_SHARE_PREVIEW_FAILED',
  );

  // Save a redacted share bundle to disk
  register(
    IPC_CHANNELS.SESSION_SHARE_SAVE,
    SessionShareSavePayloadSchema,
    async (validated) => {
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
            },
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
        },
      };
    },
    'SESSION_SHARE_SAVE_FAILED',
  );

  // Load a saved share bundle from disk
  register(
    IPC_CHANNELS.SESSION_SHARE_LOAD,
    SessionShareLoadPayloadSchema,
    async (validated) => {
      const bundle = await sessionShare.loadBundle(validated.filePath);
      return {
        success: true,
        data: bundle,
      };
    },
    'SESSION_SHARE_LOAD_FAILED',
  );

  // Replay a share bundle as a new local instance
  register(
    IPC_CHANNELS.SESSION_SHARE_REPLAY,
    SessionShareReplayPayloadSchema,
    async (validated) => {
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
    },
    'SESSION_SHARE_REPLAY_FAILED',
  );

  registerSessionArchiveHandlers({
    instanceManager,
    ensureTrustedSender: deps.ensureTrustedSender,
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
  register(
    IPC_CHANNELS.HISTORY_LIST,
    HistoryListPayloadSchema,
    async (validated) => {
      const entries = history.getEntries(validated);
      if (process.env['VITEST'] !== 'true') void history.backfillMissingAiTitles(entries, (text) => getAutoTitleService().generateLocalTitle(text));
      return {
        success: true,
        data: entries,
      };
    },
    'HISTORY_LIST_FAILED',
  );

  // Load full conversation data
  register(
    IPC_CHANNELS.HISTORY_LOAD,
    HistoryLoadPayloadSchema,
    async (validated) => {
      const data = await history.loadConversation(validated.entryId);
      if (!data) {
        return {
          success: false,
          error: {
            code: 'HISTORY_NOT_FOUND',
            message: `History entry ${validated.entryId} not found`,
            timestamp: Date.now(),
          },
        };
      }
      // LT-196: the archive holds miner-only `tool_outcome` records. The
      // renderer has no use for them and its history views render every
      // message verbatim, so they stop at this boundary.
      return {
        success: true,
        data: { ...data, messages: data.messages.filter(isVisibleOutputMessage) },
      };
    },
    'HISTORY_LOAD_FAILED',
  );

  // Delete history entry
  register(
    IPC_CHANNELS.HISTORY_DELETE,
    HistoryDeletePayloadSchema,
    async (validated) => {
      const deleted = await history.deleteEntry(validated.entryId);
      return {
        success: deleted,
        error: deleted
          ? undefined
          : {
              code: 'HISTORY_NOT_FOUND',
              message: `History entry ${validated.entryId} not found`,
              timestamp: Date.now(),
            },
      };
    },
    'HISTORY_DELETE_FAILED',
  );

  // Archive history entry
  register(
    IPC_CHANNELS.HISTORY_ARCHIVE,
    HistoryDeletePayloadSchema,
    async (validated) => {
      const archived = await history.archiveEntry(validated.entryId);
      return {
        success: archived,
        error: archived
          ? undefined
          : {
              code: 'HISTORY_NOT_FOUND',
              message: `History entry ${validated.entryId} not found`,
              timestamp: Date.now(),
            },
      };
    },
    'HISTORY_ARCHIVE_FAILED',
  );

  // Restore conversation as a live instance.
  // Each heavy restore path runs behind the same single-slot mutex as before;
  // the implementation now lives in SessionRevivalService/HistoryRestoreCoordinator.
  register(
    IPC_CHANNELS.HISTORY_RESTORE,
    HistoryRestorePayloadSchema,
    async (validated) => withHistoryRestoreLock(async () => {
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
            timestamp: Date.now(),
          },
        };
      }

      return {
        success: true,
        data: {
          instanceId: result.instanceId,
          restoredMessages: result.restoredMessages ?? [],
          restoreMode: result.restoreMode,
        },
      };
    }),
    'HISTORY_RESTORE_FAILED',
  );

  // Clear all history
  register(
    IPC_CHANNELS.HISTORY_CLEAR,
    SessionHandlerEmptyPayloadSchema,
    async () => {
      await history.clearAll();
      return { success: true };
    },
    'HISTORY_CLEAR_FAILED',
  );

  // --- Session Continuity ---

  register(
    IPC_CHANNELS.SESSION_LIST_RESUMABLE,
    SessionListResumablePayloadSchema,
    async () => ({
      success: true,
      data: await getSessionContinuityManager().getResumableSessions(),
    }),
    'SESSION_LIST_RESUMABLE_FAILED',
  );

  register(
    IPC_CHANNELS.SESSION_RESUME,
    SessionResumePayloadSchema,
    async (payload) => ({
      success: true,
      data: await getSessionContinuityManager().resumeSession(payload.instanceId, payload.options),
    }),
    'SESSION_RESUME_FAILED',
  );
  registerSessionRecoveryHandlers({
    instanceManager,
    ensureTrustedSender: deps.ensureTrustedSender,
  });

  register(
    IPC_CHANNELS.SESSION_LIST_SNAPSHOTS,
    SessionListSnapshotsPayloadSchema,
    async (payload) => ({
      success: true,
      data: getSessionContinuityManager().listSnapshots(payload?.instanceId),
    }),
    'SESSION_LIST_SNAPSHOTS_FAILED',
  );

  register(
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
    'SESSION_CREATE_SNAPSHOT_FAILED',
  );

  register(
    IPC_CHANNELS.SESSION_GET_STATS,
    SessionGetStatsPayloadSchema,
    async () => ({
      success: true,
      data: await getSessionContinuityManager().getStats(),
    }),
    'SESSION_GET_STATS_FAILED',
  );

  registerSessionAdmissionHandlers({ ensureTrustedSender: deps.ensureTrustedSender });
  registerSessionQueueHandlers({ ensureTrustedSender: deps.ensureTrustedSender });
}
