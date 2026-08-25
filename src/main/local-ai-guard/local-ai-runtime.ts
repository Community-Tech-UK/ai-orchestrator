import type { LocalAiRoutingEvent } from '../../shared/types/local-ai-guard.types';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import { computeProviderTokenCost } from '../../shared/data/model-pricing';
import { getSettingsManager } from '../core/config/settings-manager';
import {
  subscribeCostAttribution,
  type CostAttributionRecord,
} from '../core/system/cost-attribution';
import { getNotificationService } from '../notifications/notification-service';
import { getWorkerNodeRegistry } from '../remote-node/worker-node-registry';
import { registerCleanup } from '../util/cleanup-registry';
import { LocalAiActivityRegistry } from './local-ai-activity-registry';
import { installLocalAiAuxiliaryRuntimeHooks } from './local-ai-auxiliary-bridge';
import { LocalAiFallbackApprovalService } from './local-ai-fallback-approval-service';
import { LocalAiHealthEngine } from './local-ai-health-engine';
import { LocalAiHealthRepository } from './local-ai-health-repository';
import { LocalAiHealthScheduler } from './local-ai-health-scheduler';
import { LocalAiIncidentService } from './local-ai-incident-service';
import { LocalAiProbeService } from './local-ai-probe-service';
import { LocalAiRecoveryService } from './local-ai-recovery-service';
import { LocalAiRoutingGuard } from './local-ai-routing-guard';
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
  approvals: LocalAiFallbackApprovalService;
  routing: LocalAiRoutingGuard;
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
  readonly approvals: LocalAiFallbackApprovalService;
  readonly routing: LocalAiRoutingGuard;
  private readonly disposers: (() => void)[] = [];
  private unregisterCleanup?: () => void;
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private statusRevision = 0n;
  /**
   * LT-189 — bounded, most-recent-first `notify-and-allow` events for the
   * renderer's passive banner. Live discovery only; the durable record is
   * the effectiveness dashboard, not this list.
   */
  private readonly _fallbackNotifications: LocalAiRoutingEvent[] = [];
  private static readonly FALLBACK_NOTIFICATION_LIMIT = 50;

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
    this.approvals = services.approvals;
    this.routing = services.routing;
    if (services.scheduler && typeof services.scheduler.subscribe === 'function') {
      this.addDisposer(services.scheduler.subscribe(() => this.notifyChanged()));
    }
    if (services.approvals && typeof services.approvals.subscribe === 'function') {
      this.addDisposer(services.approvals.subscribe(() => this.notifyChanged()));
    }
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get revision(): string {
    return this.statusRevision.toString();
  }

  /** Most-recent-first, bounded. See `_fallbackNotifications` for scope. */
  get fallbackNotifications(): LocalAiRoutingEvent[] {
    return this._fallbackNotifications;
  }

  /**
   * LT-189 — records a `notify-and-allow` fallback event for the passive
   * renderer banner and pulses a revision change so it reaches the
   * renderer on the next status delta, the same path every other guard
   * mutation already uses.
   */
  recordFallbackNotification(event: LocalAiRoutingEvent): void {
    if (this.disposed) return;
    this._fallbackNotifications.unshift(event);
    this._fallbackNotifications.length = Math.min(
      this._fallbackNotifications.length,
      LocalAiGuardRuntime.FALLBACK_NOTIFICATION_LIMIT,
    );
    this.notifyChanged();
  }

  /**
   * Replaces a live notification with its latest durable routing event after
   * provider cost attribution. The subsequent normal revision pulse publishes
   * the enriched event without turning this session-only list into another
   * source of truth.
   */
  refreshFallbackNotification(eventId: string): void {
    if (this.disposed) return;
    const index = this._fallbackNotifications.findIndex((event) => event.id === eventId);
    if (index < 0) return;
    const refreshed = this.health.getRoutingEvent(eventId);
    if (refreshed) this._fallbackNotifications[index] = refreshed;
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notifyChanged(): void {
    if (this.disposed) return;
    this.statusRevision += 1n;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Renderer status observers are isolated from Local AI routing.
      }
    }
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
    this.listeners.clear();
    runCleanupStep(this.releaseOwnership);
    const unregisterCleanup = this.unregisterCleanup;
    this.unregisterCleanup = undefined;
    runCleanupStep(unregisterCleanup);
    for (const dispose of this.disposers.splice(0).reverse()) {
      runCleanupStep(dispose);
    }
    runCleanupStep(() => this.scheduler.stop());
    runCleanupStep(() => this.approvals.dispose());
    runCleanupStep(() => this.incidents.dispose());
  }
}

