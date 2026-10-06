import { createHash, randomUUID } from 'node:crypto';
import type { ChatSendMessageInput } from '../../shared/types/chat.types';
import type { ParentContextSnapshot } from '../../shared/types/side-chat.types';
import { getLogger } from '../logging/logger';
import {
  buildParentContextSnapshot,
  formatSnapshotDelivery,
  type BuildParentContextOptions,
} from './side-chat-context';
import type { SideChatContextStore, StoredContextSnapshot } from './side-chat-context-store';
import {
  ParentUnavailableError,
  type SideChatParentResolver,
} from './side-chat-parent-resolver';
import type { SideChatLinkStore } from './side-chat-link-store';
import type { SideChatLink } from '../../shared/types/side-chat.types';

const logger = getLogger('SideChatSendCoordinator');

export type SideChatSendFailureCode =
  | 'not-linked'
  | 'parent-unavailable'
  | 'context-unavailable'
  | 'unavailable-permissions'
  | 'provider-unavailable'
  | 'busy'
  | 'send-failed';

export interface SideChatSendFailure {
  ok: false;
  code: SideChatSendFailureCode;
  error: string;
  /** Whether a previous snapshot can be used via `allowStaleContext`. */
  lastSnapshotAvailable: boolean;
}

export type SideChatSendResult =
  | {
      ok: true;
      deliveredRevision: string;
      usedStaleContext: boolean;
    }
  | SideChatSendFailure;

export interface SideChatSendDeps {
  resolver: Pick<SideChatParentResolver, 'resolve'>;
  contextStore: Pick<SideChatContextStore, 'get' | 'put'>;
  linkStore: Pick<SideChatLinkStore, 'get'>;
  /**
   * Authority and runtime preflight run before any context capture or ledger
   * write: inherited permissions, provider capability and policy-change
   * runtime replacement. A returned failure aborts the send.
   */
  preflight: (chatId: string, link: SideChatLink) => Promise<SideChatSendFailure | null>;
  /**
   * Dispatch the user's question through the ordinary chat send path. Called
   * only after the parent snapshot has been resolved and persisted, so a
   * snapshot failure never creates a user turn at all. `userTurnId` is the
   * ledger turn id for the question; a retry of a failed dispatch passes the
   * same id so the ledger updates that turn in place instead of adding a copy.
   */
  dispatchSend: (input: ChatSendMessageInput, userTurnId: string) => Promise<void>;
  buildOptions?: (chatId: string) => Promise<BuildParentContextOptions>;
}

/**
 * Serializes sidechat sends and captures refreshed parent context before each
 * user question.
 *
 * Per-chat serialization means concurrent sends cannot interleave. Snapshot
 * acquisition happens before any ledger mutation: if it fails the caller gets
 * an explicit error and can opt into the last captured snapshot, instead of
 * silently sending a context-free question. A dispatch can fail after the
 * question reached the ledger (runtime spawn or input delivery failed), so the
 * failed turn's id is kept and an identical retry reuses it — the retried
 * question replaces the failed one rather than appearing twice in the
 * transcript and in the next runtime rebuild.
 *
 * Delivery is tracked per runtime instance ({@link contextForTurn}), so a new
 * runtime (provider switch, restart, policy change) always receives the latest
 * effective snapshot, while an unchanged revision is not resent to a runtime
 * that already has it.
 */
export class SideChatSendCoordinator {
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Revision last delivered to each live runtime instance. */
  private readonly deliveredRevision = new Map<string, string>();
  /** Sidechats whose pending delivery is an explicitly accepted stale snapshot. */
  private readonly staleDelivery = new Set<string>();
  /** The user turn of each sidechat's last failed dispatch, reused by a retry. */
  private readonly failedTurns = new Map<string, { turnId: string; key: string }>();

  constructor(private readonly deps: SideChatSendDeps) {}

  async send(
    input: ChatSendMessageInput,
    options: { allowStaleContext?: boolean } = {},
  ): Promise<SideChatSendResult> {
    const chatId = input.chatId;
    const previous = this.locks.get(chatId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.sendLocked(input, options));
    const settled = run.finally(() => {
      if (this.locks.get(chatId) === tail) {
        this.locks.delete(chatId);
      }
    });
    const tail = settled.catch(() => undefined);
    this.locks.set(chatId, tail);
    return run;
  }

