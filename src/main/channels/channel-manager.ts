/**
 * Channel Manager - Singleton that manages platform adapters
 */

import { getLogger } from '../logging/logger';
import { BaseChannelAdapter } from './channel-adapter';
import { registerCleanup } from '../util/cleanup-registry';
import type {
  ChannelPlatform,
  ChannelConnectionStatus,
  ChannelStatusEvent,
  ChannelErrorEvent,
  InboundChannelMessage,
} from '../../shared/types/channels';

const logger = getLogger('ChannelManager');

export type ChannelEvent =
  | { type: 'message'; data: InboundChannelMessage }
  | { type: 'status'; data: ChannelStatusEvent }
  | { type: 'error'; data: ChannelErrorEvent }
  | { type: 'qr'; data: string };

type ChannelEventListener = (event: ChannelEvent) => void;

export class ChannelManager {
  private static instance: ChannelManager;
  private adapters = new Map<ChannelPlatform, BaseChannelAdapter>();
  private listeners = new Set<ChannelEventListener>();

  static getInstance(): ChannelManager {
    if (!this.instance) {
      this.instance = new ChannelManager();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.adapters.clear();
      this.instance.listeners.clear();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).instance = undefined;
  }

  private constructor() {
    registerCleanup(() => this.shutdown());
  }

  registerAdapter(adapter: BaseChannelAdapter): void {
    const existing = this.adapters.get(adapter.platform);
    if (existing) {
      existing.removeAllListeners();
    }

    this.adapters.set(adapter.platform, adapter);
    this.subscribeToAdapter(adapter);
    logger.info('Adapter registered', { platform: adapter.platform });
  }

  unregisterAdapter(platform: ChannelPlatform): void {
    const adapter = this.adapters.get(platform);
    if (adapter) {
      adapter.removeAllListeners();
      this.adapters.delete(platform);
      logger.info('Adapter unregistered', { platform });
    }
  }

  getAdapter(platform: ChannelPlatform): BaseChannelAdapter | undefined {
    return this.adapters.get(platform);
  }

  getStatuses(): Record<ChannelPlatform, ChannelConnectionStatus | 'unregistered'> {
    return {
      discord: this.adapters.get('discord')?.status ?? 'unregistered',
      whatsapp: this.adapters.get('whatsapp')?.status ?? 'unregistered',
    };
  }

  onEvent(listener: ChannelEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down all channel adapters');
    const promises: Promise<void>[] = [];
    for (const [platform, adapter] of this.adapters) {
      if (adapter.status === 'connected' || adapter.status === 'connecting') {
        promises.push(
          adapter.disconnect().catch(err => {
            logger.error(`Error disconnecting ${platform}`, err instanceof Error ? err : new Error(String(err)));
          })
        );
      }
    }
    await Promise.all(promises);
  }

  private subscribeToAdapter(adapter: BaseChannelAdapter): void {
    adapter.on('message', (data: InboundChannelMessage) => {
      this.notifyListeners({ type: 'message', data });
    });

    adapter.on('status', (data: ChannelStatusEvent) => {
      this.notifyListeners({ type: 'status', data });
    });

    adapter.on('error', (data: ChannelErrorEvent) => {
      this.notifyListeners({ type: 'error', data });
    });

    adapter.on('qr', (data: string) => {
      this.notifyListeners({ type: 'qr', data });
    });
  }

  private notifyListeners(event: ChannelEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        logger.error('Error in channel event listener', err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
}

export function getChannelManager(): ChannelManager {
  return ChannelManager.getInstance();
}
