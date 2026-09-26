import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { handleMobileHistoryMessages } from './mobile-gateway-history-handlers';
import type { OutputMessage } from '../../shared/types/instance.types';

describe('Archived transcript paging', () => {
  for (const id of ['inst:old', 'chat:old']) {
    it(`pages ${id} without losing stable sequence indexes`, async () => {
      const messages: OutputMessage[] = Array.from({ length: 1000 }, (_, i) => ({ id: `m${i}`, type: 'assistant', timestamp: i, content: `Message ${i}` }));
      const sendJson = vi.fn();
      const deps = { messageReplayLimit: 300, sendJson, logger: { warn: vi.fn() } as never,
        instanceHistory: { getEntries: () => [], loadConversation: async () => ({ messages }) },
        chatHistory: { listChats: () => [], getChat: async () => ({ conversation: { messages: messages.map(m => ({ id: m.id, role: m.type, content: m.content, createdAt: m.timestamp })) } }) } };
      await handleMobileHistoryMessages(deps, {} as ServerResponse, id, new URL('http://preview/api/history/old/messages?beforeSeq=700&limit=100'));
      const [res, code, body] = sendJson.mock.calls[0];
      void res;
      expect(code).toBe(200);
      expect(body.messages).toHaveLength(100);
      expect(body.messages[0].seq).toBe(600);
      expect(body.messages.at(-1).seq).toBe(699);
      expect(body.meta).toMatchObject({ hasMore: true, nextBeforeSeq: 600 });
    });
  }
});
