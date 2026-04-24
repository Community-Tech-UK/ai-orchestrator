import type { OutputMessage } from '../../shared/types/instance.types';

const CHARS_PER_TOKEN = 4;
const RECENT_TURNS_THRESHOLD = 5;
const MIN_TURNS = 3;
const TOOL_TRUNCATE_LIMIT = 200;

export interface RecoveryPacket {
  version: 1;
  reason: string;
  generatedAt: number;
  messageCount: number;
  recentMessages: Array<{
    id: string;
    type: OutputMessage['type'];
    content: string;
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

function formatMessage(message: OutputMessage, truncateToolOutput: boolean): string {
  const label = message.type === 'tool_result'
    ? `[TOOL${toolName(message)}]`
    : message.type === 'tool_use'
      ? `[TOOL_USE${toolName(message)}]`
      : roleLabel(message.type);

  const time = formatTimestamp(message.timestamp);
  let content = message.content;

  if (truncateToolOutput && (message.type === 'tool_result' || message.type === 'tool_use')) {
    if (content.length > TOOL_TRUNCATE_LIMIT) {
      content = `[Tool${toolName(message)} — output truncated for recovery, ${content.length} chars original]`;
    }
  }

  return `${label} (${time}): ${content}`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
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
      return {
        id: message.id,
        type: message.type,
        content: message.content,
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

export function buildFallbackHistoryMessage(
  messages: OutputMessage[],
  reason: string,
  contextWindowTokens: number,
  budgetFraction = 0.3,
): string | null {
  if (messages.length === 0) return null;
  const packet = buildRecoveryPacket(messages, reason);

  const budgetTokens = Math.floor(contextWindowTokens * budgetFraction);
  const conversational = messages.filter(
    m => m.type === 'user' || m.type === 'assistant' || m.type === 'tool_use' || m.type === 'tool_result'
  );

  if (conversational.length === 0) return null;

  let recentBoundary = conversational.length;
  let userTurnsSeen = 0;
  for (let i = conversational.length - 1; i >= 0; i--) {
    if (conversational[i].type === 'user') {
      userTurnsSeen++;
      if (userTurnsSeen >= RECENT_TURNS_THRESHOLD) {
        recentBoundary = i;
        break;
      }
    }
  }

  const formatted = conversational.map((m, i) => {
    const truncate = i < recentBoundary;
    return formatMessage(m, truncate);
  });

  const header = [
    `[SESSION RECOVERY — original session lost (${reason})]`,
    'The following is your conversation history for context continuity.',
    'Continue from where you left off. Do not repeat tool calls that already executed.',
    renderRecoveryPacket(packet),
    '',
  ].join('\n');

  const fullBody = formatted.join('\n');
  const fullMessage = `${header}--- Conversation History ---\n${fullBody}`;

  if (estimateTokens(fullMessage) <= budgetTokens) {
    return fullMessage;
  }

  const totalUserTurns = conversational.filter(m => m.type === 'user').length;
  const metadataHeader = buildMetadataHeader(messages, totalUserTurns);

  for (let keepTurns = conversational.length; keepTurns >= MIN_TURNS; keepTurns = Math.floor(keepTurns * 0.7)) {
    const slice = conversational.slice(-keepTurns);
    const sliceFormatted = slice.map((m, i) => {
      const truncate = i < Math.max(0, slice.length - RECENT_TURNS_THRESHOLD * 2);
      return formatMessage(m, truncate);
    });

    const omittedCount = conversational.length - keepTurns;
    const body = sliceFormatted.join('\n');
    const candidate = [
      header,
      metadataHeader,
      `\n(${omittedCount} earlier messages omitted)\n`,
      '--- Recent Conversation History ---',
      body,
    ].join('\n');

    if (estimateTokens(candidate) <= budgetTokens) {
      return candidate;
    }
  }

  const minSlice = conversational.slice(-MIN_TURNS);
  const minFormatted = minSlice.map(m => formatMessage(m, true));
  return [
    header,
    metadataHeader,
    `\n(${conversational.length - MIN_TURNS} earlier messages omitted)\n`,
    '--- Recent Conversation History ---',
    minFormatted.join('\n'),
  ].join('\n');
}
