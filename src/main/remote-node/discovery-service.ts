import { Bonjour, type Service } from 'bonjour-service';
import { getLogger } from '../logging/logger';

const logger = getLogger('DiscoveryService');

let instance: DiscoveryService | null = null;

export class DiscoveryService {
  private bonjour: Bonjour | null = null;
  private published: Service | null = null;

  static getInstance(): DiscoveryService {
    if (!instance) {
      instance = new DiscoveryService();
    }
    return instance;
  }

  static _resetForTesting(): void {
    instance?.unpublish();
    instance = null;
  }

  publish(port: number, namespace: string, coordinatorId: string): void {
    try {
      this.bonjour = new Bonjour();
      this.published = this.bonjour.publish({
        name: `orchestrator-${coordinatorId.slice(0, 8)}`,
        type: 'ai-orchestrator',
        port,
        txt: {
          version: '1.0',
          namespace,
          auth: 'token',
        },
      });
      logger.info('mDNS service published', { port, namespace });
    } catch (err) {
      logger.warn('Failed to publish mDNS service', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  unpublish(): void {
    try {
      if (this.bonjour) {
        this.bonjour.unpublishAll();
        this.bonjour.destroy();
        this.bonjour = null;
        this.published = null;
        logger.info('mDNS service unpublished');
      }
    } catch (err) {
      logger.warn('Failed to unpublish mDNS service', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  get isPublished(): boolean {
    return this.published !== null;
  }
}

export function getDiscoveryService(): DiscoveryService {
  return DiscoveryService.getInstance();
}
