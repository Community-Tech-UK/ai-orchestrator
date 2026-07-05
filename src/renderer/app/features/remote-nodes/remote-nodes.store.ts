// src/renderer/app/features/remote-nodes/remote-nodes.store.ts
import { Injectable, inject, signal, computed, OnDestroy } from '@angular/core';
import { RemoteNodeIpcService, type RemoteNodeEvent } from '../../core/services/ipc/remote-node-ipc.service';
import type {
  RemoteNodeRosterEntry,
  WorkerNodeInfo,
} from '../../../../shared/types/worker-node.types';
import type { ServiceStatus } from '../../../../shared/types/service.types';
import { isRemoteNodeOnline } from '../../core/state/remote-node-connectivity';

@Injectable({ providedIn: 'root' })
export class RemoteNodesStore implements OnDestroy {
  private readonly ipc = inject(RemoteNodeIpcService);
  private unsubscribe?: () => void;

  /** All known worker nodes. */
  readonly nodes = signal<RemoteNodeRosterEntry[]>([]);

  /** Loading state. */
  readonly loading = signal(false);

  /** Connected nodes only. */
  readonly connectedNodes = computed(() =>
    this.nodes().filter(isRemoteNodeOnline),
  );

  /** Total active instances across all nodes. */
  readonly totalActiveInstances = computed(() =>
    this.nodes().reduce((sum, n) => sum + n.activeInstances, 0),
  );

  /** Per-node service status cache. */
  private readonly _serviceStatuses = signal<Record<string, ServiceStatus | null>>({});
  readonly serviceStatuses = this._serviceStatuses.asReadonly();

  async refreshServiceStatus(nodeId: string): Promise<void> {
    const status = await this.ipc.getServiceStatus(nodeId);
    this._serviceStatuses.update((prev) => ({ ...prev, [nodeId]: status }));
  }

  async restartService(nodeId: string): Promise<void> {
    await this.ipc.restartService(nodeId);
    await this.refreshServiceStatus(nodeId);
  }

  async stopService(nodeId: string): Promise<void> {
    await this.ipc.stopService(nodeId);
    await this.refreshServiceStatus(nodeId);
  }

  async uninstallService(nodeId: string): Promise<void> {
    await this.ipc.uninstallService(nodeId);
    await this.refreshServiceStatus(nodeId);
  }

  constructor() {
    this.unsubscribe = this.ipc.onNodeEvent((event: RemoteNodeEvent) => {
      this.handleEvent(event);
    });
  }

  ngOnDestroy(): void {
    this.unsubscribe?.();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const nodes = await this.ipc.listNodes();
      this.nodes.set(nodes);
    } finally {
      this.loading.set(false);
    }
  }

  private handleEvent(event: RemoteNodeEvent): void {
    const current = this.nodes();
    const nodeId = event.node?.id ?? event.nodeId;
    if (!nodeId) {
      return;
    }
    switch (event.type) {
      case 'connected':
        if (event.node) {
          const existing = current.find((n) => n.id === nodeId);
          this.nodes.set([
            ...current.filter((n) => n.id !== nodeId),
            this.toRosterEntry(event.node, existing),
          ]);
        }
        break;
      case 'disconnected':
        this.nodes.set(
          current.map((n) =>
            n.id === nodeId ? { ...n, status: 'disconnected' as const, connected: false } : n,
          ),
        );
        break;
      case 'degraded':
        this.nodes.set(
          current.map((n) =>
            n.id === nodeId ? { ...n, status: 'degraded' as const } : n,
          ),
        );
        break;
      case 'updated':
      case 'metrics':
        if (event.node) {
          this.nodes.set(
            current.map((n) => (n.id === nodeId ? this.toRosterEntry(event.node!, n) : n)),
          );
        }
        break;
    }
  }

  private toRosterEntry(
    node: RemoteNodeRosterEntry | WorkerNodeInfo,
    existing?: RemoteNodeRosterEntry,
  ): RemoteNodeRosterEntry {
    const capabilities = node.capabilities ?? existing?.capabilities ?? fallbackCapabilities();
    const rosterFields = node as Partial<RemoteNodeRosterEntry>;
    return {
      ...existing,
      id: node.id,
      name: node.name,
      address: node.address ?? existing?.address ?? '',
      capabilities,
      status: node.status,
      connected: typeof rosterFields.connected === 'boolean'
        ? rosterFields.connected
        : node.status !== 'disconnected',
      activeInstances: node.activeInstances ?? existing?.activeInstances ?? 0,
      supportedClis: rosterFields.supportedClis ?? [...capabilities.supportedClis],
      hasBrowserRuntime: rosterFields.hasBrowserRuntime ?? capabilities.hasBrowserRuntime,
      hasBrowserMcp: rosterFields.hasBrowserMcp ?? capabilities.hasBrowserMcp,
      browserAutomation: rosterFields.browserAutomation ?? capabilities.browserAutomation,
      hasExtensionRelay: rosterFields.hasExtensionRelay ?? capabilities.hasExtensionRelay,
      extensionRelay: rosterFields.extensionRelay ?? capabilities.extensionRelay,
      hasAndroidMcp: rosterFields.hasAndroidMcp ?? capabilities.hasAndroidMcp,
      androidAutomation: rosterFields.androidAutomation ?? capabilities.androidAutomation,
      hasDocker: rosterFields.hasDocker ?? capabilities.hasDocker,
      gpuName: rosterFields.gpuName ?? capabilities.gpuName,
      gpuMemoryMB: rosterFields.gpuMemoryMB ?? capabilities.gpuMemoryMB,
      maxConcurrentInstances: rosterFields.maxConcurrentInstances ?? capabilities.maxConcurrentInstances,
      workingDirectories: rosterFields.workingDirectories ?? [...capabilities.workingDirectories],
      platform: rosterFields.platform ?? capabilities.platform,
      arch: rosterFields.arch ?? capabilities.arch,
      connectedAt: node.connectedAt ?? existing?.connectedAt,
      lastHeartbeat: node.lastHeartbeat ?? existing?.lastHeartbeat,
      latencyMs: node.latencyMs ?? existing?.latencyMs,
    };
  }
}

function fallbackCapabilities(): RemoteNodeRosterEntry['capabilities'] {
  return {
    platform: 'linux',
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
