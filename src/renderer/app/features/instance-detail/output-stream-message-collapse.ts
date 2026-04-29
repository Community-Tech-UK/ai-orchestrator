import type { OutputMessage } from '../../core/state/instance/instance.types';

export const USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD = 900;
export const USER_MESSAGE_COLLAPSE_LINE_THRESHOLD = 12;
export const USER_MESSAGE_COLLAPSE_VISUAL_LINES = 8;

export function shouldCollapseUserMessage(message: Pick<OutputMessage, 'type' | 'content'>): boolean {
  if (message.type !== 'user') {
    return false;
  }

  const content = message.content.trim();
  if (!content) {
    return false;
  }

  const lineCount = content.split(/\r?\n/).length;
  return content.length >= USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD || lineCount >= USER_MESSAGE_COLLAPSE_LINE_THRESHOLD;
}
