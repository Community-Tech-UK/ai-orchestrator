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

const logger = getLogger('SideChatSendCoordinator');

export type SideChatSendResult =
  | {
      ok: true;
      deliveredRevision: string;
      usedStaleContext: boolean;
    }
  | {
      ok: false;
      code: 'parent-unavailable' | 'context-unavailable' | 'send-failed';
      error: string;
      /** Whether a previous snapshot can be used via `allowStaleContext`. */
      lastSnapshotAvailable: boolean;
    };

export interface SideChatSendDeps {
  resolver: SideChatParentResolver;
  contextStore: SideChatContextStore;
  linkStore: SideChatLinkStore;
  /** Queue a hidden continuity preamble on the sidechat's runtime. */
  queuePreamble: (instanceId: string, preamble: string) => void;
  /**
   * Dispatch the user's question through the ordinary chat send path. Called
   * only after the parent snapshot has been resolved and persisted, so a
   * snapshot failure never creates a duplicate user turn on retry.
   */
  dispatchSend: (chatId: string, text: string) => Promise<void>;
  /** Resolve the sidechat's current runtime instance id, if any. */
  getRuntimeInstanceId: (chatId: string) => string | null;
  buildOptions?: (chatId: string) => BuildParentContextOptions;
}

/**
 * Serializes sidechat sends and delivers refreshed parent context before each
 * user question.
 *
 * Per-chat serialization means concurrent sends and retries cannot interleave
 * or duplicate a user turn. Snapshot acquisition happens before any ledger
 * mutation: if it fails the caller gets an explicit error and can opt into the
 * last captured snapshot, instead of silently sending a context-free question.
 */
export class SideChatSendCoordinator {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: SideChatSendDeps) {}

  async send(
    chatId: string,
    text: string,
    options: { allowStaleContext?: boolean } = {},
  ): Promise<SideChatSendResult> {
    const previous = this.locks.get(chatId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.sendLocked(chatId, text, options));
    // Prune the lock entry after settlement to bound map growth.
    const settled = run.then(
      (result) => {
        if (this.locks.get(chatId) === settled) {
          this.locks.delete(chatId);
        }
        return result;
      },
      (error: unknown) => {
        if (this.locks.get(chatId) === settled) {
          this.locks.delete(chatId);
        }
        throw error;
      },
    );
    this.locks.set(chatId, settled.catch(() => undefined));
    return run;
  }

  private async sendLocked(
    chatId: string,
    text: string,
    options: { allowStaleContext?: boolean },
  ): Promise<SideChatSendResult> {
    const link = this.deps.linkStore.get(chatId);
    if (!link) {
      return {
        ok: false,
        code: 'parent-unavailable',
        error: 'This chat is not linked to a parent session',
        lastSnapshotAvailable: this.deps.contextStore.get(chatId) !== null,
      };
    }

    const previousSnapshot = this.deps.contextStore.get(chatId);
    let snapshot: ParentContextSnapshot;
    let usedStaleContext = false;

    try {
      const source = await this.deps.resolver.resolve(link.parent);
      snapshot = buildParentContextSnapshot(
        source,
        this.deps.buildOptions?.(chatId) ?? {},
      );
      this.deps.contextStore.put({ ...snapshot, chatId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        error instanceof ParentUnavailableError
        || (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'parent-unavailable')
      ) {
        if (options.allowStaleContext && previousSnapshot) {
          snapshot = storedToSnapshot(previousSnapshot);
          usedStaleContext = true;
          logger.warn('Using stale parent context snapshot', { chatId, reason: message });
        } else {
          return {
            ok: false,
            code: 'parent-unavailable',
            error: message,
            lastSnapshotAvailable: previousSnapshot !== null,
          };
        }
      } else {
        if (options.allowStaleContext && previousSnapshot) {
          snapshot = storedToSnapshot(previousSnapshot);
          usedStaleContext = true;
          logger.warn('Using stale parent context snapshot after resolve failure', {
            chatId,
            reason: message,
          });
        } else {
          return {
            ok: false,
            code: 'context-unavailable',
            error: `Parent context unavailable: ${message}`,
            lastSnapshotAvailable: previousSnapshot !== null,
          };
        }
      }
    }

    // Deliver refreshed context before the user's question. Unchanged context
    // is not resent; a changed revision explicitly supersedes the prior one.
    const runtimeInstanceId = this.deps.getRuntimeInstanceId(chatId);
    const supersedesRevision = previousSnapshot?.revision ?? null;
    const shouldDeliver =
      usedStaleContext
      || !previousSnapshot
      || previousSnapshot.revision !== snapshot.revision;
    if (shouldDeliver && runtimeInstanceId) {
      this.deps.queuePreamble(
        runtimeInstanceId,
        formatSnapshotDelivery(snapshot, { supersedesRevision, stale: usedStaleContext }),
      );
    }

    try {
      await this.deps.dispatchSend(chatId, text);
      return { ok: true, deliveredRevision: snapshot.revision, usedStaleContext };
    } catch (error) {
      return {
        ok: false,
        code: 'send-failed',
        error: error instanceof Error ? error.message : String(error),
        lastSnapshotAvailable: this.deps.contextStore.get(chatId) !== null,
      };
    }
  }

  /**
   * Rebuild support: the latest effective parent context for a sidechat, for
   * injection alongside the sidechat's own conversation after a restart or
   * provider switch. Never a stack of historical snapshots.
   */
  latestEffectiveContext(chatId: string): StoredContextSnapshot | null {
    return this.deps.contextStore.get(chatId);
  }
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
