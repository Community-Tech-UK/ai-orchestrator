import type { OutputMessage } from '../../core/state/instance/instance.types';

export const USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD = 900;
export const USER_MESSAGE_COLLAPSE_LINE_THRESHOLD = 12;

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

export function toggleExpandedId(current: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}
