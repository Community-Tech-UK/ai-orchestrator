// src/renderer/app/core/services/ipc/remote-node-ipc.service.ts
import { Injectable, inject } from '@angular/core';
import { ElectronIpcService } from './electron-ipc.service';
import type {
  RemotePairingCredentialInfo,
  RemoteWorkerRepairCommand,
  RemoteWorkerRepairDiagnostic,
  WorkerNodeInfo,
  WorkerNodeBrowserAutomationSummary,
  WorkerNodeAndroidAutomationSummary,
  WorkerNodeExtensionRelaySummary,
} from '../../../../../shared/types/worker-node.types';
import type { ServiceStatus } from '../../../../../shared/types/service.types';
import type { CanonicalCliType } from '../../../../../shared/types/settings.types';

export type RemoteNodeDiagnosableProvider = Exclude<CanonicalCliType, 'auto'>;

export interface RemoteNodeServerConfig {
  port?: number;
  host?: string;
}

export interface BrowserAutomationConfigInput {
  enabled: boolean;
  profileDir?: string;
  headless?: boolean;
  chromePath?: string;
  remoteDebuggingPort?: number;
}

export interface ExtensionRelayConfigInput {
  enabled: boolean;
}

export interface BrowserAutomationUpdateResult {
  browserAutomation?: WorkerNodeBrowserAutomationSummary;
  extensionRelay?: WorkerNodeExtensionRelaySummary;
}

export interface AndroidAutomationConfigInput {
  enabled: boolean;
  sdkPath?: string;
  defaultAvd?: string;
  headlessEmulator?: boolean;
  maxEmulators?: number;
  bootTimeoutMs?: number;
  allowPhysicalDevices?: boolean;
  injectMaestroMcp?: boolean;
  appiumMcp?: boolean;
  mobileMcpVersion?: string;
}

export interface RemoteNodeEvent {
  type: 'connected' | 'disconnected' | 'degraded' | 'metrics' | 'updated';
  nodeId: string;
  node?: WorkerNodeInfo;
}

export interface RemoteNodeServerStatus {
  running: boolean;
  port?: number;
  host?: string;
  namespace?: string;
  connectedCount?: number;
  registeredCount?: number;
  pendingPairingCount?: number;
  localIps?: string[];
  tailscaleIp?: string | null;
  tailscaleDnsName?: string | null;
  requireTls?: boolean;
}

