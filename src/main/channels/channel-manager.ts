import { getLogger } from '../logging/logger';
import { BaseChannelAdapter } from './channel-adapter';
import type { ChannelPlatform, ChannelConnectionStatus, ChannelConfig } from '../../shared/types/channels';

const logger = getLogger('ChannelManager');

export class ChannelManager {
  private static instance: ChannelManager | null = null;
  private adapters = new Map<ChannelPlatform, BaseChannelAdapter>();

  static getInstance(): ChannelManager {
    if (!this.instance) {
      this.instance = new ChannelManager();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.adapters.clear();
    }
    this.instance = null;
  }

  private constructor() {
    logger.info('ChannelManager initialized');
  }

  registerAdapter(adapter: BaseChannelAdapter): void {
    if (this.adapters.has(adapter.platform)) {
      logger.warn('Adapter already registered, replacing', { platform: adapter.platform });
    }
    this.adapters.set(adapter.platform, adapter);
    logger.info('Adapter registered', { platform: adapter.platform });
  }

  unregisterAdapter(platform: ChannelPlatform): void {
    this.adapters.delete(platform);
    logger.info('Adapter unregistered', { platform });
  }

  getAdapter(platform: ChannelPlatform): BaseChannelAdapter | undefined {
    return this.adapters.get(platform);
  }

  getAllStatuses(): Map<ChannelPlatform, ChannelConnectionStatus> {
    const statuses = new Map<ChannelPlatform, ChannelConnectionStatus>();
    for (const [platform, adapter] of this.adapters) {
      statuses.set(platform, adapter.status);
    }
    return statuses;
  }

  async reconnect(platform: ChannelPlatform, config: ChannelConfig): Promise<void> {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new Error(`No adapter registered for ${platform}`);
    }
    logger.info('Reconnecting adapter', { platform });
    if (adapter.status === 'connected' || adapter.status === 'connecting') {
      await adapter.disconnect();
    }
    await adapter.connect(config);
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down all channel adapters');
    const promises = [...this.adapters.values()]
      .filter(a => a.status === 'connected' || a.status === 'connecting')
      .map(async (adapter) => {
        try {
          await adapter.disconnect();
        } catch (error) {
          logger.error('Failed to disconnect adapter', error instanceof Error ? error : undefined, { platform: adapter.platform });
        }
      });
    await Promise.all(promises);
    this.adapters.clear();
  }
}
