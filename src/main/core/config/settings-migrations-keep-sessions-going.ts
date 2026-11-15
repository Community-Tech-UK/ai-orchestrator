import { getLogger } from '../../logging/logger';

const logger = getLogger('SettingsMigrations');
const KEEP_SESSIONS_GOING_MIGRATION_KEY = '__migration_keep_sessions_going_20261115';

interface MigrationStore {
  get(key: string): unknown;
  persistSetting(key: string, value: unknown): void;
  persistRawSetting(key: string, value: unknown): void;
}

/**
 * `keepSessionsGoing` replaces the boolean `autoAnswerContinueQuestions`. Someone who had switched the old
 * setting off keeps it off whatever the new default becomes; everyone else takes the default.
 */
export function migrateKeepSessionsGoing(store: MigrationStore): void {
  if (store.get(KEEP_SESSIONS_GOING_MIGRATION_KEY) === true) return;
  if (store.get('autoAnswerContinueQuestions') === false) {
    store.persistSetting('keepSessionsGoing', 'off');
    logger.info('Kept "Keep sessions going without me" off, as the setting it replaces was off');
  }
  store.persistRawSetting(KEEP_SESSIONS_GOING_MIGRATION_KEY, true);
}
