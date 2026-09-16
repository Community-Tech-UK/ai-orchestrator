/**
 * Cross-Instance Communication Service
 *
 * Manages bidirectional communication bridges between instances,
 * allowing them to exchange messages and subscribe to bridge events.
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import {
  MemoryCrossInstanceCommStore,
  type CommBridge,
  type CommMessage,
  type CrossInstanceCommStore,
} from './cross-instance-comm-store';

export type { CommBridge, CommMessage, CrossInstanceCommStore } from './cross-instance-comm-store';
export { MemoryCrossInstanceCommStore } from './cross-instance-comm-store';

const logger = getLogger('CrossInstanceComm');

export class CrossInstanceCommService extends EventEmitter {
  private static instance: CrossInstanceCommService | null = null;

  static getInstance(): CrossInstanceCommService {
    this.instance ??= new CrossInstanceCommService();
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.removeAllListeners();
      this.instance.store.clear();
    }
    this.instance = null;
  }

  static createForTesting(
    store: CrossInstanceCommStore = new MemoryCrossInstanceCommStore(),
  ): CrossInstanceCommService {
    return new CrossInstanceCommService(store);
  }

  private constructor(
    private readonly store: CrossInstanceCommStore = new MemoryCrossInstanceCommStore(),
  ) {
    super();
  }

  /**
   * Creates a bidirectional communication bridge between two instances.
   */
  createBridge(name: string, sourceInstanceId: string, targetInstanceId: string): CommBridge {
    const id = crypto.randomUUID();
    const bridge: CommBridge = {
      id,
      name,
      sourceInstanceId,
      targetInstanceId,
      createdAt: Date.now(),
      messageCount: 0,
    };

    this.store.createBridge(bridge);

    logger.info('Bridge created', { bridgeId: id, name, sourceInstanceId, targetInstanceId });
    this.emit('bridge:created', bridge);

    return bridge;
  }

  /**
   * Removes a bridge and all of its messages.
   * Also removes the bridge from any subscriptions.
   */
  deleteBridge(bridgeId: string): boolean {
    if (!this.store.deleteBridge(bridgeId)) {
      logger.warn('Attempted to delete non-existent bridge', { bridgeId });
      return false;
    }

    logger.info('Bridge deleted', { bridgeId });
    this.emit('bridge:deleted', { bridgeId });

    return true;
  }

  /**
   * Returns all bridges.
   */
  getBridges(): CommBridge[] {
    return this.store.listBridges();
  }

  /**
   * Returns bridges where the given instance is either the source or target.
   */
  getBridgesForInstance(instanceId: string): CommBridge[] {
    return this.store.listBridges().filter(
      (bridge) =>
        bridge.sourceInstanceId === instanceId || bridge.targetInstanceId === instanceId,
    );
  }

  /**
   * Creates a message on a bridge, emits a 'message' event, and returns the message.
   * Validates that the bridge exists and that fromInstanceId is a participant.
   */
  sendMessage(
    bridgeId: string,
    fromInstanceId: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): CommMessage {
    const bridge = this.store.getBridge(bridgeId);
    if (!bridge) {
      throw new Error(`Bridge not found: ${bridgeId}`);
    }

    if (
      bridge.sourceInstanceId !== fromInstanceId &&
      bridge.targetInstanceId !== fromInstanceId
    ) {
      throw new Error(
        `Instance ${fromInstanceId} is not a participant of bridge ${bridgeId}`,
      );
    }

    const toInstanceId =
      bridge.sourceInstanceId === fromInstanceId
        ? bridge.targetInstanceId
        : bridge.sourceInstanceId;

    const message: CommMessage = {
      id: crypto.randomUUID(),
      bridgeId,
      fromInstanceId,
      toInstanceId,
      content,
      timestamp: Date.now(),
      metadata,
    };

    this.store.appendMessage(bridgeId, message);
    bridge.messageCount += 1;

    logger.info('Message sent', {
      messageId: message.id,
      bridgeId,
      fromInstanceId,
      toInstanceId,
    });
    this.emit('message', message);

    return message;
  }

  /**
   * Returns messages for a bridge, most-recent-last. Optionally limited to the
   * last `limit` messages.
   */
  getMessages(bridgeId: string, limit?: number): CommMessage[] {
    const bridgeMessages = this.store.getMessages(bridgeId);
    if (limit !== undefined && limit > 0) {
      return bridgeMessages.slice(-limit);
    }
    return bridgeMessages;
  }

  /**
   * Subscribes an instance to a bridge's messages.
   * Returns false if the bridge does not exist.
   */
  subscribe(instanceId: string, bridgeId: string): boolean {
    if (!this.store.getBridge(bridgeId)) {
      logger.warn('Attempted to subscribe to non-existent bridge', { instanceId, bridgeId });
      return false;
    }

    this.store.subscribe(instanceId, bridgeId);

    logger.info('Instance subscribed to bridge', { instanceId, bridgeId });

    return true;
  }

  /**
   * Returns the bridge IDs an instance is subscribed to.
   */
  getSubscriptions(instanceId: string): string[] {
    return this.store.getSubscriptions(instanceId);
  }

  /**
   * Clears all bridges, messages, and subscriptions.
   */
  cleanup(): void {
    this.store.clear();
    logger.info('CrossInstanceCommService cleaned up');
  }
}

export function getCrossInstanceCommService(): CrossInstanceCommService {
  return CrossInstanceCommService.getInstance();
}

export function getCrossInstanceComm(): CrossInstanceCommService {
  return getCrossInstanceCommService();
}
