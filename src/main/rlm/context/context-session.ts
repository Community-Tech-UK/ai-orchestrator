/**
 * Context Session Module
 *
 * Handles RLM session lifecycle:
 * - Creating sessions
 * - Ending sessions
 * - Session statistics
 */

import type {
  ContextStore,
  RLMSession,
  RLMSessionStats
} from '../../../shared/types/rlm.types';
import type { RLMDatabase } from '../../persistence/rlm-database';
import { generateId } from './context.utils';
import { getLogger } from '../../logging/logger';

const logger = getLogger('ContextSession');

/**
 * Dependencies for session operations
 */
export interface SessionDependencies {
  db: RLMDatabase | null;
  persistenceEnabled: boolean;
}

/**
 * Start a new RLM session.
 *
 * @param store - Store to associate with the session
 * @param instanceId - Instance ID for the session
 * @param sessions - Map of sessions to add to
 * @param deps - Session dependencies
 * @returns New RLMSession
 */
export function startSession(
  store: ContextStore,
  instanceId: string,
  sessions: Map<string, RLMSession>,
  deps: SessionDependencies
): RLMSession {
  const session: RLMSession = {
    id: generateId('rlm'),
    storeId: store.id,
    instanceId,
    queries: [],
    recursiveCalls: [],
    totalRootTokens: 0,
    totalSubQueryTokens: 0,
    estimatedDirectTokens: store.totalTokens,
    tokenSavingsPercent: 0,
    startedAt: Date.now(),
    lastActivityAt: Date.now()
  };

  // Persist session to database
  if (deps.db && deps.persistenceEnabled) {
    try {
      deps.db.createSession({
        id: session.id,
        storeId: session.storeId,
        instanceId: session.instanceId,
        estimatedDirectTokens: session.estimatedDirectTokens
      });
    } catch (error) {
      logger.error('Failed to persist session', error instanceof Error ? error : undefined);
    }
  }

  sessions.set(session.id, session);
  return session;
}

/**
 * End an RLM session.
 *
 * @param sessionId - ID of session to end
 * @param sessions - Map of sessions
 * @param deps - Session dependencies
 * @returns Ended session or null if not found
 */
export function endSession(
  sessionId: string,
  sessions: Map<string, RLMSession>,
  deps: SessionDependencies
): RLMSession | null {
  const session = sessions.get(sessionId);
  if (!session) return null;

  // Mark session as ended in database
  if (deps.db && deps.persistenceEnabled) {
    try {
      deps.db.endSession(sessionId);
    } catch (error) {
      logger.error('Failed to end session in database', error instanceof Error ? error : undefined);
    }
  }

  sessions.delete(sessionId);
  return session;
}

/**
 * Update session after query execution.
 *
 * @param session - Session to update
 * @param store - Associated store
 * @param deps - Session dependencies
 */
export function updateSessionAfterQuery(
  session: RLMSession,
  store: ContextStore,
  deps: SessionDependencies
): void {
  // Persist session updates
  if (deps.db && deps.persistenceEnabled) {
    try {
      deps.db.updateSession(session.id, {
        totalQueries: session.queries.length,
        totalRootTokens: session.totalRootTokens,
        totalSubQueryTokens: session.totalSubQueryTokens,
        tokenSavingsPercent: session.tokenSavingsPercent,
        queriesJson: JSON.stringify(session.queries),
        recursiveCallsJson: JSON.stringify(session.recursiveCalls)
      });
      // Also update store access stats
      deps.db.updateStoreStats(store.id, {
        accessCount: store.accessCount
      });
    } catch (error) {
      logger.error('Failed to persist session update', error instanceof Error ? error : undefined);
    }
  }
}

/**
 * Calculate session statistics.
 *
 * @param session - Session to get stats for
 * @returns Session statistics or undefined if session not found
 */
export function getSessionStats(session: RLMSession): RLMSessionStats {
  const avgDuration =
    session.queries.length > 0
      ? session.queries.reduce((sum, q) => sum + q.duration, 0) /
        session.queries.length
      : 0;

  return {
    totalQueries: session.queries.length,
    totalRecursiveCalls: session.recursiveCalls.length,
    rootTokens: session.totalRootTokens,
    subQueryTokens: session.totalSubQueryTokens,
    estimatedSavings: session.tokenSavingsPercent,
    avgQueryDuration: avgDuration
  };
}

/**
 * Update token tracking and savings calculation for a session.
 *
 * @param session - Session to update
 * @param tokensUsed - Tokens used in the query
 * @param depth - Query depth (0 = root, >0 = sub-query)
 */
export function updateSessionTokens(
  session: RLMSession,
  tokensUsed: number,
  depth: number
): void {
  if (depth === 0) {
    session.totalRootTokens += tokensUsed;
  } else {
    session.totalSubQueryTokens += tokensUsed;
  }

  const totalUsed = session.totalRootTokens + session.totalSubQueryTokens;
  session.tokenSavingsPercent = Math.max(
    0,
    ((session.estimatedDirectTokens - totalUsed) /
      session.estimatedDirectTokens) *
      100
  );

  session.lastActivityAt = Date.now();
}
