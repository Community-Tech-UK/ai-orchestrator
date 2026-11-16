/**
 * Communication IPC Service - Cross-instance communication
 *
 * Bridges the gap between the page component's messaging model
 * (fromInstanceId/toInstanceId) and the backend bridge-based API.
 */
import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class CommIpcService {
  private base = inject(ElectronIpcService);
  private get api() { return this.base.getApi(); }

  async sendMessage(payload: {
    fromInstanceId: string;
    toInstanceId: string;
    content: string;
    type?: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    // Find or create a bridge between the two instances, then send via the bridge
    const bridgesRes = await this.api.commGetBridges();
    const bridges = bridgesRes.success && Array.isArray(bridgesRes.data) ? bridgesRes.data as { id: string; sourceInstanceId: string; targetInstanceId: string }[] : [];
    const bridge = bridges.find(b =>
      (b.sourceInstanceId === payload.fromInstanceId && b.targetInstanceId === payload.toInstanceId) ||
      (b.sourceInstanceId === payload.toInstanceId && b.targetInstanceId === payload.fromInstanceId)
    );
    if (!bridge) {
      return { success: false, error: { message: 'No bridge between these sessions. Create one first.' } };
    }
    return this.api.commSendMessage({
      bridgeId: bridge.id,
      fromInstanceId: payload.fromInstanceId,
      content: payload.content,
      metadata: payload.type ? { type: payload.type } : undefined,
    });
  }

  async createBridge(sourceInstanceId: string, targetInstanceId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    const name = `${sourceInstanceId.slice(0, 8)}-${targetInstanceId.slice(0, 8)}`;
    return this.api.commCreateBridge({ name, sourceInstanceId, targetInstanceId });
  }

  async deleteBridge(bridgeId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.commDeleteBridge({ bridgeId });
  }

  async getMessages(bridgeId?: string, limit?: number): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    if (!bridgeId) {
      // Load messages from all bridges
      const bridgesRes = await this.api.commGetBridges();
      const bridges = bridgesRes.success && Array.isArray(bridgesRes.data) ? bridgesRes.data as { id: string }[] : [];
      const allMessages: unknown[] = [];
      for (const b of bridges) {
        const res = await this.api.commGetMessages({ bridgeId: b.id, limit });
        if (res.success && Array.isArray(res.data)) {
          allMessages.push(...res.data);
        }
      }
      return { success: true, data: allMessages };
    }
    return this.api.commGetMessages({ bridgeId, limit });
  }

  async getBridges(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.commGetBridges();
  }

  async subscribe(instanceId: string, bridgeId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.commSubscribe({ instanceId, bridgeId });
  }

  async requestToken(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.commRequestToken();
  }
}
