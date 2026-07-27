import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import { getNotificationService } from '../notifications/notification-service';
import { getWorkerNodeRegistry } from '../remote-node/worker-node-registry';
import { registerCleanup } from '../util/cleanup-registry';
import { LocalAiActivityRegistry } from './local-ai-activity-registry';
import { LocalAiHealthEngine } from './local-ai-health-engine';
import { LocalAiHealthRepository } from './local-ai-health-repository';
import { LocalAiHealthScheduler } from './local-ai-health-scheduler';
import { LocalAiIncidentService } from './local-ai-incident-service';
import { LocalAiProbeService } from './local-ai-probe-service';
import { LocalAiRecoveryService } from './local-ai-recovery-service';
import { LocalAiTargetRepository } from './local-ai-target-repository';

interface WorkerRosterEvents {
  on(event: string, listener: (node: WorkerNodeInfo) => void): unknown;
  removeListener(event: string, listener: (node: WorkerNodeInfo) => void): unknown;
  getAllNodes?(): WorkerNodeInfo[];
}

export interface LocalAiGuardRuntimeOverrides {
  services?: LocalAiGuardRuntimeServices;
  workers?: WorkerRosterEvents;
  registerCleanup?: (cleanup: () => void) => () => void;
}

export interface LocalAiGuardRuntimeServices {
  targets: LocalAiTargetRepository;
  health: LocalAiHealthRepository;
  probes: LocalAiProbeService;
  engine: LocalAiHealthEngine;
  incidents: LocalAiIncidentService;
  recovery: LocalAiRecoveryService;
  activity: LocalAiActivityRegistry;
  scheduler: LocalAiHealthScheduler;
}

export class LocalAiGuardRuntime {
  readonly targets: LocalAiTargetRepository;
  readonly health: LocalAiHealthRepository;
  readonly probes: LocalAiProbeService;
  readonly engine: LocalAiHealthEngine;
  readonly incidents: LocalAiIncidentService;
  readonly recovery: LocalAiRecoveryService;
  readonly activity: LocalAiActivityRegistry;
  readonly scheduler: LocalAiHealthScheduler;
  private readonly disposers: (() => void)[] = [];
  private unregisterCleanup?: () => void;
  private disposed = false;

  constructor(
    services: LocalAiGuardRuntimeServices,
    private readonly releaseOwnership: () => void = () => undefined,
  ) {
    this.targets = services.targets;
    this.health = services.health;
    this.probes = services.probes;
    this.engine = services.engine;
    this.incidents = services.incidents;
    this.recovery = services.recovery;
    this.activity = services.activity;
    this.scheduler = services.scheduler;
  }

  addDisposer(disposer: () => void): void {
    this.disposers.push(disposer);
  }

  setCleanupRegistration(unregister: () => void): void {
    this.unregisterCleanup = unregister;
  }

  start(): void {
    this.scheduler.start();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    runCleanupStep(this.releaseOwnership);
    const unregisterCleanup = this.unregisterCleanup;
    this.unregisterCleanup = undefined;
    runCleanupStep(unregisterCleanup);
    for (const dispose of this.disposers.splice(0).reverse()) {
      runCleanupStep(dispose);
    }
    runCleanupStep(() => this.scheduler.stop());
    runCleanupStep(() => this.incidents.dispose());
  }
}

let runtimeInstance: LocalAiGuardRuntime | undefined;

