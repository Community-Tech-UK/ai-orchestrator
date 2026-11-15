import type { Instance } from '../../shared/types/instance.types';
import { getChatServiceIfInitialized } from '../chats/chat-service';
import { hasPendingBrowserApproval } from '../cli/adapters/codex/browser-approval-watchdog';
import type { SessionWatcherDeps } from './session-watcher';
import { ClaudeOneShotWatcherJudge } from './watcher-judge';
import { watcherLevel } from './watcher-level';

/** Sessions where the user is typing, or has a message queued. The renderer and the phone report; each report expires. */
export class WatcherTypingHold {
  private readonly until = new Map<string, number>();

  /** Hold replies to this session until `untilMs`, or release it with 0. */
  set(instanceId: string, untilMs: number): void {
    if (untilMs > Date.now()) this.until.set(instanceId, untilMs);
    else this.until.delete(instanceId);
  }

  isHeld(instanceId: string): boolean {
    const until = this.until.get(instanceId);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.until.delete(instanceId);
    return false;
  }
}

const typingHold = new WatcherTypingHold();
export function getWatcherTypingHold(): WatcherTypingHold {
  return typingHold;
}

/** What the watcher needs from the rest of the app, beyond what the continuation runtime already holds. */
export type SessionWatcherExternals = Pick<SessionWatcherDeps, 'level' | 'isSideChat' | 'hasOpenRequest' | 'judge' | 'isUserTyping'>;

export function createSessionWatcherExternals(
  pendingUserActions: (instanceId: string) => readonly unknown[],
): SessionWatcherExternals {
  return {
    level: watcherLevel,
    isSideChat: (instance: Instance) => {
      const chatId = instance.evidenceConversationOwner?.chatId;
      return chatId !== undefined && getChatServiceIfInitialized()?.sideChats.isSideChat(chatId) === true;
    },
    // A question card or a browser approval is already in front of the user; a document review is not a reason
    // to stay silent, because one can stay open for days while the session carries on with other work.
    hasOpenRequest: (instance: Instance) => pendingUserActions(instance.id).length > 0 || hasPendingBrowserApproval(instance.id),
    judge: new ClaudeOneShotWatcherJudge(),
    isUserTyping: (instanceId: string) => typingHold.isHeld(instanceId),
  };
}
