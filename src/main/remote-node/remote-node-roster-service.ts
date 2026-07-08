import type {
  NodeIdentity,
  NodePlatform,
  RemoteNodeRosterEntry,
  WorkerNodeCapabilities,
  WorkerNodeInfo,
} from '../../shared/types/worker-node.types';
import { getRemoteAuthService } from '../auth/remote-auth';
import { getWorkerNodeRegistry } from './worker-node-registry';

interface RegistryLike {
  getAllNodes(): WorkerNodeInfo[];
}

interface AuthServiceLike {
  listSessions(): NodeIdentity[];
}

export interface RemoteNodeRosterServiceOptions {
  registry?: RegistryLike;
  authService?: AuthServiceLike;
}

const STATUS_RANK: Record<RemoteNodeRosterEntry['status'], number> = {
  connected: 0,
  degraded: 1,
  connecting: 2,
  disconnected: 3,
};

export class RemoteNodeRosterService {
  constructor(private readonly options: RemoteNodeRosterServiceOptions = {}) {}

  list(): RemoteNodeRosterEntry[] {
    return buildRemoteNodeRoster(
      this.registry().getAllNodes(),
      this.authService().listSessions(),
    );
  }

  get(nodeId: string): RemoteNodeRosterEntry | undefined {
    return this.list().find((node) => node.id === nodeId);
  }

  private registry(): RegistryLike {
    return this.options.registry ?? getWorkerNodeRegistry();
  }

  private authService(): AuthServiceLike {
    return this.options.authService ?? getRemoteAuthService();
  }
}

export function buildRemoteNodeRoster(
  liveNodes: WorkerNodeInfo[],
  sessions: NodeIdentity[],
): RemoteNodeRosterEntry[] {
  const liveById = new Map(liveNodes.map((node) => [node.id, node]));
  const sessionById = new Map(sessions.map((session) => [session.nodeId, session]));
  const ids = new Set<string>([...liveById.keys(), ...sessionById.keys()]);

  return [...ids]
    .map((id) => buildEntry(id, liveById.get(id), sessionById.get(id)))
    .sort((left, right) => {
      const statusDiff = STATUS_RANK[left.status] - STATUS_RANK[right.status];
      return statusDiff !== 0 ? statusDiff : left.name.localeCompare(right.name);
    });
}

function buildEntry(
  id: string,
  live: WorkerNodeInfo | undefined,
  session: NodeIdentity | undefined,
): RemoteNodeRosterEntry {
  const capabilities = live?.capabilities ?? fallbackCapabilities(session?.platform);
  const name = live?.name ?? session?.nodeName ?? id;
  const status = live?.status ?? 'disconnected';
  const activeInstances = live?.activeInstances ?? 0;
  const maxConcurrentInstances = live?.capabilities.maxConcurrentInstances ?? 0;
  const workingDirectories = [...(live?.capabilities.workingDirectories ?? [])];

  return {
    id,
    name,
    address: live?.address ?? '',
    capabilities,
    status,
    connected: Boolean(live && status !== 'disconnected'),
    activeInstances,
    supportedClis: [...(live?.capabilities.supportedClis ?? [])],
    hasBrowserRuntime: live?.capabilities.hasBrowserRuntime ?? false,
    hasBrowserMcp: live?.capabilities.hasBrowserMcp ?? false,
    hasAndroidMcp: live?.capabilities.hasAndroidMcp ?? false,
    hasDocker: live?.capabilities.hasDocker ?? false,
    maxConcurrentInstances,
    workingDirectories,
    ...(live?.connectedAt !== undefined ? { connectedAt: live.connectedAt } : {}),
    ...(live?.lastHeartbeat !== undefined ? { lastHeartbeat: live.lastHeartbeat } : {}),
    ...(live?.latencyMs !== undefined ? { latencyMs: live.latencyMs } : {}),
    ...(session?.lastSeenAt !== undefined ? { lastAuthenticatedAt: session.lastSeenAt } : {}),
    ...(session?.issuedAt !== undefined ? { registeredAt: session.issuedAt } : {}),
    ...(session?.pairingLabel ? { pairingLabel: session.pairingLabel } : {}),
    ...(session?.authMethod ? { authMethod: session.authMethod } : {}),
    ...(live?.capabilities.platform ?? session?.platform
      ? { platform: live?.capabilities.platform ?? session?.platform }
      : {}),
    ...(live?.capabilities.arch ? { arch: live.capabilities.arch } : {}),
    ...(live?.capabilities.workerAgent ? { workerAgent: live.capabilities.workerAgent } : {}),
    ...(live?.capabilities.browserAutomation
      ? { browserAutomation: live.capabilities.browserAutomation }
      : {}),
    ...(live?.capabilities.hasExtensionRelay !== undefined
      ? { hasExtensionRelay: live.capabilities.hasExtensionRelay }
      : {}),
    ...(live?.capabilities.extensionRelay ? { extensionRelay: live.capabilities.extensionRelay } : {}),
    ...(live?.capabilities.androidAutomation
      ? { androidAutomation: live.capabilities.androidAutomation }
      : {}),
    ...(live?.capabilities.fileTransfer ? { fileTransfer: live.capabilities.fileTransfer } : {}),
    ...(live?.capabilities.gpuName ? { gpuName: live.capabilities.gpuName } : {}),
    ...(live?.capabilities.gpuMemoryMB ? { gpuMemoryMB: live.capabilities.gpuMemoryMB } : {}),
  };
}

function fallbackCapabilities(platform: NodePlatform | undefined): WorkerNodeCapabilities {
  return {
    platform: platform ?? 'linux',
    arch: '',
    cpuCores: 0,
    totalMemoryMB: 0,
    availableMemoryMB: 0,
    supportedClis: [],
    hasBrowserRuntime: false,
    hasBrowserMcp: false,
    hasAndroidMcp: false,
    hasDocker: false,
    maxConcurrentInstances: 0,
    workingDirectories: [],
    browsableRoots: [],
    discoveredProjects: [],
  };
}

let remoteNodeRosterService: RemoteNodeRosterService | null = null;

export function getRemoteNodeRosterService(): RemoteNodeRosterService {
  if (!remoteNodeRosterService) {
    remoteNodeRosterService = new RemoteNodeRosterService();
  }
  return remoteNodeRosterService;
}

export function _resetRemoteNodeRosterServiceForTesting(): void {
  remoteNodeRosterService = null;
}
