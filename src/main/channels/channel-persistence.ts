/**
 * Channel Persistence - SQLite queries for channel_messages table
 */

import type Database from 'better-sqlite3';
import type { ChannelMessageRow } from '../../shared/types/channels';

type SaveMessageParams = Omit<ChannelMessageRow, 'created_at'>;

export class ChannelPersistence {
  constructor(private db: Database.Database) {}

  saveMessage(msg: SaveMessageParams): void {
    const stmt = this.db.prepare(`
      INSERT INTO channel_messages
        (id, platform, chat_id, message_id, thread_id, sender_id, sender_name,
         content, direction, instance_id, reply_to_message_id, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      msg.id, msg.platform, msg.chat_id, msg.message_id, msg.thread_id,
      msg.sender_id, msg.sender_name, msg.content, msg.direction,
      msg.instance_id, msg.reply_to_message_id, msg.timestamp,
    );
  }

  getMessages(
    platform: string,
    chatId: string,
    limit = 50,
    before?: number,
  ): ChannelMessageRow[] {
    if (before) {
      return this.db.prepare(`
        SELECT * FROM channel_messages
        WHERE platform = ? AND chat_id = ? AND timestamp < ?
        ORDER BY timestamp DESC LIMIT ?
      `).all(platform, chatId, before, limit) as ChannelMessageRow[];
    }
    return this.db.prepare(`
      SELECT * FROM channel_messages
      WHERE platform = ? AND chat_id = ?
      ORDER BY timestamp DESC LIMIT ?
    `).all(platform, chatId, limit) as ChannelMessageRow[];
  }

  resolveInstanceByThread(threadId: string): string | null {
    const row = this.db.prepare(`
      SELECT instance_id FROM channel_messages
      WHERE thread_id = ? AND instance_id IS NOT NULL
      ORDER BY timestamp DESC LIMIT 1
    `).get(threadId) as { instance_id: string } | undefined;
    return row?.instance_id ?? null;
  }

  updateInstanceId(messageId: string, instanceId: string): void {
    this.db.prepare(`
      UPDATE channel_messages SET instance_id = ? WHERE id = ?
    `).run(instanceId, messageId);
  }
}
