/**
 * Session-continuity state migration and conversation-history normalization.
 *
 * Extracted from `session-continuity.ts` so the manager stays inside its
 * LOC ceiling and these pure transforms stay independently testable.
 * Behaviour matches the previous in-class helpers.
 */

import { getLogger } from '../logging/logger';
import { isLegacyRedactedToolOutput } from './redacted-tool-output';
import type { ConversationEntry, SessionState } from './session-continuity.types';

const logger = getLogger('SessionContinuity');

export const CURRENT_SESSION_SCHEMA_VERSION = 2;

interface SessionMigration {
  fromVersion: number;
  toVersion: number;
  description: string;
  migrate: (state: Record<string, unknown>) => Record<string, unknown>;
}

const SESSION_MIGRATIONS: SessionMigration[] = [
  {
    fromVersion: 1,
    toVersion: 2,
    description: 'Add schemaVersion field to session state',
    migrate: (state) => ({ ...state, schemaVersion: 2 }),
  },
];

export function migrateSessionState(state: Record<string, unknown>): Record<string, unknown> {
  let version = (state['schemaVersion'] as number) || 1;
  let current = { ...state };

  for (const migration of SESSION_MIGRATIONS) {
    if (version === migration.fromVersion) {
      logger.info('Running session migration', {
        from: migration.fromVersion,
        to: migration.toVersion,
        description: migration.description,
      });
      current = migration.migrate(current);
      version = migration.toVersion;
    }
  }

  if (version !== CURRENT_SESSION_SCHEMA_VERSION) {
    logger.warn('Session state version mismatch after migration', {
      expected: CURRENT_SESSION_SCHEMA_VERSION,
      actual: version,
    });
  }

  return current;
}

/**
 * Newest-first id lookup. Re-emitted ids (streaming updates to the same
 * message) are almost always the tail entry, so scanning backwards makes the
 * common case O(1).
 */
export function findLastIndexById(entries: ConversationEntry[], id: string): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].id === id) return i;
  }
  return -1;
}

export function normalizeLookupIdentifier(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function getStateLookupKeys(
  state: Pick<SessionState, 'instanceId' | 'historyThreadId' | 'sessionId'>,
): string[] {
  const keys = new Set<string>();
  const addKey = (value: string | null | undefined): void => {
    const normalized = normalizeLookupIdentifier(value);
    if (normalized) {
      keys.add(normalized);
    }
  };

  addKey(state.instanceId);
  addKey(state.historyThreadId);
  addKey(state.sessionId);

  return Array.from(keys);
}

export function normalizeConversationEntryForPersistence(
  entry: ConversationEntry,
  redactToolOutputs: boolean,
): ConversationEntry | null {
  if (
    isLegacyRedactedToolOutput(entry.content)
    || (redactToolOutputs && entry.role === 'tool')
  ) {
    return null;
  }

  return { ...entry };
}

export function normalizeConversationHistory(
  entries: ConversationEntry[],
  redactToolOutputs: boolean,
): ConversationEntry[] {
  const normalized: ConversationEntry[] = [];
  const indexById = new Map<string, number>();

  for (const rawEntry of entries) {
    const entry = normalizeConversationEntryForPersistence(rawEntry, redactToolOutputs);
    if (!entry) {
      continue;
    }
    if (!entry.id) {
      normalized.push(entry);
      continue;
    }

    const existingIndex = indexById.get(entry.id);
    if (existingIndex !== undefined) {
      normalized[existingIndex] = entry;
      continue;
    }

    indexById.set(entry.id, normalized.length);
    normalized.push(entry);
  }

  return normalized;
}

export function normalizeStateForContinuity(
  state: SessionState,
  redactToolOutputs: boolean,
): SessionState {
  return {
    ...state,
    conversationHistory: normalizeConversationHistory(state.conversationHistory, redactToolOutputs),
  };
}

export function shouldRewriteNormalizedState(
  original: SessionState,
  normalized: SessionState,
): boolean {
  if (original.conversationHistory.length !== normalized.conversationHistory.length) {
    return true;
  }

  for (let i = 0; i < original.conversationHistory.length; i++) {
    const current = original.conversationHistory[i];
    const next = normalized.conversationHistory[i];
    if (
      !next
      || current.id !== next.id
      || current.role !== next.role
      || current.content !== next.content
      || current.timestamp !== next.timestamp
      || current.isCompacted !== next.isCompacted
    ) {
      return true;
    }
  }

  return false;
}
