/**
 * Token Stats IPC Handlers
 *
 * Provides query access to the token stats service over IPC.
 * UI integration can be added later; these handlers expose the data layer.
 */

import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import { getTokenStatsService } from '../memory/token-stats';
import { getRLMDatabase } from '../persistence/rlm-database';
import { getLogger } from '../logging/logger';

const logger = getLogger('TokenStatsIpc');

const TokenStatsSummaryPayloadSchema = z
  .object({
    instanceId: z.string().min(1).max(200).optional(),
    since: z.number().int().min(0).optional(),
    until: z.number().int().min(0).optional(),
  })
  .partial()
  .optional();

const TokenStatsRecentPayloadSchema = z
  .object({
    instanceId: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(10_000).optional(),
  })
  .partial()
  .optional();

const TokenStatsCleanupPayloadSchema = z
  .object({
    olderThanMs: z.number().int().min(0).optional(),
  })
  .partial()
  .optional();

/**
 * Register all token stats IPC handlers.
 * Also wires the RLM database connection into the token stats service so it
 * can persist data. Degrades gracefully if the RLM database is not available.
 */
export function registerTokenStatsHandlers(): void {
  // Wire up the RLM database connection (best-effort)
  try {
    const rlm = getRLMDatabase();
    getTokenStatsService(rlm.getRawDb());
  } catch (err) {
    logger.warn('Could not wire RLM database to TokenStatsService — stats will be skipped', { error: String(err) });
  }

  const service = getTokenStatsService();

  // Get summary stats
  ipcMain.handle(
    IPC_CHANNELS.TOKEN_STATS_GET_SUMMARY,
    (_event, payload: unknown) => {
      try {
        const opts = TokenStatsSummaryPayloadSchema.parse(payload) ?? {};
        return service.getSummary({
          instanceId: opts.instanceId,
          since: opts.since,
          until: opts.until,
        });
      } catch (err) {
        logger.warn('TOKEN_STATS_GET_SUMMARY failed', { error: String(err) });
        return null;
      }
    }
  );

  // Get recent entries
  ipcMain.handle(
    IPC_CHANNELS.TOKEN_STATS_GET_RECENT,
    (_event, payload: unknown) => {
      try {
        const opts = TokenStatsRecentPayloadSchema.parse(payload) ?? {};
        return service.getRecent({
          instanceId: opts.instanceId,
          limit: opts.limit,
        });
      } catch (err) {
        logger.warn('TOKEN_STATS_GET_RECENT failed', { error: String(err) });
        return [];
      }
    }
  );

  // Cleanup old stats
  ipcMain.handle(
    IPC_CHANNELS.TOKEN_STATS_CLEANUP,
    (_event, payload: unknown) => {
      try {
        const opts = TokenStatsCleanupPayloadSchema.parse(payload) ?? {};
        const olderThanMs = opts.olderThanMs ?? 7 * 24 * 60 * 60 * 1000;
        return { deleted: service.cleanup(olderThanMs) };
      } catch (err) {
        logger.warn('TOKEN_STATS_CLEANUP failed', { error: String(err) });
        return { deleted: 0 };
      }
    }
  );

  logger.info('Token stats IPC handlers registered');
}
