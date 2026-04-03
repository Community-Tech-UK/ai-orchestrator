// src/renderer/app/features/remote-nodes/remote-nodes.store.ts
import { Injectable, inject, signal, computed, OnDestroy } from '@angular/core';
import { RemoteNodeIpcService, type RemoteNodeEvent } from '../../core/services/ipc/remote-node-ipc.service';
import type { WorkerNodeInfo } from '../../../../shared/types/worker-node.types';

@Injectable({ providedIn: 'root' })
export class RemoteNodesStore implements OnDestroy {
  private readonly ipc = inject(RemoteNodeIpcService);
  private unsubscribe?: () => void;

  /** All known worker nodes. */
  readonly nodes = signal<WorkerNodeInfo[]>([]);

  /** Loading state. */
  readonly loading = signal(false);

  /** Connected nodes only. */
  readonly connectedNodes = computed(() =>
    this.nodes().filter((n) => n.status === 'connected'),
  );

  /** Total active instances across all nodes. */
  readonly totalActiveInstances = computed(() =>
    this.nodes().reduce((sum, n) => sum + n.activeInstances, 0),
  );

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
    switch (event.type) {
      case 'connected':
        if (event.node) {
          this.nodes.set([
            ...current.filter((n) => n.id !== event.nodeId),
            event.node,
          ]);
        }
        break;
      case 'disconnected':
        this.nodes.set(
          current.map((n) =>
            n.id === event.nodeId ? { ...n, status: 'disconnected' as const } : n,
          ),
        );
        break;
      case 'degraded':
        this.nodes.set(
          current.map((n) =>
            n.id === event.nodeId ? { ...n, status: 'degraded' as const } : n,
          ),
        );
        break;
      case 'metrics':
        if (event.node) {
          this.nodes.set(
            current.map((n) => (n.id === event.nodeId ? event.node! : n)),
          );
        }
        break;
    }
  }
}
