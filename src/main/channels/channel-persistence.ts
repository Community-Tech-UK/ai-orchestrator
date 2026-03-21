import type Database from 'better-sqlite3';
import type { ChannelPlatform, InboundChannelMessage, StoredChannelMessage } from '../../shared/types/channels';

export class ChannelPersistence {
  private db: Database.Database;

  private static readonly SELECT_COLS = `
    id, platform,
    chat_id AS chatId,
    message_id AS messageId,
    thread_id AS threadId,
    sender_id AS senderId,
    sender_name AS senderName,
    content, direction,
    instance_id AS instanceId,
    reply_to_message_id AS replyToMessageId,
    timestamp,
    created_at AS createdAt
  `;

  constructor(db: Database.Database) {
    this.db = db;
  }

  insertMessage(msg: InboundChannelMessage, direction: 'inbound' | 'outbound', instanceId?: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO channel_messages (id, platform, chat_id, message_id, thread_id, sender_id, sender_name, content, direction, instance_id, reply_to_message_id, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      msg.id, msg.platform, msg.chatId, msg.messageId, msg.threadId ?? null,
      msg.senderId, msg.senderName, msg.content, direction,
      instanceId ?? null, msg.replyTo ?? null, msg.timestamp
    );
  }

  getMessages(
    platform: ChannelPlatform,
    chatId: string,
    opts?: { limit?: number; before?: number }
  ): StoredChannelMessage[] {
    const limit = opts?.limit ?? 50;
    if (opts?.before != null) {
      const stmt = this.db.prepare(`
        SELECT ${ChannelPersistence.SELECT_COLS} FROM channel_messages
        WHERE platform = ? AND chat_id = ? AND timestamp < ?
        ORDER BY timestamp ASC LIMIT ?
      `);
      return stmt.all(platform, chatId, opts.before, limit) as StoredChannelMessage[];
    }
    const stmt = this.db.prepare(`
      SELECT ${ChannelPersistence.SELECT_COLS} FROM channel_messages
      WHERE platform = ? AND chat_id = ?
      ORDER BY timestamp ASC LIMIT ?
    `);
    return stmt.all(platform, chatId, limit) as StoredChannelMessage[];
  }

  getInstanceForThread(threadId: string): string | undefined {
    const stmt = this.db.prepare(`
      SELECT instance_id AS instanceId FROM channel_messages
      WHERE thread_id = ? AND instance_id IS NOT NULL
      ORDER BY timestamp DESC LIMIT 1
    `);
    const row = stmt.get(threadId) as { instanceId: string } | undefined;
    return row?.instanceId;
  }

  getMessagesByInstance(instanceId: string): StoredChannelMessage[] {
    const stmt = this.db.prepare(`
      SELECT ${ChannelPersistence.SELECT_COLS} FROM channel_messages
      WHERE instance_id = ? ORDER BY timestamp ASC
    `);
    return stmt.all(instanceId) as StoredChannelMessage[];
  }

  deleteOlderThan(timestampMs: number): number {
    const stmt = this.db.prepare(`DELETE FROM channel_messages WHERE timestamp < ?`);
    return stmt.run(timestampMs).changes;
  }
}
