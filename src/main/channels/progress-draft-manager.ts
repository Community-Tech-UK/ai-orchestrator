/**
 * progress-draft-manager.ts
 *
 * Lifecycle for WS-C8 editable channel progress drafts: one bounded evolving
 * "Working…" message per task (keyed by the caller — the router uses
 * `platform:chatId:instanceId`), created only once a task has run long
 * enough to be worth narrating, edited in place at a bounded rate as status
 * updates arrive, and collapsed to a one-line receipt at completion/failure.
 *
 * Edit-capability gating (only call this for `adapter.supportsMessageEditing()
 * === true`) and the ordering guarantee ("collapse the draft immediately
 * before the final answer message goes out") are the caller's responsibility
 * — see `channel-message-router.ts`. This module only owns per-draft state
 * and serializes its adapter calls so a completion racing an in-flight edit
 * always finishes last (the final state always wins).
 *
 * A channel that can't edit messages should never call into this module: a
 * short task or a non-edit channel gets no draft at all, which is calmer
 * than falling back to a fresh-message stack.
 */

import { getLogger } from '../logging/logger';
import {
  composeProgressDraftReceipt,
  composeProgressDraftText,
  normalizeProgressDraftDetail,
  shouldCreateProgressDraft,
  shouldEmitProgressDraftUpdate,
  type ProgressDraftOutcome,
} from './progress-draft-compositor';

const logger = getLogger('ProgressDraftManager');

/**
 * The subset of `BaseChannelAdapter` this module needs, kept narrow so unit
 * tests don't need a full adapter (or the real `SendOptions`/`SentMessage`
 * shapes — `BaseChannelAdapter` structurally satisfies this).
 */
export interface ProgressDraftChannel {
  sendMessage(
    chatId: string,
    content: string,
    options?: { replyTo?: string },
  ): Promise<{ messageId: string }>;
  editMessage(chatId: string, messageId: string, content: string): Promise<void>;
}

export interface ReportProgressParams {
  /** Stable per-task key — one draft per key. */
  key: string;
  chatId: string;
  replyToMessageId: string;
  /** Wall-clock ms when the task/turn started (drives elapsed time + the creation-delay gate). */
  taskStartedAt: number;
  /** Latest status line (e.g. "Running Bash…"). Redacted by the compositor before it ever leaves this module. */
  detail?: string;
  now?: number;
}

interface DraftState {
  chatId: string;
  replyToMessageId: string;
  startedAt: number;
  messageId?: string;
  creating: boolean;
  finalized: boolean;
  editingDisabled: boolean;
  /** Normalized (redacted) detail last drafted — compared against, NOT the fully-rendered text (whose header elapsed time changes every call). */
  lastDetail?: string;
  lastEditAt: number;
  /** Serializes every adapter call for this draft. */
  chain: Promise<void>;
}

export class ProgressDraftManager {
  private readonly drafts = new Map<string, DraftState>();

  /**
   * Report a status update for a task. Before the creation delay elapses this
   * only records intent (no channel call, so a short task never gets a
   * message); once elapsed, it creates the draft on first call and edits it
   * thereafter, subject to the compositor's rate limit.
   */
  reportProgress(params: ReportProgressParams, adapter: ProgressDraftChannel): void {
    const now = params.now ?? Date.now();
    let existing = this.drafts.get(params.key);
    // A prior turn's draft may still be finalized-but-not-yet-deleted (its
    // own `complete()` call is still awaiting the tail of its promise chain)
    // when a new turn on the same key starts reporting progress. Treat that
    // the same as "no draft" rather than silently dropping the new turn's
    // updates — the old draft's own in-flight completion is unaffected since
    // it holds its own reference to its `DraftState`, independent of this map.
    if (!existing || existing.finalized) {
      existing = {
        chatId: params.chatId,
        replyToMessageId: params.replyToMessageId,
        startedAt: params.taskStartedAt,
        creating: false,
        finalized: false,
        editingDisabled: false,
        lastEditAt: 0,
        chain: Promise.resolve(),
      };
      this.drafts.set(params.key, existing);
    }
    const draft = existing;

    const elapsedMs = now - draft.startedAt;

    if (!draft.messageId) {
      if (draft.creating || !shouldCreateProgressDraft(elapsedMs)) return;
      draft.creating = true;
      const text = composeProgressDraftText({ detail: params.detail, elapsedMs });
      draft.lastDetail = normalizeProgressDraftDetail(params.detail);
      draft.lastEditAt = now;
      draft.chain = draft.chain.then(async () => {
        try {
          const sent = await adapter.sendMessage(draft.chatId, text, { replyTo: draft.replyToMessageId });
          draft.messageId = sent.messageId;
        } catch (err) {
          logger.warn('Progress draft creation failed', { key: params.key, error: String(err) });
        } finally {
          draft.creating = false;
        }
      });
      return;
    }

    if (draft.editingDisabled) return;
    const normalizedDetail = normalizeProgressDraftDetail(params.detail);
    const previous = draft.lastDetail !== undefined
      ? { content: draft.lastDetail, editedAt: draft.lastEditAt }
      : undefined;
    if (!shouldEmitProgressDraftUpdate(previous, normalizedDetail, now)) return;

    const text = composeProgressDraftText({ detail: params.detail, elapsedMs });
    draft.lastDetail = normalizedDetail;
    draft.lastEditAt = now;
    draft.chain = draft.chain.then(async () => {
      // A completion may have raced this edit and finalized the draft while
      // it sat queued behind an earlier in-flight call — skip so the
      // collapsed receipt (queued after this in the same chain) is always
      // the last write, never overwritten by a stale progress line.
      if (draft.finalized) return;
      try {
        await adapter.editMessage(draft.chatId, draft.messageId!, text);
      } catch (err) {
        draft.editingDisabled = true;
        logger.warn('Progress draft edit failed; no further edits will be attempted', {
          key: params.key,
          error: String(err),
        });
      }
    });
  }

