import type { ServerResponse } from 'http';
import type { SubsystemLogger } from '../logging/logger';
import type { MobileHistorySessionDto } from '../../shared/types/mobile-gateway.types';
import {
  serializeHistoryMessage,
  serializeHistorySession,
  serializeInstanceHistorySession,
  serializeMessage,
} from './mobile-gateway-serializers';
import type {
  GatewayChatHistorySource,
  GatewayInstanceHistorySource,
} from './mobile-gateway-serializers';

const HISTORY_CHAT_PREFIX = 'chat:';
const HISTORY_INSTANCE_PREFIX = 'inst:';

interface MobileHistoryHandlerDeps {
  chatHistory: GatewayChatHistorySource | null;
  instanceHistory: GatewayInstanceHistorySource | null;
  messageReplayLimit: number;
  sendJson: (res: ServerResponse, statusCode: number, payload: unknown) => void;
  logger: SubsystemLogger;
}

export function handleMobileHistory(
  deps: MobileHistoryHandlerDeps,
  res: ServerResponse,
): void {
  const sessions: MobileHistorySessionDto[] = [];

  const chatSource = deps.chatHistory;
  if (chatSource) {
    try {
      for (const chat of chatSource.listChats({ includeArchived: true })) {
        const dto = serializeHistorySession(chat);
        sessions.push({ ...dto, id: `${HISTORY_CHAT_PREFIX}${dto.id}` });
      }
    } catch (err) {
      deps.logger.warn('Chat history list failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const instanceSource = deps.instanceHistory;
  if (instanceSource) {
    try {
      for (const entry of instanceSource.getEntries({ limit: 500 })) {
        const dto = serializeInstanceHistorySession(entry);
        sessions.push({ ...dto, id: `${HISTORY_INSTANCE_PREFIX}${dto.id}` });
      }
    } catch (err) {
      deps.logger.warn('Instance history list failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  deps.sendJson(res, 200, sessions);
}

export async function handleMobileHistoryMessages(
  deps: MobileHistoryHandlerDeps,
  res: ServerResponse,
  id: string,
): Promise<void> {
  try {
    if (id.startsWith(HISTORY_INSTANCE_PREFIX)) {
      const source = deps.instanceHistory;
      if (!source) {
        deps.sendJson(res, 404, { error: 'History unavailable' });
        return;
      }
      const data = await source.loadConversation(id.slice(HISTORY_INSTANCE_PREFIX.length));
      if (!data) {
        deps.sendJson(res, 404, { error: 'Session not found' });
        return;
      }
      const messages = (data.messages ?? [])
        .slice(-deps.messageReplayLimit)
        .map(serializeMessage);
      deps.sendJson(res, 200, messages);
      return;
    }

    const source = deps.chatHistory;
    if (!source) {
      deps.sendJson(res, 404, { error: 'History unavailable' });
      return;
    }
    const chatId = id.startsWith(HISTORY_CHAT_PREFIX)
      ? id.slice(HISTORY_CHAT_PREFIX.length)
      : id;
    const detail = await source.getChat(chatId);
    const messages = (detail.conversation.messages ?? [])
      .slice(-deps.messageReplayLimit)
      .map(serializeHistoryMessage);
    deps.sendJson(res, 200, messages);
  } catch {
    deps.sendJson(res, 404, { error: 'Session not found' });
  }
}
