/**
 * Archive IPC handlers.
 *
 * Extracted from `session-handlers.ts` so that file stays inside its LOC
 * ceiling. Behaviour matches the previous inline registrations.
 */

import type { IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';
import { IPC_CHANNELS } from '@contracts/channels';
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
import { registerValidatedIpcHandler } from '../validated-handler';

export interface RegisterSessionArchiveHandlersDeps {
  instanceManager: Pick<InstanceManager, 'getInstance'>;
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
}

export function registerSessionArchiveHandlers(deps: RegisterSessionArchiveHandlersDeps): void {
  const { instanceManager, ensureTrustedSender } = deps;
  const archiveManager = getSessionArchiveManager();

  const register = <T>(
    channel: string,
    schema: z.ZodSchema<T>,
    fn: (validated: T) => Promise<IpcResponse> | IpcResponse,
    errorCode: string,
  ): void => {
    registerValidatedIpcHandler(
      channel,
      schema,
      async (validated) => fn(validated),
      { ensureTrustedSender, errorCode },
    );
  };

  register(
    IPC_CHANNELS.ARCHIVE_SESSION,
    ArchiveSessionPayloadSchema,
    (validated) => {
      const instance = instanceManager.getInstance(validated.instanceId);
      if (!instance) {
        throw new Error(`Instance not found: ${validated.instanceId}`);
      }
      return { success: true, data: archiveManager.archiveSession(instance, validated.tags) };
    },
    'ARCHIVE_SESSION_FAILED',
  );

  register(
    IPC_CHANNELS.ARCHIVE_LIST,
    ArchiveListPayloadSchema,
    (validated) => {
      const filter = validated
        ? {
            beforeDate: validated.beforeDate,
            afterDate: validated.afterDate,
            tags: validated.tags,
            searchTerm: validated.searchTerm,
          }
        : undefined;
      return { success: true, data: archiveManager.listArchivedSessions(filter) };
    },
    'ARCHIVE_LIST_FAILED',
  );

  register(
    IPC_CHANNELS.ARCHIVE_SEARCH,
    ArchiveSearchPayloadSchema,
    (validated) => {
      const query = validated.query.trim();
      const archives = archiveManager
        .listArchivedSessions({
          searchTerm: query || undefined,
          tags: validated.options?.tags,
        })
        .slice(0, validated.options?.limit);
      return { success: true, data: archives };
    },
    'ARCHIVE_SEARCH_FAILED',
  );

  register(
    IPC_CHANNELS.ARCHIVE_RESTORE,
    ArchiveRestorePayloadSchema,
    (validated) => ({
      success: true,
      data: archiveManager.restoreSession(validated.archiveId),
    }),
    'ARCHIVE_RESTORE_FAILED',
  );

  register(
    IPC_CHANNELS.ARCHIVE_DELETE,
    ArchiveDeletePayloadSchema,
    (validated) => ({
      success: true,
      data: { deleted: archiveManager.deleteArchivedSession(validated.archiveId) },
    }),
    'ARCHIVE_DELETE_FAILED',
  );

  register(
    IPC_CHANNELS.ARCHIVE_GET_META,
    ArchiveGetMetaPayloadSchema,
    (validated) => ({
      success: true,
      data: archiveManager.getArchivedSessionMeta(validated.archiveId),
    }),
    'ARCHIVE_GET_META_FAILED',
  );

  register(
    IPC_CHANNELS.ARCHIVE_UPDATE_TAGS,
    ArchiveUpdateTagsPayloadSchema,
    (validated) => ({
      success: true,
      data: { updated: archiveManager.updateTags(validated.archiveId, validated.tags) },
    }),
    'ARCHIVE_UPDATE_TAGS_FAILED',
  );

  register(
    IPC_CHANNELS.ARCHIVE_GET_STATS,
    SessionHandlerEmptyPayloadSchema,
    () => ({ success: true, data: archiveManager.getArchiveStats() }),
    'ARCHIVE_GET_STATS_FAILED',
  );

  register(
    IPC_CHANNELS.ARCHIVE_CLEANUP,
    ArchiveCleanupPayloadSchema,
    (validated) => ({
      success: true,
      data: { deletedCount: archiveManager.cleanupOldArchives(validated.maxAgeDays) },
    }),
    'ARCHIVE_CLEANUP_FAILED',
  );
}
