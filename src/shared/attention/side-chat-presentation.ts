import type { SideChatConversationState } from '../types/side-chat.types';

/** Sidechat activity includes unread answers that are independent of session status. */
export function sideChatStateLabel(state: SideChatConversationState): string {
  switch (state) {
    case 'needs-attention': return 'Needs you';
    case 'unread': return 'New answer';
    case 'running': return 'Running';
    case 'idle': return '';
  }
}
