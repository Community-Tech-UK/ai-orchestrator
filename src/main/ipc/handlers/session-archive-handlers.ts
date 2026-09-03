/**
 * Archive IPC handlers.
 *
 * Extracted from `session-handlers.ts` so that file stays inside its LOC
 * ceiling. Behaviour matches the previous inline registrations.
 */

import type { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  ArchiveCleanupPayloadSchema,
  ArchiveDeletePayloadSchema,
  ArchiveGetMetaPayloadSchema,
  ArchiveListPayloadSchema,
  ArchiveRestorePayloadSchema,
  ArchiveSearchPayloadSchema,
  ArchiveSessionPayloadSchema,
  ArchiveUpdateTagsPayloadSchema,
  SessionHandlerEmptyPayloadSchema,
} from '@contracts/schemas/session';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { InstanceManager } from '../../instance/instance-manager';
import { getSessionArchiveManager } from '../../session/session-archive';

type SessionIpcListener = (
  event: IpcMainInvokeEvent,
  payload: unknown,
) => Promise<IpcResponse>;

export interface RegisterSessionArchiveHandlersDeps {
  instanceManager: Pick<InstanceManager, 'getInstance'>;
  registerIpcHandler(channel: string, listener: SessionIpcListener): void;
}

export function registerSessionArchiveHandlers(deps: RegisterSessionArchiveHandlersDeps): void {
  const { instanceManager, registerIpcHandler } = deps;
  const archiveManager = getSessionArchiveManager();

  registerIpcHandler(
    IPC_CHANNELS.ARCHIVE_SESSION,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ArchiveSessionPayloadSchema, payload, 'ARCHIVE_SESSION');
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
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.ARCHIVE_LIST,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ArchiveListPayloadSchema, payload, 'ARCHIVE_LIST');
        const filter = validated
          ? {
              beforeDate: validated.beforeDate,
              afterDate: validated.afterDate,
              tags: validated.tags,
              searchTerm: validated.searchTerm,
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
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.ARCHIVE_SEARCH,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          ArchiveSearchPayloadSchema,
          payload,
          'ARCHIVE_SEARCH',
        );
        const query = validated.query.trim();

        const archives = archiveManager
          .listArchivedSessions({
            searchTerm: query || undefined,
            tags: validated.options?.tags,
          })
          .slice(0, validated.options?.limit);

        return { success: true, data: archives };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'ARCHIVE_SEARCH_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.ARCHIVE_RESTORE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ArchiveRestorePayloadSchema, payload, 'ARCHIVE_RESTORE');
        const sessionData = archiveManager.restoreSession(validated.archiveId);
        return { success: true, data: sessionData };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'ARCHIVE_RESTORE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.ARCHIVE_DELETE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ArchiveDeletePayloadSchema, payload, 'ARCHIVE_DELETE');
        const success = archiveManager.deleteArchivedSession(
          validated.archiveId,
        );
        return { success: true, data: { deleted: success } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'ARCHIVE_DELETE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.ARCHIVE_GET_META,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ArchiveGetMetaPayloadSchema, payload, 'ARCHIVE_GET_META');
        const meta = archiveManager.getArchivedSessionMeta(validated.archiveId);
        return { success: true, data: meta };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'ARCHIVE_GET_META_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.ARCHIVE_UPDATE_TAGS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ArchiveUpdateTagsPayloadSchema, payload, 'ARCHIVE_UPDATE_TAGS');
        const success = archiveManager.updateTags(
          validated.archiveId,
          validated.tags,
        );
        return { success: true, data: { updated: success } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'ARCHIVE_UPDATE_TAGS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.ARCHIVE_GET_STATS,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        validateIpcPayload(SessionHandlerEmptyPayloadSchema, payload, 'ARCHIVE_GET_STATS');
        const stats = archiveManager.getArchiveStats();
        return { success: true, data: stats };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'ARCHIVE_GET_STATS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.ARCHIVE_CLEANUP,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
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
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
