import type { SideChatAttention } from '../../../../shared/types/side-chat.types';

/** Shared priority and wording for live and archived session sidechat badges. */
export interface SideChatRowBadge {
  kind: 'needs-attention' | 'unread' | 'running' | 'quiet';
  count: number;
  label: string;
}

export function sideChatRowBadge(attention: SideChatAttention | null): SideChatRowBadge | null {
  if (!attention || attention.total === 0) return null;
  if (attention.needsAttention > 0) {
    return { kind: 'needs-attention', count: attention.needsAttention, label: `${attention.needsAttention} ${attention.needsAttention === 1 ? 'sidechat needs' : 'sidechats need'} action` };
  }
  if (attention.unread > 0) {
    return { kind: 'unread', count: attention.unread, label: `${attention.unread} unread sidechat ${attention.unread === 1 ? 'answer' : 'answers'}` };
  }
  if (attention.running > 0) {
    return { kind: 'running', count: attention.running, label: `${attention.running} ${attention.running === 1 ? 'sidechat' : 'sidechats'} running` };
  }
  return { kind: 'quiet', count: attention.total, label: `${attention.total} ${attention.total === 1 ? 'sidechat' : 'sidechats'}` };
}
