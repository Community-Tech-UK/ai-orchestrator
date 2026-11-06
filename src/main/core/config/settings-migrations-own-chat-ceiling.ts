/**
 * Sets the 300,000-token context ceiling for James's own Claude chats, but only
 * when a recall check says summarising at that size does not lose the thread.
 *
 * Changing the default alone would not reach an install that already stored 0, so
 * a marker-guarded migration is needed. Unlike the other migrations it is a strict
 * no-op until a passing check is compiled in: the evidence is judged FIRST, and with
 * none recorded, or one that fails the rule, nothing is read from or written to the
 * store beyond the marker lookup. Not even the marker is written, so a later release
 * that ships a passing check still gets its chance. Once a check passes:
 *
 *  - a value the user chose (anything above 0) is kept, and the marker is written so
 *    the migration never looks at it again;
 *  - otherwise 300,000 is set and the marker is written.
 *
 * `machineContextCeilingTokens` is never touched: the cap does not apply to helpers.
 * Split out of settings-migrations.ts, like the provider-account migrations.
 */

import { evaluateRecallEvidence } from '../../context/recall-replay/recall-evidence';
import { getLogger } from '../../logging/logger';
import { OWN_CHAT_CEILING_RECALL_EVIDENCE } from './own-chat-ceiling-recall-evidence';
import type { SettingsMigrationStore } from './settings-migrations';

const logger = getLogger('OwnChatCeilingMigration');

export const OWN_CHAT_CEILING_MIGRATION_KEY = '__migration_own_chat_context_ceiling_300k_20261021';
export const OWN_CHAT_CEILING_TOKENS = 300_000;

export type OwnChatCeilingOutcome =
  | { result: 'applied' }
  | { result: 'already-done' }
  | { result: 'user-value-kept'; value: number }
  | { result: 'not-eligible'; reason: string };

export interface OwnChatCeilingMigrationDeps {
  /** Defaults to the evidence compiled into the app. */
  evidence?: unknown;
  now?: () => Date;
}

export function migrateOwnChatContextCeiling(store: SettingsMigrationStore, deps: OwnChatCeilingMigrationDeps = {}): OwnChatCeilingOutcome {
  if (store.get(OWN_CHAT_CEILING_MIGRATION_KEY) === true) return { result: 'already-done' };

  const verdict = evaluateRecallEvidence('evidence' in deps ? deps.evidence : OWN_CHAT_CEILING_RECALL_EVIDENCE, (deps.now ?? (() => new Date()))());
  if (!verdict.eligible) {
    // Quiet on purpose: this is the normal state of every launch until a check passes.
    logger.debug('Own-chat context ceiling left off: recall check not satisfied', { reason: verdict.reason });
    return { result: 'not-eligible', reason: verdict.reason };
  }

  const stored = store.get('ownChatContextCeilingTokens');
  if (typeof stored === 'number' && Number.isFinite(stored) && stored > 0) {
    store.persistRawSetting(OWN_CHAT_CEILING_MIGRATION_KEY, true);
    return { result: 'user-value-kept', value: stored };
  }

  logger.info('Setting the own-chat context ceiling', { tokens: OWN_CHAT_CEILING_TOKENS });
  store.persistSetting('ownChatContextCeilingTokens', OWN_CHAT_CEILING_TOKENS);
  store.persistRawSetting(OWN_CHAT_CEILING_MIGRATION_KEY, true);
  return { result: 'applied' };
}
