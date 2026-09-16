export interface CommBridge {
  id: string;
  name: string;
  sourceInstanceId: string;
  targetInstanceId: string;
  createdAt: number;
  messageCount: number;
}

export interface CommMessage {
  id: string;
  bridgeId: string;
  fromInstanceId: string;
  toInstanceId: string;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface CrossInstanceCommStore {
  createBridge(bridge: CommBridge): void;
  getBridge(bridgeId: string): CommBridge | undefined;
  listBridges(): CommBridge[];
  deleteBridge(bridgeId: string): boolean;
  appendMessage(bridgeId: string, message: CommMessage): void;
  getMessages(bridgeId: string): CommMessage[];
  subscribe(instanceId: string, bridgeId: string): void;
  getSubscriptions(instanceId: string): string[];
  clear(): void;
}

export class MemoryCrossInstanceCommStore implements CrossInstanceCommStore {
  private readonly bridges = new Map<string, CommBridge>();
  private readonly messages = new Map<string, CommMessage[]>();
  private readonly subscriptions = new Map<string, Set<string>>();

  createBridge(bridge: CommBridge): void {
    this.bridges.set(bridge.id, bridge);
    this.messages.set(bridge.id, []);
  }

  getBridge(bridgeId: string): CommBridge | undefined {
    return this.bridges.get(bridgeId);
  }

  listBridges(): CommBridge[] {
    return Array.from(this.bridges.values());
  }

  deleteBridge(bridgeId: string): boolean {
    if (!this.bridges.has(bridgeId)) {
      return false;
    }
    this.bridges.delete(bridgeId);
    this.messages.delete(bridgeId);
    for (const [instanceId, bridgeIds] of this.subscriptions) {
      if (bridgeIds.has(bridgeId)) {
        bridgeIds.delete(bridgeId);
        if (bridgeIds.size === 0) {
          this.subscriptions.delete(instanceId);
        }
      }
    }
    return true;
  }

  appendMessage(bridgeId: string, message: CommMessage): void {
    const bridgeMessages = this.messages.get(bridgeId);
    if (!bridgeMessages) {
      this.messages.set(bridgeId, [message]);
      return;
    }
    bridgeMessages.push(message);
  }

  getMessages(bridgeId: string): CommMessage[] {
    return [...(this.messages.get(bridgeId) ?? [])];
  }

  subscribe(instanceId: string, bridgeId: string): void {
    let bridgeIds = this.subscriptions.get(instanceId);
    if (!bridgeIds) {
      bridgeIds = new Set();
      this.subscriptions.set(instanceId, bridgeIds);
    }
    bridgeIds.add(bridgeId);
  }

  getSubscriptions(instanceId: string): string[] {
    const bridgeIds = this.subscriptions.get(instanceId);
    return bridgeIds ? Array.from(bridgeIds) : [];
  }

  clear(): void {
    this.bridges.clear();
    this.messages.clear();
    this.subscriptions.clear();
  }
}
