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

export interface RemoteNodeServerStatus {
  running: boolean;
  port?: number;
  host?: string;
  connectedCount?: number;
}

interface IpcResult {
  success: boolean;
  data?: unknown;
  error?: { message: string };
}

@Injectable({ providedIn: 'root' })
export class RemoteNodeIpcService {
  private readonly base = inject(ElectronIpcService);
  private get api() { return this.base.getApi(); }

  async listNodes(): Promise<WorkerNodeInfo[]> {
    if (!this.api) return [];
    const result = await this.api.remoteNodeList() as IpcResult | null;
    if (!result?.success || !Array.isArray(result.data)) return [];
    return result.data as WorkerNodeInfo[];
  }

  async getNode(nodeId: string): Promise<WorkerNodeInfo | null> {
    if (!this.api) return null;
    const result = await this.api.remoteNodeGet(nodeId) as IpcResult | null;
    if (!result?.success) return null;
    return (result.data ?? null) as WorkerNodeInfo | null;
  }

  async getServerStatus(): Promise<RemoteNodeServerStatus> {
    if (!this.api) return { running: false };
    const result = await this.api.remoteNodeGetServerStatus() as IpcResult | null;
    if (!result?.success) return { running: false };
    const data = result.data as { connectedCount?: number; runningConfig?: { port?: number; host?: string } } | undefined;
    return {
      running: true,
      port: data?.runningConfig?.port,
      host: data?.runningConfig?.host,
      connectedCount: data?.connectedCount ?? 0,
    };
  }

  async startServer(config?: RemoteNodeServerConfig): Promise<void> {
    if (!this.api) return;
    const result = await this.api.remoteNodeStartServer(config) as IpcResult | null;
    if (result && !result.success) {
      throw new Error(result.error?.message ?? 'Failed to start server');
    }
  }

  async stopServer(): Promise<void> {
    if (!this.api) return;
    const result = await this.api.remoteNodeStopServer() as IpcResult | null;
    if (result && !result.success) {
      throw new Error(result.error?.message ?? 'Failed to stop server');
    }
  }

  async regenerateToken(): Promise<string | null> {
    if (!this.api) return null;
    const result = await this.api.remoteNodeRegenerateToken() as IpcResult | null;
    if (!result?.success) return null;
    const data = result.data as { token?: string } | undefined;
    return data?.token ?? null;
  }

  async setToken(token: string): Promise<void> {
    if (!this.api) return;
    const result = await this.api.remoteNodeSetToken(token) as IpcResult | null;
    if (result && !result.success) {
      throw new Error(result.error?.message ?? 'Failed to set token');
    }
  }

  async revokeNode(nodeId: string): Promise<void> {
    if (!this.api) return;
    const result = await this.api.remoteNodeRevokeNode(nodeId) as IpcResult | null;
    if (result && !result.success) {
      throw new Error(result.error?.message ?? 'Failed to revoke node');
    }
  }

  onNodeEvent(callback: (event: RemoteNodeEvent) => void): () => void {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    if (!this.api) return () => {};
    return this.api.onRemoteNodeEvent(callback as (event: unknown) => void);
  }

  onNodesChanged(callback: (nodes: WorkerNodeInfo[]) => void): () => void {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    if (!this.api) return () => {};
    return this.api.onRemoteNodeNodesChanged(callback as (nodes: unknown) => void);
  }
}
