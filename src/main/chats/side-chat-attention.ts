import type {
  SideChatAttention,
  SideChatParentRef,
} from '../../shared/types/side-chat.types';
import type { SideChatLinkStore } from './side-chat-link-store';
import type { ChatStore } from './chat-store';
import type { InstanceManager } from '../instance/instance-manager';

export interface SideChatAttentionDeps {
  linkStore: SideChatLinkStore;
  chatStore: ChatStore;
  instanceManager: InstanceManager;
  /** Latest assistant sequence per sidechat, from the transcript bridge. */
  getLatestAssistantSequence: (chatId: string) => number;
}

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

  forParent(parent: SideChatParentRef): SideChatAttention {
    const links = this.deps.linkStore.listForParent(parent);
    let running = 0;
    let unread = 0;
    let needsAttention = 0;
    let active = 0;

    for (const link of links) {
      const chat = this.deps.chatStore.get(link.chatId);
      if (!chat || chat.archivedAt !== null) {
        continue;
      }
      active += 1;
      const instance = chat.currentInstanceId
        ? this.deps.instanceManager.getInstance(chat.currentInstanceId)
        : null;
      const status = instance?.status ?? null;
      if (status === 'waiting_for_permission' || status === 'error' || status === 'failed') {
        needsAttention += 1;
      } else if (
        status === 'busy'
        || status === 'processing'
        || status === 'thinking_deeply'
        || status === 'initializing'
      ) {
        running += 1;
      }
      const latestAssistant = this.deps.getLatestAssistantSequence(link.chatId);
      if (latestAssistant > link.lastReadAssistantSequence) {
        unread += 1;
      }
    }

    return {
      parent,
      total: active,
      running,
      unread,
      needsAttention,
    };
  }

  forParents(parents: readonly SideChatParentRef[]): SideChatAttention[] {
    return parents.map((parent) => this.forParent(parent));
  }
}
