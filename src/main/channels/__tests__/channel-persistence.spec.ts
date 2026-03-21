import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ChannelPersistence } from '../channel-persistence';
import type { InboundChannelMessage } from '../../../shared/types/channels';

describe('ChannelPersistence', () => {
  let db: Database.Database;
  let persistence: ChannelPersistence;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE channel_messages (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        thread_id TEXT,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        content TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        instance_id TEXT,
        reply_to_message_id TEXT,
        timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );
      CREATE INDEX idx_channel_messages_thread ON channel_messages(thread_id);
    `);
    persistence = new ChannelPersistence(db);
  });

  afterEach(() => {
    db.close();
  });

  const makeMessage = (overrides?: Partial<InboundChannelMessage>): InboundChannelMessage => ({
    id: 'msg-1',
    platform: 'discord',
    chatId: 'chat-123',
    messageId: 'discord-msg-1',
    senderId: 'user-1',
    senderName: 'TestUser',
    content: 'Hello world',
    attachments: [],
    isGroup: false,
    isDM: true,
    timestamp: Date.now(),
    ...overrides,
  });

  it('should insert and retrieve messages', () => {
    const msg = makeMessage();
    persistence.insertMessage(msg, 'inbound');
    const results = persistence.getMessages('discord', 'chat-123');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Hello world');
    expect(results[0].direction).toBe('inbound');
  });

  it('should resolve instance for thread', () => {
    const msg = makeMessage({ threadId: 'thread-1' });
    persistence.insertMessage(msg, 'inbound', 'instance-5');
    const instanceId = persistence.getInstanceForThread('thread-1');
    expect(instanceId).toBe('instance-5');
  });

  it('should return undefined for unknown thread', () => {
    expect(persistence.getInstanceForThread('nonexistent')).toBeUndefined();
  });

  it('should paginate with before cursor', () => {
    persistence.insertMessage(makeMessage({ id: 'msg-1', timestamp: 1000, messageId: 'm1' }), 'inbound');
    persistence.insertMessage(makeMessage({ id: 'msg-2', timestamp: 2000, messageId: 'm2' }), 'inbound');
    persistence.insertMessage(makeMessage({ id: 'msg-3', timestamp: 3000, messageId: 'm3' }), 'inbound');

    const results = persistence.getMessages('discord', 'chat-123', { before: 3000, limit: 10 });
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('msg-1');
  });

  it('should delete messages older than timestamp', () => {
    persistence.insertMessage(makeMessage({ id: 'old', timestamp: 1000, messageId: 'm1' }), 'inbound');
    persistence.insertMessage(makeMessage({ id: 'new', timestamp: 5000, messageId: 'm2' }), 'inbound');
    const deleted = persistence.deleteOlderThan(3000);
    expect(deleted).toBe(1);
    const remaining = persistence.getMessages('discord', 'chat-123');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('new');
  });
});