  /**
   * Collapse the draft to a one-line receipt (or drop it if it was never
   * created — a short task never had a message to collapse). Resolves once
   * the collapse edit attempt has settled, so callers can sequence the real
   * reply after it. Safe to call for a key with no active draft (no-op).
   */
  async complete(
    key: string,
    adapter: ProgressDraftChannel,
    outcome: ProgressDraftOutcome,
    now: number = Date.now(),
  ): Promise<void> {
    const draft = this.drafts.get(key);
    if (!draft) return;
    draft.finalized = true;
    const elapsedMs = now - draft.startedAt;

    const finish = async (): Promise<void> => {
      if (!draft.messageId) return;
      const text = composeProgressDraftReceipt(elapsedMs, outcome);
      try {
        await adapter.editMessage(draft.chatId, draft.messageId, text);
      } catch (err) {
        logger.warn('Progress draft collapse edit failed', { key, error: String(err) });
      }
    };

    const settled = draft.chain.then(finish);
    draft.chain = settled;
    await settled;
    // Only remove this exact draft — a new turn on the same key may already
    // have replaced the map entry with a fresh (non-finalized) DraftState
    // while this collapse was still in flight; don't clobber it.
    if (this.drafts.get(key) === draft) {
      this.drafts.delete(key);
    }
  }

  /** Whether a task key currently has draft state tracked. Test/diagnostic seam. */
  hasDraft(key: string): boolean {
    return this.drafts.has(key);
  }
}

/**
 * Loosely-typed capability check so this module's wiring helpers can accept
 * any object shaped like `BaseChannelAdapter` (avoiding an import of the
 * class just for a type) and so plain test doubles that omit the method are
 * treated as "no", not a runtime error.
 */
export interface ChannelEditCapability {
  supportsMessageEditing?: () => boolean;
}

export function channelSupportsMessageEditing(adapter: ChannelEditCapability): boolean {
  return typeof adapter.supportsMessageEditing === 'function' && adapter.supportsMessageEditing();
}

export interface ChannelToolProgressParams {
  key: string;
  chatId: string;
  replyToMessageId: string;
  taskStartedAt: number;
  toolName?: string;
  now?: number;
}

/**
 * Router wiring seam for the tool-activity heartbeat: on an edit-capable
 * channel, feed the update into the draft manager instead of posting a fresh
 * message. Returns `true` when handled this way (the caller must NOT also
 * send its legacy heartbeat message); `false` when the adapter can't edit
 * messages, so the caller should fall back to its existing
 * `sendMessage`-based heartbeat — non-edit channels keep today's behaviour
 * exactly.
 */
export function reportChannelToolProgress(
  manager: ProgressDraftManager,
  adapter: ProgressDraftChannel & ChannelEditCapability,
  params: ChannelToolProgressParams,
): boolean {
  if (!channelSupportsMessageEditing(adapter)) return false;
  manager.reportProgress(
    {
      key: params.key,
      chatId: params.chatId,
      replyToMessageId: params.replyToMessageId,
      taskStartedAt: params.taskStartedAt,
      detail: params.toolName ? `Running ${params.toolName}…` : undefined,
      now: params.now,
    },
    adapter,
  );
  return true;
}

/**
 * Router wiring seam for turn completion: collapse the draft (if any) to its
 * receipt. Callers must await/sequence this before sending the real final
 * answer message so the channel always shows the calm receipt edit first.
 * Resolves immediately (no-op) on a non-edit adapter or a task that never
 * created a draft.
 */
export function collapseChannelProgressDraft(
  manager: ProgressDraftManager,
  adapter: ProgressDraftChannel & ChannelEditCapability,
  key: string,
  finalStatus: string | null,
): Promise<void> {
  if (!channelSupportsMessageEditing(adapter)) return Promise.resolve();
  const outcome: ProgressDraftOutcome =
    finalStatus === 'idle' || finalStatus === 'waiting_for_input' ? 'success' : 'failure';
  return manager.complete(key, adapter, outcome);
}
