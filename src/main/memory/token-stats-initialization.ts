import { getLogger } from '../logging/logger';
import { getRLMDatabase } from '../persistence/rlm-database';
import { getTokenStatsService } from './token-stats';

const logger = getLogger('TokenStatsInitialization');

/** Connect token-stat recording to the shared RLM database when available. */
export function initializeTokenStatsPersistence(): void {
  try {
    const rlm = getRLMDatabase();
    getTokenStatsService(rlm.getRawDb());
  } catch (error) {
    logger.warn('Could not wire RLM database to TokenStatsService — stats will be skipped', {
      error: String(error),
    });
  }
}
