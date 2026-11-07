import type {
  SideChatAttention,
  SideChatConversationState,
  SideChatLink,
  SideChatParentRef,
  SideChatSummary,
} from '../../shared/types/side-chat.types';
import { sideChatConversationState, sideChatParentKey } from '../../shared/types/side-chat.types';
import type { SideChatLinkStore } from './side-chat-link-store';
import type { ChatStore } from './chat-store';
import type { InstanceManager } from '../instance/instance-manager';

export interface SideChatAttentionDeps {
  linkStore: Pick<SideChatLinkStore, 'listActiveForParent' | 'listActiveParents'>;
  chatStore: Pick<ChatStore, 'get'>;
  instanceManager: Pick<InstanceManager, 'getInstance'>;
  /**
   * Latest assistant sequence for a sidechat. Persisted, so unread state
   * survives an app restart (see SideChatLinkStore.getLatestAssistantSequence).
   */
  getLatestAssistantSequence: (link: SideChatLink) => Promise<number>;
  /** Display title of a parent, or null when it no longer resolves. */
  resolveParentTitle: (parent: SideChatParentRef) => Promise<string | null>;
  now?: () => number;
}

const STATE_PRIORITY: Record<SideChatConversationState, number> = {
  'needs-attention': 0,
  unread: 1,
  running: 2,
  idle: 3,
};

/**
 * Computes persistent attention state for a parent's sidechats.
 *
 * Counts refer to conversations with unread answers, never to streaming chunks.
 * A conversation is "unread" when its latest assistant sequence is above the
 * persisted read high-water mark. "Needs attention" (permission required or
 * failed) takes priority over "running" in the UI sort.
 */
export class SideChatAttentionTracker {
  /** Open episodes belong to a logical parent and chat, never a runtime instance. */
  private readonly attentionOnsets = new Map<string, Map<string, number>>();
  private readonly parentRefreshes = new Map<string, Promise<void>>();

  constructor(private readonly deps: SideChatAttentionDeps) {}

  async summariesForParent(parent: SideChatParentRef): Promise<SideChatSummary[]> {
    const summaries: SideChatSummary[] = [];
    for (const link of this.deps.linkStore.listActiveForParent(parent)) {
      const chat = this.deps.chatStore.get(link.chatId);
      if (!chat || chat.archivedAt !== null) {
        continue;
      }
      const instance = chat.currentInstanceId
        ? this.deps.instanceManager.getInstance(chat.currentInstanceId)
        : undefined;
      const status = instance && instance.status !== 'terminated' ? instance.status : null;
      const latestAssistantSequence = await this.deps.getLatestAssistantSequence(link);
      const unread = latestAssistantSequence > link.lastReadAssistantSequence;
      summaries.push({
        link,
        chat,
        status,
        latestAssistantSequence,
        state: sideChatConversationState(status, unread),
      });
    }
    return summaries;
  }

  async forParent(parent: SideChatParentRef): Promise<SideChatAttention> {
    const key = sideChatParentKey(parent);
    const previous = this.parentRefreshes.get(key);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    this.parentRefreshes.set(key, pending);
    try {
      // Read and publish episodes in order; a slow older ledger lookup cannot reset a newer wait.
      if (previous) await previous;
      return await this.collectForParent(parent);
    } finally {
      release();
      if (this.parentRefreshes.get(key) === pending) this.parentRefreshes.delete(key);
    }
  }

  private async collectForParent(parent: SideChatParentRef): Promise<SideChatAttention> {
    const summaries = await this.summariesForParent(parent);
    const parentKey = sideChatParentKey(parent);
    const onsets = this.attentionOnsets.get(parentKey) ?? new Map<string, number>();
    const activeChats = new Set(summaries.map(summary => summary.chat.id));
    for (const chatId of onsets.keys()) {
      if (!activeChats.has(chatId)) onsets.delete(chatId);
    }
    let running = 0;
    let unread = 0;
    let needsAttention = 0;
    let attentionSince: number | null = null;
    const now = (this.deps.now ?? Date.now)();
    let target: SideChatSummary | null = null;
    for (const summary of summaries) {
      const chatId = summary.chat.id;
      if (summary.state === 'needs-attention') {
        needsAttention += 1;
        const onset = onsets.get(chatId) ?? now;
        onsets.set(chatId, onset);
        attentionSince = attentionSince === null ? onset : Math.min(attentionSince, onset);
      } else {
        onsets.delete(chatId);
      }
      if (summary.state === 'running') running += 1;
      if (summary.latestAssistantSequence > summary.link.lastReadAssistantSequence) unread += 1;
      if (summary.state !== 'idle'
        && (!target || STATE_PRIORITY[summary.state] < STATE_PRIORITY[target.state])) {
        target = summary;
      }
    }
    if (onsets.size > 0) this.attentionOnsets.set(parentKey, onsets);
    else this.attentionOnsets.delete(parentKey);
    return {
      parent,
      parentTitle: await this.deps.resolveParentTitle(parent),
      total: summaries.length,
      running,
      unread,
      needsAttention,
      attentionSince,
      targetChatId: target?.chat.id ?? null,
    };
  }

  /** Attention for every parent owning an active sidechat (global rail list). */
  async forAllParents(): Promise<SideChatAttention[]> {
    const results: SideChatAttention[] = [];
    for (const parent of this.deps.linkStore.listActiveParents()) {
      results.push(await this.forParent(parent));
    }
    return results;
  }
}
