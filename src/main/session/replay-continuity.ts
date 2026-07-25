import type { OutputMessage } from '../../shared/types/instance.types';

const DEFAULT_MAX_TURNS = 24;
const DEFAULT_MAX_CHARS_PER_MESSAGE = 800;
/**
 * The final turn is the one the user's next message replies to (a pending
 * question, a numbered list of options), so it gets a much larger budget than
 * the scrollback around it.
 */
const DEFAULT_MAX_CHARS_FOR_LAST_TURN = 4_000;
const DEFAULT_MAX_UNRESOLVED = 5;

/** Share of a truncated message's budget spent on its opening. */
const TRUNCATION_HEAD_RATIO = 0.6;

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Truncate from the middle, keeping both ends.
 *
 * Head-only truncation silently deleted the end of a message, which is exactly
 * where an agent puts the question it is waiting on — a restored Codex thread
 * received a transcript ending in "...[truncated]" and had to ask the user what
 * their "1" referred to (2026-07-25).
 */
export function truncateTranscriptContent(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const headChars = Math.max(1, Math.floor(maxChars * TRUNCATION_HEAD_RATIO));
  const tailChars = Math.max(0, maxChars - headChars);
  if (tailChars === 0) {
    return `${normalized.slice(0, headChars)}...[truncated]`;
  }

  return `${normalized.slice(0, headChars)}\n...[truncated]...\n${normalized.slice(-tailChars)}`;
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
  /** Budget for the newest turn. Defaults to {@link DEFAULT_MAX_CHARS_FOR_LAST_TURN}. */
  maxCharsForLastTurn?: number;
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
  const maxCharsForLastTurn = Math.max(
    maxCharsPerMessage,
    options.maxCharsForLastTurn ?? DEFAULT_MAX_CHARS_FOR_LAST_TURN,
  );
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
    truncateTranscriptContent(
      latestUserMessage?.content || 'Continue the previous task.',
      maxCharsPerMessage,
    ),
    '',
    'Unresolved items:',
  ];

  if (unresolvedItems.length > 0) {
    for (const item of unresolvedItems) {
      lines.push(`- ${truncateTranscriptContent(item, maxCharsPerMessage)}`);
    }
  } else {
    lines.push('- None explicitly captured.');
  }

  lines.push('');
  lines.push('Recent transcript:');

  if (omittedTurns > 0) {
    lines.push(`- ${omittedTurns} earlier turns omitted for brevity.`);
  }

  recentTurns.forEach((message, index) => {
    const role = message.type === 'user' ? 'Human' : 'Assistant';
    const budget = index === recentTurns.length - 1 ? maxCharsForLastTurn : maxCharsPerMessage;
    lines.push(`${role}: ${truncateTranscriptContent(message.content, budget)}`);
  });

  lines.push('</conversation_history>');
  lines.push('Use this as background context for the next reply. Prefer continuing the task over asking the user to repeat information unless critical context is still missing.');

  return lines.join('\n');
}
