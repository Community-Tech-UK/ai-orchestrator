export { ChannelManager } from './channel-manager';
export { BaseChannelAdapter } from './channel-adapter';
export type { ChannelAdapterEvents } from './channel-adapter';
export { RateLimiter } from './rate-limiter';
export { ChannelPersistence } from './channel-persistence';

import { ChannelManager } from './channel-manager';
import { ChannelPersistence } from './channel-persistence';
import { getRLMDatabase } from '../persistence/rlm-database';

export function getChannelManager(): ChannelManager {
  return ChannelManager.getInstance();
}

let persistenceInstance: ChannelPersistence | undefined;
export function getChannelPersistence(): ChannelPersistence {
  if (!persistenceInstance) {
    persistenceInstance = new ChannelPersistence(getRLMDatabase().getRawDb());
  }
  return persistenceInstance;
}
