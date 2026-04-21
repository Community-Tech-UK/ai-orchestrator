/**
 * Channel Credential Store - Persists channel tokens to SQLite
 * so connections auto-reconnect on app restart.
 */

import type { SqliteDriver } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';

const logger = getLogger('ChannelCredentialStore');

export interface SavedCredential {
  platform: string;
  token: string;
  saved_at: number;
}

export class ChannelCredentialStore {
  constructor(private db: SqliteDriver) {}

  save(platform: string, token: string): void {
    this.db.prepare(`
      INSERT INTO channel_credentials (platform, token, saved_at)
      VALUES (?, ?, ?)
      ON CONFLICT(platform) DO UPDATE SET token = excluded.token, saved_at = excluded.saved_at
    `).run(platform, token, Date.now());
    logger.info('Credential saved', { platform });
  }

  remove(platform: string): void {
    this.db.prepare(`DELETE FROM channel_credentials WHERE platform = ?`).run(platform);
    logger.info('Credential removed', { platform });
  }

  getAll(): SavedCredential[] {
    return this.db.prepare(`SELECT * FROM channel_credentials`).all() as SavedCredential[];
  }

  get(platform: string): SavedCredential | undefined {
    return this.db.prepare(
      `SELECT * FROM channel_credentials WHERE platform = ?`
    ).get(platform) as SavedCredential | undefined;
  }
}