export interface RemoteNodeProviderDiagnostic {
  ok: boolean;
  platform: NodeJS.Platform;
  identity: {
    username: string | null;
    homeDir: string | null;
    serviceAccountLikely: boolean;
  };
  provider: {
    provider: RemoteNodeDiagnosableProvider;
    available: boolean;
    authenticated: boolean | null;
    version?: string;
    tokenEnv?: Record<string, boolean>;
    error?: string;
    remediation?: string;
  };
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
    const data = result.data as {
      running?: boolean;
      connectedCount?: number;
      registeredCount?: number;
      pendingPairingCount?: number;
      runningConfig?: { port?: number; host?: string; namespace?: string } | null;
      localIps?: string[];
      tailscaleIp?: string | null;
      tailscaleDnsName?: string | null;
      requireTls?: boolean;
    } | undefined;
    return {
      running: data?.running ?? false,
      port: data?.runningConfig?.port,
      host: data?.runningConfig?.host,
      namespace: data?.runningConfig?.namespace,
      connectedCount: data?.connectedCount ?? 0,
      registeredCount: data?.registeredCount ?? 0,
      pendingPairingCount: data?.pendingPairingCount ?? 0,
      localIps: data?.localIps ?? [],
      tailscaleIp: data?.tailscaleIp ?? null,
      tailscaleDnsName: data?.tailscaleDnsName ?? null,
      requireTls: data?.requireTls ?? false,
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

  async issuePairingCredential(options?: {
    label?: string;
    ttlMs?: number;
  }): Promise<RemotePairingCredentialInfo | null> {
    if (!this.api) return null;
    const result = await this.api.remoteNodeIssuePairing(options) as IpcResult | null;
    if (!result?.success || !result.data || typeof result.data !== 'object') return null;
    return result.data as RemotePairingCredentialInfo;
  }

  async listPairingCredentials(): Promise<RemotePairingCredentialInfo[]> {
    if (!this.api) return [];
    const result = await this.api.remoteNodeListPairings() as IpcResult | null;
    if (!result?.success || !Array.isArray(result.data)) return [];
    return result.data as RemotePairingCredentialInfo[];
  }

  async revokePairingCredential(token: string): Promise<boolean> {
    if (!this.api) return false;
    const result = await this.api.remoteNodeRevokePairing(token) as IpcResult | null;
    if (!result?.success) return false;
    const data = result.data as { revoked?: boolean } | undefined;
    return Boolean(data?.revoked);
  }

  async revokeNode(nodeId: string): Promise<void> {
    if (!this.api) return;
    const result = await this.api.remoteNodeRevokeNode(nodeId) as IpcResult | null;
    if (result && !result.success) {
      throw new Error(result.error?.message ?? 'Failed to revoke node');
    }
  }

  async getServiceStatus(nodeId: string): Promise<ServiceStatus | null> {
    if (!this.api) return null;
    const result = await this.api.remoteNodeServiceStatus(nodeId) as IpcResult | null;
    if (!result?.success) return null;
    return (result.data ?? null) as ServiceStatus | null;
  }

  async diagnoseRepair(nodeId: string): Promise<RemoteWorkerRepairDiagnostic | null> {
    if (!this.api) return null;
    const result = await this.api.remoteNodeRepairDiagnose(nodeId) as IpcResult | null;
    if (!result?.success) return null;
    return (result.data ?? null) as RemoteWorkerRepairDiagnostic | null;
  }

  async generateRepairCommand(
    nodeId: string,
    options?: { platform?: 'win32'; operatorConfirmedPlatform?: boolean },
  ): Promise<RemoteWorkerRepairCommand | null> {
    if (!this.api) return null;
    const result = await this.api.remoteNodeRepairCommand(nodeId, options) as IpcResult | null;
    if (!result?.success) {
      throw new Error(result?.error?.message ?? 'Failed to generate repair command');
    }
    return (result.data ?? null) as RemoteWorkerRepairCommand | null;
  }

  async diagnoseProvider(
    nodeId: string,
    provider: RemoteNodeDiagnosableProvider,
  ): Promise<RemoteNodeProviderDiagnostic | null> {
    if (!this.api) return null;
    const result = await this.api.remoteNodeProviderDiagnose(nodeId, provider) as IpcResult | null;
    if (!result?.success) return null;
    return (result.data ?? null) as RemoteNodeProviderDiagnostic | null;
  }

  async restartService(nodeId: string): Promise<void> {
    if (!this.api) return;
    const result = await this.api.remoteNodeServiceRestart(nodeId) as IpcResult | null;
    if (result && !result.success) {
      throw new Error(result.error?.message ?? 'Failed to restart service');
    }
  }

  async stopService(nodeId: string): Promise<void> {
    if (!this.api) return;
    const result = await this.api.remoteNodeServiceStop(nodeId) as IpcResult | null;
    if (result && !result.success) {
      throw new Error(result.error?.message ?? 'Failed to stop service');
    }
  }

  async uninstallService(nodeId: string): Promise<void> {
    if (!this.api) return;
    const result = await this.api.remoteNodeServiceUninstall(nodeId) as IpcResult | null;
    if (result && !result.success) {
      throw new Error(result.error?.message ?? 'Failed to uninstall service');
    }
  }

  /**
   * Push a browser-automation config change to a node (privileged: service
   * scope). Returns the resulting non-secret summary the node reports back.
   */
  async updateBrowserAutomation(
    nodeId: string,
    browserAutomation: BrowserAutomationConfigInput,
    extensionRelay?: ExtensionRelayConfigInput,
  ): Promise<BrowserAutomationUpdateResult | null> {
    if (!this.api) return null;
    const result = await this.api.remoteNodeUpdateBrowserAutomation(
      nodeId,
      browserAutomation,
      extensionRelay,
    ) as IpcResult | null;
    if (!result?.success) {
      throw new Error(result?.error?.message ?? 'Failed to update browser automation');
    }
    return (result.data ?? null) as BrowserAutomationUpdateResult | null;
  }

  /**
   * Push an Android-automation config change to a node (privileged: service
   * scope). Returns the resulting non-secret summary the node reports back.
   */
  async updateAndroidAutomation(
    nodeId: string,
    androidAutomation: AndroidAutomationConfigInput,
  ): Promise<WorkerNodeAndroidAutomationSummary | null> {
    if (!this.api) return null;
    const result = await this.api.remoteNodeUpdateAndroidAutomation(
      nodeId,
      androidAutomation,
    ) as IpcResult | null;
    if (!result?.success) {
      throw new Error(result?.error?.message ?? 'Failed to update Android automation');
    }
    const data = result.data as { androidAutomation?: WorkerNodeAndroidAutomationSummary } | undefined;
    return data?.androidAutomation ?? null;
  }

  /**
   * Launch a headful Chrome on the node against its automation profile so the
   * operator can log it into the target site (the window opens on the node's
   * screen). Returns the remote terminal session id.
   */
  async runBrowserLogin(nodeId: string, url?: string): Promise<string | null> {
    if (!this.api) return null;
    const result = await this.api.remoteNodeRunBrowserLogin(nodeId, url) as IpcResult | null;
    if (!result?.success) {
      throw new Error(result?.error?.message ?? 'Failed to start login on node');
    }
    const data = result.data as { sessionId?: string } | undefined;
    return data?.sessionId ?? null;
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
