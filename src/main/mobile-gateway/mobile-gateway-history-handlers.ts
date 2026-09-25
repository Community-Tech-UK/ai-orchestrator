import type { ServerResponse } from 'http';
import type { SubsystemLogger } from '../logging/logger';
import type {
  MobileHistorySessionDto,
  MobileMessagesResumeDto,
} from '../../shared/types/mobile-gateway.types';
import type { OutputMessage } from '../../shared/types/instance.types';
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
import type { MobileGatewayStreamCursor } from './mobile-gateway-stream-cursor';

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
        .map((msg) => serializeMessage(msg))
        .filter((dto): dto is NonNullable<typeof dto> => dto !== null);
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

/** What the instance-transcript route needs; kept narrow so it stays testable. */
export interface MobileInstanceMessagesDeps {
  getInstance: (instanceId: string) => {
    outputBuffer?: OutputMessage[];
    adapterGeneration?: number;
  } | null | undefined;
  streamCursor?: MobileGatewayStreamCursor;
  markCompletionViewed: (instanceId: string) => void;
  messageReplayLimit: number;
  sendJson: (res: ServerResponse, statusCode: number, payload: unknown) => void;
  logger: SubsystemLogger;
}

/**
 * GET /api/instances/:id/messages — the live transcript, with `fromSeq` resume.
 * Lives here rather than on the server so the routing class stays a router.
 */
export function handleMobileInstanceMessages(
deps: MobileInstanceMessagesDeps,
res: ServerResponse,
instanceId: string,
url: URL,
): void {
  const instance = deps.getInstance(instanceId);
  if (!instance) {
    deps.sendJson(res, 404, { error: 'Instance not found' });
    return;
  }

  // Fetching the transcript means the phone is viewing this session — drop its
  // unread completion dot (mirrors the desktop "selected instance" clear).
  deps.markCompletionViewed(instanceId);

  const buffer = instance.outputBuffer ?? [];
  const cursor = deps.streamCursor?.inspect(instanceId, buffer);
  const offset = cursor?.offset ?? 0;
  const rawFromSeq = url.searchParams.get('fromSeq');

  // Absent fromSeq: legacy path — last deps.messageReplayLimit messages, byte-for-byte
  // equivalent to before except each DTO now carries its buffer index as `seq`.
  if (rawFromSeq === null) {
    const start = Math.max(0, buffer.length - deps.messageReplayLimit);
    const messages = buffer
      .slice(start)
      .map((msg, sliceIdx) => serializeMessage(msg, offset + start + sliceIdx))
      .filter((dto): dto is NonNullable<typeof dto> => dto !== null);
    if (url.searchParams.get('withCursor') === '1') {
      const envelope: MobileMessagesResumeDto = {
        messages,
        meta: {
          fromSeq: -1,
          returned: messages.length,
          hasMore: start > 0,
          maxSeq: messages.at(-1)?.seq ?? -1,
          ...(cursor ? { bufferGeneration: cursor.bufferGeneration } : {}),
          ...(cursor ? { cursorEpoch: cursor.cursorEpoch } : {}),
          ...(instance.adapterGeneration !== undefined
            ? { adapterGeneration: instance.adapterGeneration }
            : {}),
          ...(cursor ? { streamSeq: cursor.nextStreamSeq - 1 } : {}),
        },
      };
      deps.sendJson(res, 200, envelope);
      return;
    }
    deps.sendJson(res, 200, messages);
    return;
  }

  // fromSeq present: parse and validate.
  const parsed = Number(rawFromSeq);
  // Treat NaN, negative, or non-integer as "start from 0" (safe degradation —
  // the client sent garbage but we still serve something useful rather than 400).
  const fromSeq = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;

  // Messages with buffer index strictly greater than fromSeq.
  // "seq" of message at buffer[i] === i (0-based).
  // Slice from (fromSeq + 1) onward, then cap to deps.messageReplayLimit.
  const includeFrom = url.searchParams.get('includeFrom') === '1';
  const firstIdx = Math.max(0, fromSeq - offset + (includeFrom ? 0 : 1));
  const bufferEndSeq = offset + buffer.length - 1;
  const cursorFellBehind = includeFrom ? fromSeq < offset : fromSeq < offset - 1;
  const bufferReset = fromSeq > bufferEndSeq;
  const available = Math.max(0, buffer.length - firstIdx);
  const hasMore = cursorFellBehind || available > deps.messageReplayLimit;
  // Take at most deps.messageReplayLimit messages starting at firstIdx.
  const sliceEnd = firstIdx + deps.messageReplayLimit;
  const sliced = buffer.slice(firstIdx, sliceEnd);
  const messages = sliced
    .map((msg, sliceIdx) => serializeMessage(msg, offset + firstIdx + sliceIdx))
    .filter((dto): dto is NonNullable<typeof dto> => dto !== null);

  // LT-196: last survivor's own `seq`, not a count — a count under-reports
  // once a message is filtered from mid-window, redelivering on resume.
  const maxSeq = messages.at(-1)?.seq ?? fromSeq;

  deps.logger.info('Mobile: client attached from seq', {
    instanceId,
    fromSeq,
    returned: messages.length,
    hasMore,
    bufferLength: buffer.length,
  });

  const envelope: MobileMessagesResumeDto = {
    messages,
    meta: {
      fromSeq,
      returned: messages.length,
      hasMore,
      maxSeq,
      ...(cursor ? { bufferGeneration: cursor.bufferGeneration } : {}),
      ...(cursor ? { cursorEpoch: cursor.cursorEpoch } : {}),
      ...(bufferReset ? { bufferReset: true } : {}),
      ...(instance.adapterGeneration !== undefined
        ? { adapterGeneration: instance.adapterGeneration }
        : {}),
      ...(cursor ? { streamSeq: cursor.nextStreamSeq - 1 } : {}),
    },
  };
  deps.sendJson(res, 200, envelope);
}
