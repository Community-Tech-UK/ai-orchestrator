import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChannelPersistence } from '../channel-persistence';
import type { ChannelMessageRow } from '../../../shared/types/channels';

// Mock better-sqlite3 prepared statement
const mockRun = vi.fn();
const mockGet = vi.fn();
const mockAll = vi.fn();
const mockPrepare = vi.fn().mockReturnValue({ run: mockRun, get: mockGet, all: mockAll });

const mockDb = {
  prepare: mockPrepare,
} as any;

const baseMessage: Omit<ChannelMessageRow, 'created_at'> = {
  id: 'msg-1',
  platform: 'discord',
  chat_id: 'chat-1',
  message_id: 'discord-msg-1',
  thread_id: null,
  sender_id: 'user-1',
  sender_name: 'TestUser',
  content: 'Hello from Discord',
  direction: 'inbound',
  instance_id: null,
  reply_to_message_id: null,
  timestamp: 1000,
};

describe('ChannelPersistence', () => {
  let persistence: ChannelPersistence;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrepare.mockReturnValue({ run: mockRun, get: mockGet, all: mockAll });
    persistence = new ChannelPersistence(mockDb);
  });

  describe('saveMessage', () => {
    it('prepares and runs an INSERT statement', () => {
      persistence.saveMessage(baseMessage);

      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO channel_messages'),
      );
      expect(mockRun).toHaveBeenCalledWith(
        baseMessage.id,
        baseMessage.platform,
        baseMessage.chat_id,
        baseMessage.message_id,
        baseMessage.thread_id,
        baseMessage.sender_id,
        baseMessage.sender_name,
        baseMessage.content,
        baseMessage.direction,
        baseMessage.instance_id,
        baseMessage.reply_to_message_id,
        baseMessage.timestamp,
      );
    });
  });

  describe('getMessages', () => {
    it('queries without before cursor', () => {
      const rows: ChannelMessageRow[] = [{ ...baseMessage, created_at: 999 }];
      mockAll.mockReturnValueOnce(rows);

      const result = persistence.getMessages('discord', 'chat-1');

      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('WHERE platform = ? AND chat_id = ?'),
      );
      expect(mockAll).toHaveBeenCalledWith('discord', 'chat-1', 50);
      expect(result).toEqual(rows);
    });

    it('queries with before cursor', () => {
      const rows: ChannelMessageRow[] = [{ ...baseMessage, timestamp: 500, created_at: 999 }];
      mockAll.mockReturnValueOnce(rows);

      const result = persistence.getMessages('discord', 'chat-1', 10, 6000);

      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('AND timestamp < ?'),
      );
      expect(mockAll).toHaveBeenCalledWith('discord', 'chat-1', 6000, 10);
      expect(result).toEqual(rows);
    });

    it('uses provided limit', () => {
      mockAll.mockReturnValueOnce([]);
      persistence.getMessages('discord', 'chat-1', 25);
      expect(mockAll).toHaveBeenCalledWith('discord', 'chat-1', 25);
    });
  });

  describe('resolveInstanceByThread', () => {
    it('returns instance_id when a matching row is found', () => {
      mockGet.mockReturnValueOnce({ instance_id: 'instance-abc' });

      const result = persistence.resolveInstanceByThread('thread-1');

      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('WHERE thread_id = ?'),
      );
      expect(mockGet).toHaveBeenCalledWith('thread-1');
      expect(result).toBe('instance-abc');
    });

    it('returns null when no row is found', () => {
      mockGet.mockReturnValueOnce(undefined);

      const result = persistence.resolveInstanceByThread('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('updateInstanceId', () => {
    it('prepares and runs an UPDATE statement', () => {
      persistence.updateInstanceId('msg-1', 'instance-xyz');

      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE channel_messages SET instance_id = ?'),
      );
      expect(mockRun).toHaveBeenCalledWith('instance-xyz', 'msg-1');
    });
  });
});
