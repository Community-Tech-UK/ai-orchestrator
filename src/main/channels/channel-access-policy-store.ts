/**
 * Channel Access Policy Store - Persists access policies (paired senders, mode)
 * to SQLite so they survive app restarts.
 */

import type { SqliteDriver } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';
import type { AccessPolicy } from '../../shared/types/channels';

const logger = getLogger('ChannelAccessPolicyStore');

export interface SavedAccessPolicy {
  platform: string;
  mode: string;
  allowed_senders_json: string;
  updated_at: number;
}

export class ChannelAccessPolicyStore {
  constructor(private db: SqliteDriver) {}

  /**
   * Save or update the access policy for a platform.
   * Only persists mode and allowedSenders (pendingPairings are ephemeral).
   */
  save(platform: string, policy: AccessPolicy): void {
    this.db.prepare(`
      INSERT INTO channel_access_policies (platform, mode, allowed_senders_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(platform) DO UPDATE SET
        mode = excluded.mode,
        allowed_senders_json = excluded.allowed_senders_json,
        updated_at = excluded.updated_at
    `).run(
      platform,
      policy.mode,
      JSON.stringify(policy.allowedSenders),
      Date.now(),
    );
    logger.info('Access policy saved', { platform, mode: policy.mode, senderCount: policy.allowedSenders.length });
  }

  /**
   * Add a single sender to the persisted allowlist without replacing the whole policy.
   */
  addAllowedSender(platform: string, senderId: string): void {
    const existing = this.get(platform);
    if (existing) {
      const senders: string[] = JSON.parse(existing.allowed_senders_json);
      if (!senders.includes(senderId)) {
        senders.push(senderId);
        this.db.prepare(`
          UPDATE channel_access_policies
          SET allowed_senders_json = ?, updated_at = ?
          WHERE platform = ?
        `).run(JSON.stringify(senders), Date.now(), platform);
        logger.info('Allowed sender added', { platform, senderId });
      }
    } else {
      // No policy row yet — create one with defaults + this sender
      this.db.prepare(`
        INSERT INTO channel_access_policies (platform, mode, allowed_senders_json, updated_at)
        VALUES (?, 'pairing', ?, ?)
      `).run(platform, JSON.stringify([senderId]), Date.now());
      logger.info('Access policy created with sender', { platform, senderId });
    }
  }

  /**
   * Load the saved policy for a platform, or undefined if none.
   */
  get(platform: string): SavedAccessPolicy | undefined {
    return this.db.prepare(
      `SELECT * FROM channel_access_policies WHERE platform = ?`
    ).get(platform) as SavedAccessPolicy | undefined;
  }

  /**
   * Load all saved policies.
   */
  getAll(): SavedAccessPolicy[] {
    return this.db.prepare(`SELECT * FROM channel_access_policies`).all() as SavedAccessPolicy[];
  }

  /**
   * Remove the saved policy for a platform.
   */
  remove(platform: string): void {
    this.db.prepare(`DELETE FROM channel_access_policies WHERE platform = ?`).run(platform);
    logger.info('Access policy removed', { platform });
  }

  /**
   * Convert a saved row back into the in-memory AccessPolicy shape.
   */
  toAccessPolicy(saved: SavedAccessPolicy): Pick<AccessPolicy, 'mode' | 'allowedSenders'> {
    return {
      mode: saved.mode as AccessPolicy['mode'],
      allowedSenders: JSON.parse(saved.allowed_senders_json) as string[],
    };
  }
}
