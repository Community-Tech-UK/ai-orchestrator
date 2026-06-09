import type { ChatDetail, ChatRecord } from '../../shared/types/chat.types';
import { frontLoadTitle } from '../../shared/types/history.types';
import { deriveAttachmentTaskTitle, isLowSignalTitle } from '../../shared/types/title-derivation';

const UNTITLED_CHAT = 'Untitled chat';
const REPLAY_TURN_PAIR_LIMIT = 10;
const REPLAY_CHAR_BUDGET = 24_000;

export const CHAT_REPLAY_MESSAGE_LIMIT = (REPLAY_TURN_PAIR_LIMIT * 2) + 2;

export function normalizeChatName(name: string | undefined): string {
  const trimmed = name?.trim();
  return trimmed || UNTITLED_CHAT;
}

export function maybeAutoName(
  chat: ChatRecord,
  text: string,
  attachmentNames: readonly string[] = [],
): string | null {
  if (chat.name !== UNTITLED_CHAT) {
    return null;
  }
  const compact = frontLoadTitle(text);
  if (attachmentNames.length > 0 && (!compact || isLowSignalTitle(compact))) {
    const fromAttachment = deriveAttachmentTaskTitle(text, attachmentNames);
    if (fromAttachment) {
      return truncateChatName(fromAttachment);
    }
  }
  return compact ? truncateChatName(compact) : null;
}

export function buildReplayBlock(
  messages: ChatDetail['conversation']['messages'],
  previousCwd: string,
  currentCwd: string,
): string {
  const turns = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-REPLAY_TURN_PAIR_LIMIT * 2)
    .map((message) => `${message.role}: ${message.content.trim()}`)
    .filter((line) => line.length > 0);

  while (turns.join('\n\n').length > REPLAY_CHAR_BUDGET && turns.length > 1) {
    turns.shift();
  }

  if (turns.length === 0) {
    return '';
  }

  return [
    `[Context from prior conversation, working directory was ${previousCwd}:]`,
    turns.join('\n\n'),
    `[Continue, working directory is now ${currentCwd}.]`,
  ].join('\n');
}

function truncateChatName(name: string): string {
  if (name.length <= 44) {
    return name;
  }
  const slice = name.slice(0, 44);
  const lastSpace = slice.lastIndexOf(' ');
  return `${slice.slice(0, lastSpace > 20 ? lastSpace : 44).trim()}...`;
}