export function initializeLocalAiGuardRuntime(
  overrides: LocalAiGuardRuntimeOverrides = {},
): LocalAiGuardRuntime {
  if (runtimeInstance) return runtimeInstance;

  let runtime: LocalAiGuardRuntime | undefined;
  let constructedIncidents: LocalAiIncidentService | undefined;
  try {
    const workers = overrides.workers ?? getWorkerNodeRegistry();
    let services = overrides.services;
    if (!services) {
      const targets = new LocalAiTargetRepository();
      const health = new LocalAiHealthRepository();
      const probes = new LocalAiProbeService();
      const engine = new LocalAiHealthEngine();
      const activity = new LocalAiActivityRegistry();
      const incidents = new LocalAiIncidentService(
        health,
        getNotificationService(),
        {
          resolveTargetIdentity: (targetId) => {
            const target = targets.get(targetId);
            return target
              ? {
                  provider: target.provider,
                  location: target.location.type,
                  stableTargetId: target.id,
                }
              : undefined;
          },
        },
      );
      constructedIncidents = incidents;
      const scheduler = new LocalAiHealthScheduler({
        targets,
        health,
        probes,
        incidents,
        engine,
        activity,
      });
      const recovery = new LocalAiRecoveryService({
        targets,
        health,
        probes,
        incidents,
        engine,
      });
      services = {
        targets,
        health,
        probes,
        engine,
        recovery,
        activity,
        scheduler,
        incidents,
      };
    }
    runtime = new LocalAiGuardRuntime(services, () => {
      if (runtimeInstance === runtime) runtimeInstance = undefined;
    });
    constructedIncidents = undefined;

    const targetChanged = (target: { id: string }) => runtime!.scheduler.targetChanged(target.id);
    const connectedWorkers = new Set<string>();
    const workerStatusChanged = (node: WorkerNodeInfo, force = false) => {
      if (node.status === 'connected') {
        const newlyConnected = !connectedWorkers.has(node.id);
        connectedWorkers.add(node.id);
        if (force || newlyConnected) runtime!.scheduler.workerConnected(node.id);
      } else if (force || connectedWorkers.delete(node.id)) {
        runtime!.scheduler.workerDisconnected(node.id);
      }
    };
    const workerCapabilitiesChanged = (node: WorkerNodeInfo) => {
      if (node.status !== 'connected') {
        workerStatusChanged(node);
        return;
      }
      connectedWorkers.add(node.id);
      runtime!.scheduler.workerConnected(node.id);
    };
    const workerDisconnected = (node: WorkerNodeInfo) => {
      if (connectedWorkers.delete(node.id)) {
        runtime!.scheduler.workerDisconnected(node.id);
      }
    };
    runtime.addDisposer(runtime.targets.subscribe(targetChanged));
    runtime.addDisposer(acquireWorkerListener(workers, 'node:connected', workerStatusChanged));
    runtime.addDisposer(acquireWorkerListener(workers, 'node:updated', workerStatusChanged));
    runtime.addDisposer(acquireWorkerListener(
      workers,
      'node:local-models-changed',
      workerCapabilitiesChanged,
    ));
    runtime.addDisposer(acquireWorkerListener(workers, 'node:disconnected', workerDisconnected));

    for (const node of workers.getAllNodes?.() ?? []) workerStatusChanged(node, true);

    const cleanupRegistrar = overrides.registerCleanup ?? registerCleanup;
    runtime.setCleanupRegistration(cleanupRegistrar(() => runtime!.dispose()));
    runtimeInstance = runtime;
    runtime.start();
    return runtime;
  } catch (error) {
    runtime?.dispose();
    if (!runtime) runCleanupStep(() => constructedIncidents?.dispose());
    if (runtimeInstance === runtime) runtimeInstance = undefined;
    throw error;
  }
}

export function getLocalAiGuardRuntime(): LocalAiGuardRuntime {
  return runtimeInstance ?? initializeLocalAiGuardRuntime();
}

export function _resetLocalAiGuardRuntimeForTesting(): void {
  runtimeInstance?.dispose();
  runtimeInstance = undefined;
}

function runCleanupStep(cleanup: (() => void) | undefined): void {
  try {
    cleanup?.();
  } catch {
    // Runtime cleanup is fail-soft and must continue through every owned resource.
  }
}

function acquireWorkerListener(
  workers: WorkerRosterEvents,
  event: string,
  listener: (node: WorkerNodeInfo) => void,
): () => void {
  try {
    workers.on(event, listener);
  } catch (error) {
    runCleanupStep(() => workers.removeListener(event, listener));
    throw error;
  }
  return () => workers.removeListener(event, listener);
}
