// src/renderer/app/core/services/ipc/remote-node-ipc.service.ts
import { Injectable, inject } from '@angular/core';
import { ElectronIpcService } from './electron-ipc.service';
import type { WorkerNodeInfo } from '../../../../../shared/types/worker-node.types';

export interface RemoteNodeServerConfig {
  port?: number;
  host?: string;
}

export interface RemoteNodeEvent {
  type: 'connected' | 'disconnected' | 'degraded' | 'metrics';
  nodeId: string;
  node?: WorkerNodeInfo;
}

@Injectable({ providedIn: 'root' })
export class RemoteNodeIpcService {
  private readonly base = inject(ElectronIpcService);
  private get api() { return this.base.getApi(); }

  async listNodes(): Promise<WorkerNodeInfo[]> {
    if (!this.api) return [];
    const result = await this.api.remoteNodeList();
    return (result ?? []) as WorkerNodeInfo[];
  }

  async getNode(nodeId: string): Promise<WorkerNodeInfo | null> {
    if (!this.api) return null;
    const result = await this.api.remoteNodeGet(nodeId);
    return (result ?? null) as WorkerNodeInfo | null;
  }

  async startServer(config?: RemoteNodeServerConfig): Promise<void> {
    if (!this.api) return;
    await this.api.remoteNodeStartServer(config);
  }

  async stopServer(): Promise<void> {
    if (!this.api) return;
    await this.api.remoteNodeStopServer();
  }

  onNodeEvent(callback: (event: RemoteNodeEvent) => void): () => void {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    if (!this.api) return () => {};
    return this.api.onRemoteNodeEvent(callback as (event: unknown) => void);
  }
}