  private async sendLocked(
    input: ChatSendMessageInput,
    options: { allowStaleContext?: boolean },
  ): Promise<SideChatSendResult> {
    const chatId = input.chatId;
    const previousSnapshot = this.deps.contextStore.get(chatId);
    const link = this.deps.linkStore.get(chatId);
    if (!link) {
      return failure('not-linked', 'This chat is not linked to a parent session', previousSnapshot);
    }

    const blocked = await this.deps.preflight(chatId, link);
    if (blocked) {
      return blocked;
    }

    let snapshot: ParentContextSnapshot;
    let usedStaleContext = false;
    try {
      const source = await this.deps.resolver.resolve(link.parent);
      snapshot = buildParentContextSnapshot(
        source,
        (await this.deps.buildOptions?.(chatId)) ?? {},
      );
      this.deps.contextStore.put({ ...snapshot, chatId });
      this.staleDelivery.delete(chatId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!options.allowStaleContext || !previousSnapshot) {
        return error instanceof ParentUnavailableError
          ? failure('parent-unavailable', message, previousSnapshot)
          : failure('context-unavailable', `Parent context unavailable: ${message}`, previousSnapshot);
      }
      snapshot = storedToSnapshot(previousSnapshot);
      usedStaleContext = true;
      this.staleDelivery.add(chatId);
      logger.warn('Using last captured parent context snapshot', { chatId, reason: message });
    }

    const key = retryKey(input);
    const failedTurn = this.failedTurns.get(chatId);
    const turnId = failedTurn?.key === key ? failedTurn.turnId : `chat-user-turn:${randomUUID()}`;
    try {
      await this.deps.dispatchSend(input, turnId);
      this.failedTurns.delete(chatId);
      return { ok: true, deliveredRevision: snapshot.revision, usedStaleContext };
    } catch (error) {
      this.failedTurns.set(chatId, { turnId, key });
      return failure(
        'send-failed',
        error instanceof Error ? error.message : String(error),
        this.deps.contextStore.get(chatId),
      );
    }
  }

  /**
   * Parent context to put in front of the next turn on `instanceId`.
   *
   * - `rebuild`: the runtime is being rebuilt from the ledger, so the latest
   *   effective snapshot is always included (never a stack of history).
   * - `resume`: the runtime already holds the conversation; the snapshot is
   *   included only when its revision differs from what this runtime last
   *   received, and then explicitly supersedes it.
   */
  contextForTurn(chatId: string, instanceId: string, mode: 'rebuild' | 'resume'): string | null {
    const stored = this.deps.contextStore.get(chatId);
    if (!stored) {
      return null;
    }
    const stale = this.staleDelivery.has(chatId);
    const delivered = this.deliveredRevision.get(instanceId) ?? null;
    if (mode === 'resume' && delivered === stored.revision && !stale) {
      return null;
    }
    this.deliveredRevision.set(instanceId, stored.revision);
    this.staleDelivery.delete(chatId);
    return formatSnapshotDelivery(storedToSnapshot(stored), {
      supersedesRevision: mode === 'resume' ? delivered : null,
      stale,
    });
  }

  /** Forget delivery state for a runtime that has been terminated or replaced. */
  forgetRuntime(instanceId: string): void {
    this.deliveredRevision.delete(instanceId);
  }
}

/** Identity of a question for retry matching: a digest of its text and attachments. */
function retryKey(input: ChatSendMessageInput): string {
  return createHash('sha256')
    .update(JSON.stringify([
      input.text.trim(),
      (input.attachments ?? []).map((attachment) => [attachment.name, attachment.type, attachment.data]),
    ]))
    .digest('hex');
}

function failure(
  code: SideChatSendFailureCode,
  error: string,
  lastSnapshot: StoredContextSnapshot | null,
): SideChatSendFailure {
  return { ok: false, code, error, lastSnapshotAvailable: lastSnapshot !== null };
}

function storedToSnapshot(stored: StoredContextSnapshot): ParentContextSnapshot {
  return {
    parent: stored.parent,
    revision: stored.revision,
    capturedAt: stored.capturedAt,
    title: 'Parent session',
    estimatedTokens: stored.estimatedTokens,
    omissions: stored.omissions,
    quotedContext: stored.quotedContext,
  };
}
