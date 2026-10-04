import type { ConversationMessageRecord } from '../../shared/types/conversation-ledger.types';
import type { ChatStore } from '../chats/chat-store';
import type { ConversationLedgerService } from '../conversation-ledger';

const SOURCE_CONTEXT_MESSAGE_LIMIT = 200;

export interface OrchestratorToolSourceContext {
  chatId: string | null;
  threadId: string;
  sourceMessageId: string;
  failureReason?: 'SOURCE_LOOKUP_FAILED';
}

export async function resolveOrchestratorToolSourceContext(input: {
  chatStore: ChatStore;
  ledger: ConversationLedgerService | null;
  instanceId: string | null;
  preferredConversationId?: string | null;
  toolName?: string;
}): Promise<OrchestratorToolSourceContext> {
  const chat = input.instanceId ? input.chatStore.getByInstanceId(input.instanceId) : null;
  const fallbackMessageId = `mcp-tool:${Date.now()}`;
  if (!chat) {
    if (input.ledger && input.preferredConversationId) {
      return {
        chatId: null,
        threadId: input.preferredConversationId,
        ...await latestSourceMessage(
          input.ledger,
          input.preferredConversationId,
          fallbackMessageId,
          input.instanceId,
          input.toolName,
        ),
      };
    }
    return { chatId: null, threadId: 'mcp-standalone', sourceMessageId: fallbackMessageId };
  }

  return {
    chatId: chat.id,
    threadId: chat.ledgerThreadId,
    ...(input.ledger
      ? await latestSourceMessage(input.ledger, chat.ledgerThreadId, fallbackMessageId, input.instanceId, input.toolName)
      : { sourceMessageId: fallbackMessageId }),
  };
}

async function latestSourceMessage(
  ledger: ConversationLedgerService,
  threadId: string,
  fallback: string,
  instanceId: string | null,
  toolName?: string,
): Promise<Pick<OrchestratorToolSourceContext, 'sourceMessageId' | 'failureReason'>> {
  try {
    const conversation = await ledger.getRecentConversation(threadId, SOURCE_CONTEXT_MESSAGE_LIMIT);
    const messages = conversation.messages.filter((message) => {
      const owner = asRecord(message.rawJson?.['metadata'])?.['instanceId'];
      return owner === undefined || owner === instanceId;
    });
    const user = findLatestMessage(messages, (message) => message.role === 'user');
    // MCP carries no provider-native call ID. A genuine user is the reliable
    // turn anchor even if an earlier same-tool call still awaits its event.
    if (toolName && user) return { sourceMessageId: user.id };
    const currentTurn = user ? messages.slice(messages.indexOf(user) + 1) : messages;
    const pendingCalls = currentTurn.filter((message, index) => {
      const metadata = asRecord(message.rawJson?.['metadata']);
      const isToolCall = message.phase === 'tool_call' || metadata?.['kind'] === 'tool_call';
      const recordedName = metadata?.['toolName'];
      // Older records lack a name. Retain their recorded provenance; named
      // records must match this tool, never borrow a different tool's call.
      if (!isToolCall || (toolName && recordedName !== undefined && !matchesToolName(recordedName, toolName))) return false;
      if (!toolName) return true;
      return !currentTurn.slice(index + 1).some((later) => {
        const resultMetadata = asRecord(later.rawJson?.['metadata']);
        if (later.phase !== 'tool_result' && resultMetadata?.['kind'] !== 'tool_result') return false;
        const callId = metadata?.['toolUseId'];
        const resultId = resultMetadata?.['toolUseId'];
        if (typeof callId === 'string' && typeof resultId === 'string') return callId === resultId;
        const resultName = resultMetadata?.['toolName'];
        return resultName === undefined || matchesToolName(resultName, toolName);
      });
    });
    // Without a user anchor, require a single pending matching native call;
    // ambiguous or completed calls cannot provide provenance for this request.
    // Invocation identity is minted by the wrapper independently of this source.
    const latestToolCall = toolName
      ? (pendingCalls.length === 1 ? pendingCalls[0] : undefined)
      : pendingCalls.at(-1);
    return { sourceMessageId: latestToolCall?.id ?? user?.id ?? fallback };
  } catch {
    return { sourceMessageId: fallback, failureReason: 'SOURCE_LOOKUP_FAILED' };
  }
}

function matchesToolName(recorded: unknown, toolName: string): boolean {
  return typeof recorded === 'string'
    && (recorded === toolName || recorded.endsWith(`__${toolName}`) || recorded === `orchestrator.${toolName}`);
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
