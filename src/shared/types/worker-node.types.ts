import type { CanonicalCliType } from './settings.types';
import type { DiscoveredProject } from './remote-fs.types';

export type NodePlatform = 'darwin' | 'win32' | 'linux';

export interface WorkerNodeCapabilities {
  platform: NodePlatform;
  arch: string;
  cpuCores: number;
  totalMemoryMB: number;
  availableMemoryMB: number;
  gpuName?: string;
  gpuMemoryMB?: number;
  supportedClis: CanonicalCliType[];
  hasBrowserRuntime: boolean;
  hasBrowserMcp: boolean;
  hasDocker: boolean;
  maxConcurrentInstances: number;
  workingDirectories: string[];
  browsableRoots: string[];
  discoveredProjects: DiscoveredProject[];
}

export interface WorkerNodeInfo {
  id: string;
  name: string;
  address: string;
  capabilities: WorkerNodeCapabilities;
  status: 'connecting' | 'connected' | 'degraded' | 'disconnected';
  connectedAt?: number;
  lastHeartbeat?: number;
  activeInstances: number;
  latencyMs?: number;
}

export type ExecutionLocation =
  | { type: 'local' }
  | { type: 'remote'; nodeId: string };

export interface NodePlacementPrefs {
  requiresBrowser?: boolean;
  requiresGpu?: boolean;
  preferPlatform?: NodePlatform;
  preferNodeId?: string;
  requiresCli?: CanonicalCliType;
  requiresWorkingDirectory?: string;
}

export interface NodeIdentity {
  sessionId: string;
  nodeId: string;
  nodeName: string;
  /** Transport token used for coordinator<->node RPC after registration. */
  transportToken: string;
  /** Backward-compatible alias for transportToken. */
  token: string;
  issuedAt: number;
  /** Backward-compatible alias for issuedAt. */
  createdAt: number;
  lastSeenAt: number;
  authMethod: 'pairing_credential' | 'manual_pairing';
  pairingLabel?: string;
}

export interface RemotePairingCredentialInfo {
  token: string;
  createdAt: number;
  expiresAt: number;
  label?: string;
}
