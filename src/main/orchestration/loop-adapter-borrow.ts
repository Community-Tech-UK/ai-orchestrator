/**
 * Adapter selection for a loop iteration (LT-020 / LT-030).
 *
 * Extracted from `default-invokers.ts` because the borrow decision and the loan
 * claim are one indivisible unit: the decision reads the instance's live
 * adapter, and the claim must be taken on the same tick so a runtime change
 * cannot interleave between them. Keeping them in one small function makes that
 * invariant enforceable by inspection rather than by comment.
 *
 * Adapter selection priority for an iteration:
 *   1. The parent instance's existing adapter, only for providers whose session
 *      model is safe to borrow. This preserves Claude's "continue this chat"
 *      behavior while avoiding Codex inheriting a stale external rollout/thread
 *      id from the visible chat.
 *   2. A `same-session` persistent loop adapter — the pre-fix legacy path for
 *      loops with no parent instance (chat-detail loops where the chat has no
 *      live runtime; pure-workspace loops). Owned by the calling listener.
 *   3. A fresh per-iteration adapter (the explicit fresh-child path inside
 *      `invokeCliTextResponse`).
 *
 * This module resolves 1 only. 2 and 3 remain the caller's business.
 */

import { beginAdapterLoan, waitForRuntimeChange, type AdapterLoan } from '../instance/lifecycle/adapter-loan-registry';
import type { LoopProvider } from '../../shared/types/loop.types';
import {
  canBorrowParentLoopAdapter,
  liveAdapterMatchesRequestedModel,
} from './loop-branch-selector-helpers';

/**
 * The parent instance, as far as this decision and its callers care.
 *
 * Structural on purpose: the caller also feeds it to the loop-output evidence
 * builder, which reads only the two session-identity fields.
 */
export interface BorrowableInstance {
  provider?: string;
  currentModel?: unknown;
  contextEvidence?: { conversationId?: string };
  providerSessionId?: string;
}

/**
 * The subset of `InstanceManager` this decision needs.
 *
 * Both members are optional because tests pass a stub manager without them;
 * production `InstanceManager` always has both.
 */
export interface BorrowInstanceManager {
  getInstance?: (id: string) => BorrowableInstance | undefined;
  getAdapter?: (id: string) => unknown;
}

export interface BorrowRequest {
  readonly chatId: string;
  readonly loopRunId: string;
  readonly provider: LoopProvider;
  readonly model: string | undefined;
  readonly workspaceCwd: string | undefined;
  readonly executionCwd: string | undefined;
  /** Resolved strategy — the caller applies the `same-session` default. */
  readonly contextStrategy: string;
}

export interface BorrowDecision {
  /** The borrowed adapter, or `undefined` when the caller must supply its own. */
  readonly reusedAdapter: unknown | undefined;
  readonly borrowedFromInstance: boolean;
  /** Held for the whole iteration; the caller must release it in a `finally`. */
  readonly adapterLoan: AdapterLoan | undefined;
  /**
   * The parent instance as read for the decision, `undefined` when there is no
   * live runtime. Returned so the caller can attach session-identity evidence
   * without a second, possibly-diverged read.
   */
  readonly liveInstance: BorrowableInstance | undefined;
}

function isBaseCliAdapterLike(adapter: unknown): boolean {
  return typeof (adapter as { sendMessage?: unknown } | undefined)?.sendMessage === 'function';
}

/**
 * Decide whether this iteration borrows the parent instance's adapter, and
 * claim the loan if it does.
 *
 * The `waitForRuntimeChange` await is deliberately the FIRST thing that
 * happens: everything after it — the instance read through to
 * `beginAdapterLoan` — is synchronous, so the borrow decision and the claim
 * cannot be interleaved by a runtime change landing in between.
 */
export async function decideAdapterBorrow(
  instanceManager: BorrowInstanceManager,
  p: BorrowRequest,
): Promise<BorrowDecision> {
  const sameSession = p.contextStrategy === 'same-session';

  // LT-030: if a runtime change is mid-flight, wait before touching the adapter
  // — otherwise the loop can take an active turn on it while the reconciler is
  // still terminating/respawning or delivering its notices. (A cross-provider
  // swap can't be reclaimed anyway — the borrow gate requires claude on both
  // sides — so this mainly covers same-provider changes and the respawn
  // window.) Bounded, so a stuck reconciler degrades to the old behaviour
  // instead of stalling the loop.
  if (sameSession) await waitForRuntimeChange(p.chatId);

  const liveInstance = instanceManager.getInstance?.(p.chatId);
  const liveAdapter = liveInstance ? instanceManager.getAdapter?.(p.chatId) : undefined;

  // Borrow same-session loops into the chat's live adapter; skip worktree isolation.
  const borrowedFromInstance = Boolean(
    sameSession &&
    !(p.executionCwd && p.executionCwd !== p.workspaceCwd) &&
    liveAdapter &&
    canBorrowParentLoopAdapter(p.provider, liveInstance?.provider) &&
    liveAdapterMatchesRequestedModel(liveInstance?.currentModel, p.model) &&
    isBaseCliAdapterLike(liveAdapter),
  );

  // LT-020: claim the loan the moment the borrow is decided, not just before
  // the CLI call. Between the two sits `recyclePersistentLoopAdapter`, and a
  // swap applying in that window respawns the instance and leaves the reused
  // adapter pointing at a terminated process.
  return {
    reusedAdapter: borrowedFromInstance ? liveAdapter : undefined,
    borrowedFromInstance,
    adapterLoan: borrowedFromInstance ? beginAdapterLoan(p.chatId, p.loopRunId) : undefined,
    liveInstance,
  };
}
