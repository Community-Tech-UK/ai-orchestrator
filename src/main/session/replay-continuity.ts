import type { OutputMessage } from '../../shared/types/instance.types';

const DEFAULT_MAX_TURNS = 24;
const DEFAULT_MAX_CHARS_PER_MESSAGE = 800;
const DEFAULT_MAX_UNRESOLVED = 5;

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function truncateContent(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars)}...[truncated]`;
}

export function extractUnresolvedItems(messages: OutputMessage[], maxItems: number): string[] {
  const unresolved = new Set<string>();

  for (const message of messages.slice(-40)) {
    const todoMatches = message.content.match(/- \[ \]\s+(.+)/gi);
    if (todoMatches) {
      for (const match of todoMatches) {
        unresolved.add(match.replace(/^- \[ \]\s+/i, '').trim());
      }
    }

    const todoLineMatches = message.content.match(/(?:^|\n)\s*(?:todo|next|follow-up)\s*[:-]\s*(.+)/gi);
    if (todoLineMatches) {
      for (const match of todoLineMatches) {
        unresolved.add(match.replace(/(?:^|\n)\s*(?:todo|next|follow-up)\s*[:-]\s*/i, '').trim());
      }
    }
  }

  return Array.from(unresolved).filter(Boolean).slice(0, maxItems);
}

export interface ReplayContinuityOptions {
  reason: string;
  maxTurns?: number;
  maxCharsPerMessage?: number;
  maxUnresolvedItems?: number;
}

/**
 * Build a deterministic continuity preamble from an archived/replayed transcript.
 * The output is designed for hidden prompt injection on the next user turn.
 */
export function buildReplayContinuityMessage(
  messages: OutputMessage[],
  options: ReplayContinuityOptions
): string | null {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxCharsPerMessage = options.maxCharsPerMessage ?? DEFAULT_MAX_CHARS_PER_MESSAGE;
  const maxUnresolvedItems = options.maxUnresolvedItems ?? DEFAULT_MAX_UNRESOLVED;

  const conversationalTurns = messages.filter(
    (message) => message.type === 'user' || message.type === 'assistant'
  );
  if (conversationalTurns.length === 0) {
    return null;
  }

  const recentTurns = conversationalTurns.slice(-maxTurns);
  const omittedTurns = Math.max(0, conversationalTurns.length - recentTurns.length);
  const latestUserMessage = [...conversationalTurns]
    .reverse()
    .find((message) => message.type === 'user');
  const unresolvedItems = extractUnresolvedItems(messages, maxUnresolvedItems);

  const lines: string[] = [
    '<conversation_history>',
    `Resume mode: replay fallback (${options.reason}). Native session state was unavailable, so this archived transcript summary is being provided as context.`,
    'Tool calls and tool results from the earlier conversation were already executed. Do not repeat them unless the user explicitly asks you to rerun something.',
    '',
    'Current objective:',
    truncateContent(latestUserMessage?.content || 'Continue the previous task.', maxCharsPerMessage),
    '',
    'Unresolved items:',
  ];

  if (unresolvedItems.length > 0) {
    for (const item of unresolvedItems) {
      lines.push(`- ${truncateContent(item, maxCharsPerMessage)}`);
    }
  } else {
    lines.push('- None explicitly captured.');
  }

  lines.push('');
  lines.push('Recent transcript:');

  if (omittedTurns > 0) {
    lines.push(`- ${omittedTurns} earlier turns omitted for brevity.`);
  }

  for (const message of recentTurns) {
    const role = message.type === 'user' ? 'Human' : 'Assistant';
    lines.push(`${role}: ${truncateContent(message.content, maxCharsPerMessage)}`);
  }

  lines.push('</conversation_history>');
  lines.push('Use this as background context for the next reply. Prefer continuing the task over asking the user to repeat information unless critical context is still missing.');

  return lines.join('\n');
}