/**
 * LT-189 — builds the `notifyFallback` dependency `LocalAiRoutingGuard` calls
 * on every `notify-and-allow` fallback. Previously the only production
 * construction site (below) never supplied this callback at all, so the
 * guard's own `notify()` call was always a silent no-op. Isolated as a pure
 * function, taking a getter rather than the runtime directly, so it can be
 * unit-tested without the singleton-heavy default construction path this
 * runs inside (real settings manager, notification service, worker
 * registry, and DB-backed repositories) — and so it tolerates being called
 * before `runtime` is assigned, the same deferred-closure pattern the
 * `targetChanged`/`workerStatusChanged` listeners further down already use.
 */
export function notifyFallbackInto(
  getRuntime: () => LocalAiGuardRuntime | undefined,
): (event: LocalAiRoutingEvent) => void {
  return (event) => getRuntime()?.recordFallbackNotification(event);
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
      const approvals = new LocalAiFallbackApprovalService(health, {
        resolveReservationLimits: (request) => {
          const event = health.getRoutingEvent(request.routingEventId);
          const settings = getSettingsManager().getAll();
          const target = event?.targetId ? targets.get(event.targetId) : undefined;
          const incident = event?.incidentId
            ? health.listIncidents({ targetId: event.targetId, limit: 1_000 })
              .find((candidate) => candidate.id === event.incidentId)
            : undefined;
          const at = Date.now();
          return {
            at,
            dayStart: Date.UTC(
              new Date(at).getUTCFullYear(),
              new Date(at).getUTCMonth(),
              new Date(at).getUTCDate(),
            ),
            globalDailyBudgetUsd: settings.localAiGuardDailyFallbackBudgetUsd,
            targetDailyBudgetUsd: target?.dailyFallbackBudgetUsd,
            incidentBudgetUsd: incident ? target?.incidentFallbackBudgetUsd : undefined,
          };
        },
      });
      const routing = new LocalAiRoutingGuard({
        targets,
        scheduler,
        health,
        approvals,
        incidents,
        settings: () => {
          const settings = getSettingsManager().getAll();
          return {
            localAiGuardDefaultFallbackPolicy: settings.localAiGuardDefaultFallbackPolicy,
            localAiGuardDailyFallbackBudgetUsd: settings.localAiGuardDailyFallbackBudgetUsd,
            localAiGuardConfirmAboveInputTokens: settings.localAiGuardConfirmAboveInputTokens,
          };
        },
        resolveFallbackModel: () => {
          const settings = getSettingsManager().getAll();
          const provider = settings.defaultCli;
          const model = settings.defaultModelByProvider[provider] ?? settings.defaultModel;
          return provider !== 'auto' && model ? { provider, model } : undefined;
        },
        notifyFallback: notifyFallbackInto(() => runtime),
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
        approvals,
        routing,
      };
    }
    runtime = new LocalAiGuardRuntime(services, () => {
      if (runtimeInstance === runtime) runtimeInstance = undefined;
    });
    constructedIncidents = undefined;

    const targetChanged = (target: { id: string }) => {
      runtime!.scheduler.targetChanged(target.id);
      runtime!.notifyChanged();
    };
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
    runtime.addDisposer(installLocalAiAuxiliaryRuntimeHooks(runtime));
    runtime.addDisposer(subscribeCostAttribution((record) => {
      applyLocalAiRoutingCostAttribution(runtime!, record);
      if (record.correlationId) runtime!.refreshFallbackNotification(record.correlationId);
      runtime!.notifyChanged();
    }));
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

export function applyLocalAiRoutingCostAttribution(
  runtime: Pick<LocalAiGuardRuntime, 'health'>,
  record: CostAttributionRecord,
): void {
  if (!record.correlationId || !runtime.health.getRoutingEvent(record.correlationId)) return;
  const inputTokens = finiteTokenCount(record.usage?.inputTokens);
  const outputTokens = finiteTokenCount(record.usage?.outputTokens);
  const knownCostUsd = record.costKnown === true
    && typeof record.usage?.cost === 'number'
    && Number.isFinite(record.usage.cost)
    && record.usage.cost >= 0
    ? record.usage.cost
    : undefined;
  const estimatedCostUsd = knownCostUsd === undefined
    && record.provider
    && record.model
    && (inputTokens !== undefined || outputTokens !== undefined)
    ? computeProviderTokenCost(record.provider, record.model, {
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
      })
    : undefined;
  runtime.health.updateRoutingEvent(record.correlationId, {
    ...(record.provider ? { provider: record.provider } : {}),
    ...(record.model ? { model: record.model } : {}),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(knownCostUsd === undefined ? {} : { knownCostUsd }),
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
  });
}

function finiteTokenCount(value: number | undefined): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
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
