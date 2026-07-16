import type { ConversationMessageRecord } from '../../shared/types/conversation-ledger.types';
import type { ChatStore } from '../chats/chat-store';
import type { ConversationLedgerService } from '../conversation-ledger';

const SOURCE_CONTEXT_MESSAGE_LIMIT = 200;

export interface OrchestratorToolSourceContext {
  chatId: string | null;
  threadId: string;
  sourceMessageId: string;
}

export async function resolveOrchestratorToolSourceContext(input: {
  chatStore: ChatStore;
  ledger: ConversationLedgerService | null;
  instanceId: string | null;
  preferredConversationId?: string | null;
}): Promise<OrchestratorToolSourceContext> {
  const chat = input.instanceId ? input.chatStore.getByInstanceId(input.instanceId) : null;
  const fallbackMessageId = `mcp-tool:${Date.now()}`;
  if (!chat) {
    if (input.ledger && input.preferredConversationId) {
      return {
        chatId: null,
        threadId: input.preferredConversationId,
        sourceMessageId: await latestSourceMessageId(
          input.ledger,
          input.preferredConversationId,
          fallbackMessageId,
        ),
      };
    }
    return { chatId: null, threadId: 'mcp-standalone', sourceMessageId: fallbackMessageId };
  }

  return {
    chatId: chat.id,
    threadId: chat.ledgerThreadId,
    sourceMessageId: input.ledger
      ? await latestSourceMessageId(input.ledger, chat.ledgerThreadId, fallbackMessageId)
      : fallbackMessageId,
  };
}

async function latestSourceMessageId(
  ledger: ConversationLedgerService,
  threadId: string,
  fallback: string,
): Promise<string> {
  try {
    const conversation = await ledger.getRecentConversation(threadId, SOURCE_CONTEXT_MESSAGE_LIMIT);
    const latestToolCall = findLatestMessage(conversation.messages, (message) =>
      message.phase === 'tool_call'
      || asRecord(message.rawJson?.['metadata'])?.['kind'] === 'tool_call'
    );
    return latestToolCall?.id
      ?? findLatestMessage(conversation.messages, (message) => message.role === 'user')?.id
      ?? fallback;
  } catch {
    return fallback;
  }
}

function findLatestMessage(
  messages: ConversationMessageRecord[],
  predicate: (message: ConversationMessageRecord) => boolean,
): ConversationMessageRecord | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (predicate(messages[index])) return messages[index];
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
