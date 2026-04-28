/**
 * Persisted channel and DM route pins.
 */

import type { SqliteDriver } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';
import type { ChannelPlatform } from '../../shared/types/channels';

const logger = getLogger('ChannelRouteStore');

export type ChannelRouteScope = 'chat' | 'dm';

export type SavedChannelRoutePin =
  | { kind: 'instance'; instanceId: string }
  | { kind: 'project'; projectKey: string; label: string; workingDirectory: string | null };

interface ChannelRouteRow {
  platform: string;
  scope: ChannelRouteScope;
  route_key: string;
  pin_json: string;
  updated_at: number;
}

export class ChannelRouteStore {
  constructor(private db: SqliteDriver) {}

  savePin(
    platform: ChannelPlatform,
    scope: ChannelRouteScope,
    routeKey: string,
    pin: SavedChannelRoutePin,
  ): void {
    this.db.prepare(`
      INSERT INTO channel_route_pins (platform, scope, route_key, pin_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(platform, scope, route_key) DO UPDATE SET
        pin_json = excluded.pin_json,
        updated_at = excluded.updated_at
    `).run(platform, scope, routeKey, JSON.stringify(pin), Date.now());
    logger.info('Channel route pin saved', { platform, scope, routeKey, kind: pin.kind });
  }

  getPin(
    platform: ChannelPlatform,
    scope: ChannelRouteScope,
    routeKey: string,
  ): SavedChannelRoutePin | null {
    const row = this.db.prepare(`
      SELECT * FROM channel_route_pins
      WHERE platform = ? AND scope = ? AND route_key = ?
    `).get(platform, scope, routeKey) as ChannelRouteRow | undefined;
    if (!row) {
      return null;
    }
    return JSON.parse(row.pin_json) as SavedChannelRoutePin;
  }

  removePin(platform: ChannelPlatform, scope: ChannelRouteScope, routeKey: string): void {
    this.db.prepare(`
      DELETE FROM channel_route_pins
      WHERE platform = ? AND scope = ? AND route_key = ?
    `).run(platform, scope, routeKey);
    logger.info('Channel route pin removed', { platform, scope, routeKey });
  }

  removePlatform(platform: ChannelPlatform): void {
    this.db.prepare(`DELETE FROM channel_route_pins WHERE platform = ?`).run(platform);
    logger.info('Channel route pins removed', { platform });
  }
}
