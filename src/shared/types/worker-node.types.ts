import type { CanonicalCliType } from './settings.types';

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
