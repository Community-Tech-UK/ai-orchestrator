import { Injectable, signal, computed, inject } from '@angular/core';
import type { WorkerNodeInfo } from '../../../../shared/types/worker-node.types';
import { RemoteNodeIpcService } from '../services/ipc/remote-node-ipc.service';

@Injectable({ providedIn: 'root' })
export class RemoteNodeStore {
  private readonly ipc = inject(RemoteNodeIpcService);
  private readonly _nodes = signal<WorkerNodeInfo[]>([]);
  private cleanupFns: (() => void)[] = [];
  private initialized = false;

  /** All known nodes (connected, degraded, disconnected). */
  readonly nodes = this._nodes.asReadonly();

  /** Only nodes with status === 'connected'. */
  readonly connectedNodes = computed(() =>
    this._nodes().filter(n => n.status === 'connected'),
  );

  /** True when at least one node exists (any status). */
  readonly hasNodes = computed(() => this._nodes().length > 0);

  /** Look up a node by ID. Returns undefined if not found. */
  nodeById(id: string): WorkerNodeInfo | undefined {
    return this._nodes().find(n => n.id === id);
  }

  /** Seed from IPC and subscribe to live updates. Call once on app init. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const nodes = await this.ipc.listNodes();
    this._nodes.set(nodes);

    // Primary: listen for bulk node list broadcasts
    const unsubNodes = this.ipc.onNodesChanged((updatedNodes) => {
      this._nodes.set(updatedNodes);
    });
    this.cleanupFns.push(unsubNodes);

    // Fallback: listen for individual node events and refresh from IPC.
    // The nodes-changed broadcast can be unreliable (timing, serialization)
    // but node events are always delivered via the window manager.
    const unsubEvent = this.ipc.onNodeEvent(() => {
      void this.refresh();
    });
    this.cleanupFns.push(unsubEvent);
  }

  /** Re-fetch the full node list from the main process. */
  async refresh(): Promise<void> {
    const nodes = await this.ipc.listNodes();
    this._nodes.set(nodes);
  }

  /** Cleanup subscriptions. */
  destroy(): void {
    for (const fn of this.cleanupFns) {
      fn();
    }
    this.cleanupFns = [];
    this.initialized = false;
  }
}
