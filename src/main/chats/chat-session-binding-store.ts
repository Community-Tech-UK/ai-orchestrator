import type { SqliteDriver } from '../db/sqlite-driver';

/**
 * Persisted record of a chat's active provider session — the "session = cache
 * bound to the thread" binding (§4.2 of the unified-conversation-continuity
 * plan). The ledger is the single source of truth; this binding records which
 * opaque provider session currently *caches* that thread's context, plus enough
 * metadata to decide (§5.1) whether native `--resume` is still a safe fast path
 * or whether context must be deterministically rebuilt from the ledger.
 *
 * Fields:
 * - `provider` / `sessionId` — the bound session's identity (rule 1: provider
 *   match; rule 2: session-replaced detection against the live instance).
 * - `lineageEpoch` — bumped whenever an event could desync the provider
 *   transcript from the ledger (e.g. a loop that ran in a non-bound session).
 * - `needsRebuild` — the durable "epoch advanced past the bound session" flag
 *   (rule 3). Set when a loop terminates in a session the interactive model
 *   never saw; cleared once the next send has rebuilt + rebound.
 * - `lastTurnNativeId` — the ledger-tail reconciliation marker (rule 4): the
 *   nativeMessageId of the last turn the bound session is known to have seen.
 * - `lastValidatedAt` — when the binding last passed the lineage check.
 */
export interface ChatSessionBinding {
  chatId: string;
  provider: string | null;
  sessionId: string | null;
  lineageEpoch: number;
  needsRebuild: boolean;
  lastTurnNativeId: string | null;
  lastValidatedAt: number | null;
  updatedAt: number;
}

interface BindingRow {
  chat_id: string;
  provider: string | null;
  session_id: string | null;
  lineage_epoch: number;
  needs_rebuild: number;
  last_turn_native_id: string | null;
  last_validated_at: number | null;
  updated_at: number;
}

function rowToBinding(row: BindingRow): ChatSessionBinding {
  return {
    chatId: row.chat_id,
    provider: row.provider,
    sessionId: row.session_id,
    lineageEpoch: row.lineage_epoch,
    needsRebuild: row.needs_rebuild !== 0,
    lastTurnNativeId: row.last_turn_native_id,
    lastValidatedAt: row.last_validated_at,
    updatedAt: row.updated_at,
  };
}

/** Context for the §5.1 lineage-validity decision, gathered at send time. */
export interface LineageContext {
  /** Provider of the turn about to be sent. */
  requestedProvider: string;
  /** Session id of the live instance the turn will be routed through (may be
   *  empty before the CLI has assigned one). */
  liveSessionId: string;
  /** True when `ensureRuntime` just spawned a brand-new instance — its opaque
   *  session has zero memory of the chat, so lineage is definitionally broken. */
  isFresh: boolean;
  /** Whether `binding.lastTurnNativeId` (if set) still resolves in the ledger —
   *  catches a ledger that was rewritten out from under the bound session. */
  lastTurnStillInLedger: boolean;
}

export interface LineageVerdict {
  valid: boolean;
  /** Machine-usable reason; `'ok'` when valid. */
  reason:
    | 'ok'
    | 'no-binding'
    | 'fresh-session'
    | 'loop-divergence'
    | 'provider-changed'
    | 'session-replaced'
    | 'ledger-tail-mismatch';
}

/**
 * The §5.1 fast-path predicate, as a pure function so it can be unit-tested
 * without a database. A bound session is a valid native-resume fast path **iff
 * all** rules hold; conservative by default — any doubt ⇒ invalid ⇒ rebuild.
 */
export function evaluateLineage(
  binding: ChatSessionBinding | null,
  ctx: LineageContext,
): LineageVerdict {
  // A freshly-spawned instance never shares lineage with the prior session.
  if (ctx.isFresh) {
    return { valid: false, reason: 'fresh-session' };
  }
  if (!binding) {
    return { valid: false, reason: 'no-binding' };
  }
  // Rule 3: epoch advanced past the bound session (e.g. a forked loop).
  if (binding.needsRebuild) {
    return { valid: false, reason: 'loop-divergence' };
  }
  // Rule 1: same provider.
  if (binding.provider && binding.provider !== ctx.requestedProvider) {
    return { valid: false, reason: 'provider-changed' };
  }
  // Rule 2: the live session must not contradict the bound one. We only
  // invalidate on a positive contradiction (both ids known and different) — an
  // as-yet-unknown live session id is treated as "unconfirmed", not "invalid",
  // so we don't force a redundant rebuild before the CLI has assigned a session.
  if (binding.sessionId && ctx.liveSessionId && binding.sessionId !== ctx.liveSessionId) {
    return { valid: false, reason: 'session-replaced' };
  }
  // Rule 4: ledger-tail reconciliation marker still resolvable.
  if (binding.lastTurnNativeId && !ctx.lastTurnStillInLedger) {
    return { valid: false, reason: 'ledger-tail-mismatch' };
  }
  return { valid: true, reason: 'ok' };
}

export class ChatSessionBindingStore {
  constructor(private readonly db: SqliteDriver) {}

  get(chatId: string): ChatSessionBinding | null {
    const row = this.db.prepare(
      'SELECT * FROM chat_session_bindings WHERE chat_id = ?',
    ).get<BindingRow>(chatId);
    return row ? rowToBinding(row) : null;
  }

  /**
   * Mark this chat as needing a ledger rebuild on the next send, and bump the
   * lineage epoch. Called when a loop terminates in a session that was NOT the
   * chat's live interactive session, so the interactive model didn't see the
   * loop's turns.
   *
   * Creates a row if none exists (first loop on this chat).
   */
  markNeedsRebuild(chatId: string): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO chat_session_bindings (chat_id, provider, session_id, lineage_epoch, needs_rebuild, updated_at)
      VALUES (?, NULL, NULL, 1, 1, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        needs_rebuild = 1,
        lineage_epoch = lineage_epoch + 1,
        updated_at = excluded.updated_at
    `).run(chatId, now);
  }

  /**
   * Record that the chat's context now lives in `{provider, sessionId}` and is
   * reconciled with the ledger up to `lastTurnNativeId`. Clears the rebuild flag
   * and stamps `last_validated_at`. Called after a send is dispatched so the
   * NEXT turn can take the native-resume fast path (§5.1) instead of rebuilding.
   */
  recordValidSession(input: {
    chatId: string;
    provider: string;
    sessionId: string;
    lastTurnNativeId: string | null;
  }): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO chat_session_bindings (
        chat_id, provider, session_id, lineage_epoch, needs_rebuild,
        last_turn_native_id, last_validated_at, updated_at
      )
      VALUES (?, ?, ?, 0, 0, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        provider = excluded.provider,
        session_id = excluded.session_id,
        needs_rebuild = 0,
        last_turn_native_id = excluded.last_turn_native_id,
        last_validated_at = excluded.last_validated_at,
        updated_at = excluded.updated_at
    `).run(
      input.chatId,
      input.provider,
      input.sessionId,
      input.lastTurnNativeId,
      now,
      now,
    );
  }
}
