/**
 * Token Stats IPC Handlers
 *
 * Provides query access to the token stats service over IPC.
 * UI integration can be added later; these handlers expose the data layer.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import { getTokenStatsService } from '../memory/token-stats';
import { getRLMDatabase } from '../persistence/rlm-database';
import { getLogger } from '../logging/logger';

const logger = getLogger('TokenStatsIpc');

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
        const opts = (payload && typeof payload === 'object') ? payload as Record<string, unknown> : {};
        return service.getSummary({
          instanceId: typeof opts['instanceId'] === 'string' ? opts['instanceId'] : undefined,
          since: typeof opts['since'] === 'number' ? opts['since'] : undefined,
          until: typeof opts['until'] === 'number' ? opts['until'] : undefined,
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
        const opts = (payload && typeof payload === 'object') ? payload as Record<string, unknown> : {};
        return service.getRecent({
          instanceId: typeof opts['instanceId'] === 'string' ? opts['instanceId'] : undefined,
          limit: typeof opts['limit'] === 'number' ? opts['limit'] : undefined,
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
        const opts = (payload && typeof payload === 'object') ? payload as Record<string, unknown> : {};
        const olderThanMs = typeof opts['olderThanMs'] === 'number'
          ? opts['olderThanMs']
          : 7 * 24 * 60 * 60 * 1000; // default: 7 days
        return { deleted: service.cleanup(olderThanMs) };
      } catch (err) {
        logger.warn('TOKEN_STATS_CLEANUP failed', { error: String(err) });
        return { deleted: 0 };
      }
    }
  );

  logger.info('Token stats IPC handlers registered');
}
