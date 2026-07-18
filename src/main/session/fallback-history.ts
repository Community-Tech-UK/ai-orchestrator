import type { OutputMessage } from '../../shared/types/instance.types';
import { estimateTokens as sharedEstimateTokens } from '../../shared/utils/token-estimate';

const MIN_TURNS = 3;
const TOOL_TRUNCATE_LIMIT = 200;
const PACKET_MESSAGE_PREVIEW_LIMIT = 1_200;
const HISTORY_MESSAGE_PREVIEW_LIMIT = 4_000;

/**
 * Hard ceiling for the complete generated recovery turn. Codex currently
 * rejects assembled turns above 1 MiB; keeping replay context below 200k leaves
 * room for system instructions, tool schemas, and attachment descriptors.
 */
export const MAX_RECOVERY_MESSAGE_CHARS = 200_000;

export interface RecoveryPacket {
  version: 1;
  reason: string;
  generatedAt: number;
  messageCount: number;
  recentMessages: Array<{
    id: string;
    type: OutputMessage['type'];
    content: string;
    contentChars: number;
    contentTruncated: boolean;
    timestamp: number;
    attachmentCount: number;
    toolName?: string;
    toolCallId?: string;
  }>;
  pendingToolCallIds: string[];
  completedToolCallIds: string[];
  whyNativeResumeFailed: string;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function roleLabel(type: OutputMessage['type']): string {
  switch (type) {
    case 'user': return '[USER]';
    case 'assistant': return '[ASSISTANT]';
    case 'tool_use': return '[TOOL_USE]';
    case 'tool_result': {
      return '[TOOL_RESULT]';
    }
    case 'system': return '[SYSTEM]';
    case 'error': return '[ERROR]';
    default: return `[${String(type).toUpperCase()}]`;
  }
}

function toolName(message: OutputMessage): string {
  const name = message.metadata?.['name'] as string | undefined;
  return name ? `: ${name}` : '';
}

function previewMessageContent(message: OutputMessage, textLimit: number): {
  content: string;
  contentChars: number;
  contentTruncated: boolean;
} {
  const contentChars = message.content.length;
  const isToolMessage = message.type === 'tool_result' || message.type === 'tool_use';
  const limit = isToolMessage ? TOOL_TRUNCATE_LIMIT : textLimit;
  if (contentChars <= limit) {
    return { content: message.content, contentChars, contentTruncated: false };
  }

  if (isToolMessage) {
    return {
      content: `[Tool${toolName(message)} — output truncated for recovery, ${contentChars} chars original]`,
      contentChars,
      contentTruncated: true,
    };
  }

  const suffix = `...[truncated for recovery, ${contentChars} chars original]`;
  return {
    content: `${message.content.slice(0, Math.max(0, limit - suffix.length))}${suffix}`,
    contentChars,
    contentTruncated: true,
  };
}

function formatMessage(message: OutputMessage): string {
  const label = message.type === 'tool_result'
    ? `[TOOL${toolName(message)}]`
    : message.type === 'tool_use'
      ? `[TOOL_USE${toolName(message)}]`
      : roleLabel(message.type);

  const time = formatTimestamp(message.timestamp);
  if (message.type === 'tool_result' || message.type === 'tool_use') {
    const toolContentKind = message.type === 'tool_result' ? 'output' : 'invocation';
    return `${label} (${time}): [${message.content.length}-character tool ${toolContentKind} omitted from replay; see the structured packet preview and archived transcript.]`;
  }
  const { content } = previewMessageContent(message, HISTORY_MESSAGE_PREVIEW_LIMIT);

  return `${label} (${time}): ${content}`;
}

function estimateTokens(text: string): number {
  return sharedEstimateTokens(text);
}

export function buildRecoveryPacket(messages: OutputMessage[], reason: string): RecoveryPacket {
  const pendingToolCallIds = new Set<string>();
  const completedToolCallIds = new Set<string>();
  const recentMessages = messages
    .filter(m => m.type === 'user' || m.type === 'assistant' || m.type === 'tool_use' || m.type === 'tool_result')
    .slice(-40)
    .map((message) => {
      const toolCallId = (
        message.metadata?.['tool_use_id']
        ?? message.metadata?.['toolCallId']
        ?? message.metadata?.['id']
      ) as string | undefined;
      if (toolCallId && message.type === 'tool_use') pendingToolCallIds.add(toolCallId);
      if (toolCallId && message.type === 'tool_result') {
        pendingToolCallIds.delete(toolCallId);
        completedToolCallIds.add(toolCallId);
      }
      const preview = previewMessageContent(message, PACKET_MESSAGE_PREVIEW_LIMIT);
      return {
        id: message.id,
        type: message.type,
        content: preview.content,
        contentChars: preview.contentChars,
        contentTruncated: preview.contentTruncated,
        timestamp: message.timestamp,
        attachmentCount: message.attachments?.length ?? 0,
        toolName: message.metadata?.['name'] as string | undefined,
        toolCallId,
      };
    });

  return {
    version: 1,
    reason,
    generatedAt: Date.now(),
    messageCount: messages.length,
    recentMessages,
    pendingToolCallIds: Array.from(pendingToolCallIds),
    completedToolCallIds: Array.from(completedToolCallIds),
    whyNativeResumeFailed: reason,
  };
}

export function renderRecoveryPacket(packet: RecoveryPacket): string {
  return [
    '[STRUCTURED RECOVERY PACKET]',
    JSON.stringify(packet),
    '[END STRUCTURED RECOVERY PACKET]',
  ].join('\n');
}

/** A live orchestration child listed in the fresh-fallback degradation notice. */
export interface FreshFallbackChildRef {
  id: string;
  name?: string;
  status?: string;
}

export interface FreshFallbackDegradationInfo {
  /** Orchestration children still alive and attached to this conversation. */
  activeChildren?: FreshFallbackChildRef[];
  /** Orchestration children found dead and dropped during restart reconciliation. */
  droppedChildIds?: string[];
}

/**
 * Honest degradation preamble for a genuine fresh fallback: the replay
 * transcript restores conversation text only — anything that lived inside the
 * old provider process (in-process subagents, running tools, queued work) is
 * gone and the model must not assume it completed. Appended by
 * RestartPolicyHelpers.buildFallbackHistory on every fresh-fallback path.
 */
export function buildFreshFallbackDegradationNotice(
  reason: string,
  info: FreshFallbackDegradationInfo = {},
): string {
  const lines = [
    '[SESSION DEGRADATION NOTICE]',
    `A brand-new provider session was started because the previous one could not be resumed (${reason}).`,
    'Background and in-flight work from the prior session — subagents, running tools, pending tasks — was NOT carried over and no longer exists.',
    'Re-establish the current state (re-check files, task status, and outputs) before continuing; do not assume prior background work finished.',
  ];

  const active = info.activeChildren ?? [];
  if (active.length > 0) {
    lines.push('Orchestration child instances still alive and attached to you:');
    for (const child of active) {
      const detail = [child.name, child.status].filter(Boolean).join(', ');
      lines.push(`- ${child.id}${detail ? ` (${detail})` : ''}`);
    }
  }

  const dropped = info.droppedChildIds ?? [];
  if (dropped.length > 0) {
    lines.push(`Orchestration child instances lost in the restart (no longer running): ${dropped.join(', ')}`);
  }

  lines.push('[END SESSION DEGRADATION NOTICE]');
  return lines.join('\n');
}

function buildMetadataHeader(messages: OutputMessage[], totalTurns: number): string {
  const firstUser = messages.find(m => m.type === 'user');
  const toolNames = new Set<string>();
  for (const m of messages) {
    if (m.type === 'tool_use' || m.type === 'tool_result') {
      const name = m.metadata?.['name'] as string | undefined;
      if (name) toolNames.add(name);
    }
  }

  const lines = [
    `Original objective: ${firstUser?.content.slice(0, 200) || 'Unknown'}`,
    `Total exchanges: ${totalTurns} user+assistant exchanges`,
  ];

  if (toolNames.size > 0) {
    lines.push(`Tools used: ${Array.from(toolNames).join(', ')}`);
  }

  return lines.join('\n');
}

function withTrailingNotice(message: string, trailingNotice?: string): string {
  return trailingNotice?.trim()
    ? `${message}\n\n${trailingNotice.trim()}`
    : message;
}

function fitsRecoveryBudget(message: string, budgetTokens: number): boolean {
  return message.length <= MAX_RECOVERY_MESSAGE_CHARS
    && estimateTokens(message) <= budgetTokens;
}

function buildMinimalRecoveryMessage(
  messages: OutputMessage[],
  reason: string,
  trailingNotice?: string,
): string {
  const conversational = messages.filter(
    (message) => message.type === 'user' || message.type === 'assistant',
  );
  const latestUser = [...conversational].reverse().find((message) => message.type === 'user');
  const latestAssistant = [...conversational].reverse().find((message) => message.type === 'assistant');
  const lines = [
    '[SESSION RECOVERY]',
    `Native resume failed (${reason}). The complete transcript remains archived; this replay was reduced to fit provider limits.`,
  ];
  if (latestUser) {
    lines.push(`[USER] ${previewMessageContent(latestUser, 200).content}`);
  }
  if (latestAssistant) {
    lines.push(`[ASSISTANT] ${previewMessageContent(latestAssistant, 200).content}`);
  }
  lines.push('Continue from the current workspace state and ask only for context that cannot be recovered locally.');
  return withTrailingNotice(lines.join('\n'), trailingNotice);
}

function fitPlainRecoveryMessage(message: string, budgetTokens: number): string {
  if (fitsRecoveryBudget(message, budgetTokens)) return message;

  const marker = '\n[Recovery context truncated to fit provider limits.]';
  let low = 0;
  let high = Math.min(message.length, MAX_RECOVERY_MESSAGE_CHARS - marker.length);
  let best = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${message.slice(0, middle).trimEnd()}${marker}`;
    if (fitsRecoveryBudget(candidate, budgetTokens)) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return best || '[SESSION RECOVERY]';
}

export function buildFallbackHistoryMessage(
  messages: OutputMessage[],
  reason: string,
  contextWindowTokens: number,
  budgetFraction = 0.3,
  trailingNotice?: string,
): string | null {
  if (messages.length === 0) return null;
  const packet = buildRecoveryPacket(messages, reason);

  const budgetTokens = Math.max(1, Math.floor(contextWindowTokens * budgetFraction));
  const conversational = messages.filter(
    m => m.type === 'user' || m.type === 'assistant' || m.type === 'tool_use' || m.type === 'tool_result'
  );

  if (conversational.length === 0) return null;

  const formatted = conversational.map((message) => formatMessage(message));

  const header = [
    `[SESSION RECOVERY — original session lost (${reason})]`,
    'The following is your conversation history for context continuity.',
    'Continue from where you left off. Do not repeat tool calls that already executed.',
    renderRecoveryPacket(packet),
    '',
  ].join('\n');

  const fullBody = formatted.join('\n');
  const fullMessage = withTrailingNotice(
    `${header}--- Conversation History ---\n${fullBody}`,
    trailingNotice,
  );

  if (fitsRecoveryBudget(fullMessage, budgetTokens)) {
    return fullMessage;
  }

  const totalUserTurns = conversational.filter(m => m.type === 'user').length;
  const metadataHeader = buildMetadataHeader(messages, totalUserTurns);

  for (let keepTurns = conversational.length; keepTurns >= MIN_TURNS; keepTurns = Math.floor(keepTurns * 0.7)) {
    const slice = conversational.slice(-keepTurns);
    const sliceFormatted = slice.map((message) => formatMessage(message));

    const omittedCount = conversational.length - keepTurns;
    const body = sliceFormatted.join('\n');
    const candidate = withTrailingNotice([
      header,
      metadataHeader,
      `\n(${omittedCount} earlier messages omitted)\n`,
      '--- Recent Conversation History ---',
      body,
    ].join('\n'), trailingNotice);

    if (fitsRecoveryBudget(candidate, budgetTokens)) {
      return candidate;
    }
  }

  const minSlice = conversational.slice(-MIN_TURNS);
  const minFormatted = minSlice.map((message) => formatMessage(message));
  const minimumCandidate = withTrailingNotice([
    header,
    metadataHeader,
    `\n(${conversational.length - MIN_TURNS} earlier messages omitted)\n`,
    '--- Recent Conversation History ---',
    minFormatted.join('\n'),
  ].join('\n'), trailingNotice);
  if (fitsRecoveryBudget(minimumCandidate, budgetTokens)) {
    return minimumCandidate;
  }

  return fitPlainRecoveryMessage(
    buildMinimalRecoveryMessage(messages, reason, trailingNotice),
    budgetTokens,
  );
}
