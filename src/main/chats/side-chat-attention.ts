import type {
  SideChatAttention,
  SideChatConversationState,
  SideChatLink,
  SideChatParentRef,
  SideChatSummary,
} from '../../shared/types/side-chat.types';
import { sideChatConversationState } from '../../shared/types/side-chat.types';
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
    const summaries = await this.summariesForParent(parent);
    let running = 0;
    let unread = 0;
    let needsAttention = 0;
    let target: SideChatSummary | null = null;
    for (const summary of summaries) {
      if (summary.state === 'needs-attention') needsAttention += 1;
      if (summary.state === 'running') running += 1;
      if (summary.latestAssistantSequence > summary.link.lastReadAssistantSequence) unread += 1;
      if (summary.state !== 'idle'
        && (!target || STATE_PRIORITY[summary.state] < STATE_PRIORITY[target.state])) {
        target = summary;
      }
    }
    return {
      parent,
      parentTitle: await this.deps.resolveParentTitle(parent),
      total: summaries.length,
      running,
      unread,
      needsAttention,
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
