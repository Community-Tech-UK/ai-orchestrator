import type { KeepAwakeState } from '@contracts/schemas/observability';
import type { Instance } from '../../shared/types/instance.types';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import { sessionKeepAwakeReasons } from '../app/keep-awake-probes';
import { getLogger } from '../logging/logger';

const logger = getLogger('RemoteKeepAwake');
interface WorkerLease {
  enabled: boolean;
  pending: boolean;
  running?: Promise<void>;
}

/** Mirrors the desktop setting without changing any worker's persisted settings. */
export class RemoteKeepAwake {
  private readonly leases = new Map<string, WorkerLease>();
  private stopped = false;

  constructor(private readonly dependencies: {
    getNodes: () => WorkerNodeInfo[];
    getInstances: () => Instance[];
    send: (nodeId: string, enabled: boolean) => Promise<unknown>;
  }) {}

  async reconcile(mode: KeepAwakeState['mode']): Promise<void> {
    try {
      if (this.stopped) return;
      const eligible = new Set(this.dependencies.getNodes()
        .filter(node => node.status === 'connected' && node.capabilities.keepAwake === 1).map(node => node.id));
      const working = new Set<string>();
      if (mode === 'while-working') {
        const now = Date.now();
        for (const instance of this.dependencies.getInstances()) {
          if (instance.executionLocation?.type === 'remote' && sessionKeepAwakeReasons([instance], now).length > 0) {
            working.add(instance.executionLocation.nodeId);
          }
        }
      }
      const desired = new Set([...eligible].filter(id => mode === 'always' || mode === 'while-working' && working.has(id)));
      for (const id of this.leases.keys()) if (!eligible.has(id)) this.leases.delete(id);
      await Promise.all([...new Set([...this.leases.keys(), ...desired])]
        .map(id => this.schedule(id, desired.has(id))));
    } catch (error) {
      logger.warn('Worker keep-awake reconciliation failed', { error: String(error) });
    }
  }

  shutdown(): Promise<void> {
    this.stopped = true;
    return Promise.all([...this.leases.keys()].map(id => this.schedule(id, false))).then(() => undefined);
  }

  private schedule(id: string, enabled: boolean): Promise<void> {
    const lease: WorkerLease = this.leases.get(id) ?? { enabled, pending: false };
    this.leases.set(id, lease);
    lease.enabled = enabled;
    lease.pending = true;
    // One in-flight request per worker, with only the latest pending intent.
    // A silent worker cannot delay other workers or build up obsolete renewals.
    lease.running ??= Promise.resolve().then(() => this.flush(id, lease)).finally(() => {
      lease.running = undefined;
      if (lease.pending && this.leases.get(id) === lease) return this.schedule(id, lease.enabled);
      return undefined;
    });
    return lease.running;
  }

  private async flush(nodeId: string, lease: WorkerLease): Promise<void> {
    // Even an unanswered enable may have reached the worker; remember it so Off
    // and shutdown still send an explicit release. The worker TTL bounds loss.
    while (lease.pending && this.leases.get(nodeId) === lease) {
      lease.pending = false;
      const enabled = lease.enabled;
      try {
        await this.dependencies.send(nodeId, enabled);
        if (!enabled && !lease.pending) this.leases.delete(nodeId);
      } catch (error) {
        logger.warn('Could not update worker keep-awake lease', { nodeId, enabled, error: String(error) });
      }
    }
  }
}
