import { describe, expect, it } from 'vitest';
import { CHAT_CHANNELS } from '../chat.channels';
import { IPC_CHANNELS } from '../index';

describe('chat channels', () => {
  it('defines the full durable chat IPC surface', () => {
    expect(CHAT_CHANNELS).toEqual({
      CHAT_LIST: 'chat:list',
      CHAT_GET: 'chat:get',
      CHAT_CREATE: 'chat:create',
      CHAT_RENAME: 'chat:rename',
      CHAT_ARCHIVE: 'chat:archive',
      CHAT_SET_CWD: 'chat:set-cwd',
      CHAT_SET_PROVIDER: 'chat:set-provider',
      CHAT_SET_MODEL: 'chat:set-model',
      CHAT_SET_REASONING: 'chat:set-reasoning',
      CHAT_SET_YOLO: 'chat:set-yolo',
      CHAT_SEND_MESSAGE: 'chat:send-message',
      CHAT_EVENT: 'chat:event',
    });
  });

  it('is exported through the combined IPC channel map for preload generation', () => {
    for (const [key, value] of Object.entries(CHAT_CHANNELS)) {
      expect(IPC_CHANNELS[key as keyof typeof IPC_CHANNELS]).toBe(value);
    }
  });
});
