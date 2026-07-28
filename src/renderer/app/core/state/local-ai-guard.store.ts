import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  LocalAiAggregateStatus,
  LocalAiDiagnosticReport,
  LocalAiDiscoveredEndpoint,
  LocalAiEffectivenessSummary,
  LocalAiFallbackResolution,
  LocalAiGuardSnapshot,
  LocalAiIncident,
  LocalAiProbeResult,
  LocalAiRepairAction,
  LocalAiRepairResult,
  LocalAiTarget,
  LocalAiTargetConfig,
  LocalAiTargetLifecycle,
  LocalAiTargetLifecycleOptions,
  LocalAiTargetPatch,
  LocalAiTargetStatus,
} from '../../../../shared/types/local-ai-guard.types';
import { compareLocalAiRevisionCursors } from '../../../../shared/types/local-ai-guard.types';
import type { IpcResponse } from '../services/ipc/electron-ipc.service';
import { LocalAiGuardIpcService } from '../services/ipc/local-ai-guard-ipc.service';

const EMPTY_AGGREGATE: LocalAiAggregateStatus = {
  state: 'not-configured',
  enrolled: 0,
  healthy: 0,
  degraded: 0,
  unavailable: 0,
  paused: 0,
};

export const LOCAL_AI_STATUS_ERROR = 'Local AI Guard status could not be refreshed.';
export const LOCAL_AI_RESOLUTION_ERROR = 'Fallback decision could not be saved. Try again.';
export const LOCAL_AI_OPERATION_ERROR =
  'The Local AI Guard operation could not be completed. Try again.';
export const LOCAL_AI_EFFECTIVENESS_ERROR =
  'Effectiveness data could not be loaded.';

interface LocalAiOperationEntry {
  start(): void;
  cancel(): void;
}

interface LocalAiOperationQueue {
  generation: number;
  active: LocalAiOperationEntry | null;
  pending: LocalAiOperationEntry[];
}

@Injectable({ providedIn: 'root' })
export class LocalAiGuardStore {
  private readonly ipc = inject(LocalAiGuardIpcService);
  private readonly _snapshot = signal<LocalAiGuardSnapshot | null>(null);
  private readonly _isInitialized = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _resolvingFallbackId = signal<string | null>(null);
  private readonly _discoveries = signal<LocalAiDiscoveredEndpoint[]>([]);
  private readonly _operationKey = signal<string | null>(null);
  private readonly _operationError = signal<string | null>(null);
  private readonly _diagnostics = signal(new Map<string, LocalAiDiagnosticReport>());
  private readonly _repairs = signal(new Map<string, LocalAiRepairResult>());
  private readonly _knownTargets = signal(new Map<string, LocalAiTarget>());
  private readonly _effectiveness = signal<LocalAiEffectivenessSummary | null>(null);
  private readonly _effectivenessWindow =
    signal<LocalAiEffectivenessSummary['window']>('24h');
  private readonly _effectivenessLoading = signal(false);
  private readonly _effectivenessError = signal<string | null>(null);
  private readonly invalidatedTargetIds = new Set<string>();

  private unsubscribe: (() => void) | null = null;
  private initialization: Promise<void> | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private resolutionInFlight: Promise<void> | null = null;
  private operationQueue: LocalAiOperationQueue = {
    generation: 0,
    active: null,
    pending: [],
  };
  private readonly discoveryOperations =
    new Map<string, Promise<LocalAiDiscoveredEndpoint[] | undefined>>();
  private readonly validationOperations =
    new Map<string, Promise<LocalAiProbeResult[] | undefined>>();
  private readonly targetOperations =
    new Map<string, Promise<LocalAiTarget | undefined>>();
  private readonly statusOperations =
    new Map<string, Promise<LocalAiTargetStatus | undefined>>();
  private readonly incidentOperations =
    new Map<string, Promise<LocalAiIncident | undefined>>();
  private readonly diagnosticOperations =
    new Map<string, Promise<LocalAiDiagnosticReport | undefined>>();
  private readonly repairOperations =
    new Map<string, Promise<LocalAiRepairResult | undefined>>();
  private generation = 0;
  private latestFetchToken = 0;
  private highestRevision: string | null = null;
  private latestEffectivenessToken = 0;

  readonly snapshot = this._snapshot.asReadonly();
  readonly hasAuthoritativeSnapshot = computed(() => this._snapshot() !== null);
  readonly isInitialized = this._isInitialized.asReadonly();
  readonly error = this._error.asReadonly();
  readonly resolvingFallbackId = this._resolvingFallbackId.asReadonly();
  readonly discoveries = this._discoveries.asReadonly();
  readonly operationKey = this._operationKey.asReadonly();
  readonly operationError = this._operationError.asReadonly();
  readonly aggregate = computed(() => this._snapshot()?.aggregate ?? EMPTY_AGGREGATE);
  readonly targets = computed(() => this._snapshot()?.targets ?? []);
  readonly activeIncidents = computed(() =>
    (this._snapshot()?.incidents ?? []).filter((incident) => incident.state !== 'resolved'));
  readonly pendingFallbacks = computed(() =>
    (this._snapshot()?.pendingFallbacks ?? []).filter((request) => request.status === 'pending'));
  readonly recoveryAttempts = computed(() => this._snapshot()?.recoveryAttempts ?? []);
  readonly effectiveness = this._effectiveness.asReadonly();
  readonly effectivenessWindow = this._effectivenessWindow.asReadonly();
  readonly effectivenessLoading = this._effectivenessLoading.asReadonly();
  readonly effectivenessError = this._effectivenessError.asReadonly();

  initialize(): Promise<void> {
    if (this._isInitialized()) return Promise.resolve();
    if (this.initialization) return this.initialization;

    const generation = this.advanceGeneration();
    const initialization = this.performInitialization(generation).finally(() => {
      if (this.initialization === initialization) {
        this.initialization = null;
      }
    });
    this.initialization = initialization;
    return this.initialization;
  }

  refresh(): Promise<void> {
    if (!this._isInitialized() && !this.initialization) {
      return Promise.resolve();
    }
    if (this.refreshInFlight) return this.refreshInFlight;

    const generation = this.generation;
    const refresh = this.fetchSnapshot(generation).finally(() => {
      if (this.refreshInFlight === refresh) {
        this.refreshInFlight = null;
      }
    });
    this.refreshInFlight = refresh;
    return this.refreshInFlight;
  }

  resolveFallback(
    requestId: string,
    resolution: LocalAiFallbackResolution,
  ): Promise<void> {
    if (this.resolutionInFlight) return this.resolutionInFlight;
    if (!this.pendingFallbacks().some((request) => request.id === requestId)) {
      return Promise.resolve();
    }

    const generation = this.generation;
    this._resolvingFallbackId.set(requestId);
    this._error.set(null);
    const operation = this.performResolution(requestId, resolution, generation).finally(() => {
      if (this.resolutionInFlight === operation) {
        this.resolutionInFlight = null;
        if (generation === this.generation) {
          this._resolvingFallbackId.set(null);
        }
      }
    });
    this.resolutionInFlight = operation;
    return this.resolutionInFlight;
  }

  loadInventory(): Promise<LocalAiDiscoveredEndpoint[] | undefined> {
    return this.runOperation(
      'discover',
      'discover',
      this.discoveryOperations,
      () => this.ipc.discover(),
      (endpoints) => this.setDiscoveries(endpoints),
      false,
    );
  }

  validateTarget(
    config: LocalAiTargetConfig,
  ): Promise<LocalAiProbeResult[] | undefined> {
    return this.runOperation(
      this.operationIdentity('validate', config),
      'validate',
      this.validationOperations,
      () => this.ipc.validate(config),
      undefined,
      false,
    );
  }

  createTarget(config: LocalAiTargetConfig): Promise<LocalAiTarget | undefined> {
    return this.runOperation(
      this.operationIdentity('create', config),
      'create',
      this.targetOperations,
      () => this.ipc.createTarget(config),
      (target) => this.rememberTarget(target),
    );
  }

  updateTarget(
    targetId: string,
    patch: LocalAiTargetPatch,
  ): Promise<LocalAiTarget | undefined> {
    return this.runOperation(
      this.operationIdentity(`update:${targetId}`, patch),
      `update:${targetId}`,
      this.targetOperations,
      () => this.ipc.updateTarget(targetId, patch),
      (target) => this.rememberTarget(target),
    );
  }

  setTargetLifecycle(
    targetId: string,
    lifecycle: Extract<LocalAiTargetLifecycle, 'enrolled' | 'paused' | 'retired'>,
    options: LocalAiTargetLifecycleOptions = {},
  ): Promise<LocalAiTarget | undefined> {
    return this.runOperation(
      this.operationIdentity(`lifecycle:${targetId}`, { lifecycle, options }),
      `lifecycle:${targetId}`,
      this.targetOperations,
      () => this.ipc.setTargetLifecycle(targetId, lifecycle, options),
      (target) => this.rememberTarget(target),
    );
  }

  recheckTarget(
    targetId: string,
    kind: 'lightweight' | 'functional',
  ): Promise<LocalAiTargetStatus | undefined> {
    return this.runOperation(
      this.operationIdentity(`recheck:${targetId}`, kind),
      `recheck:${targetId}`,
      this.statusOperations,
      () => this.ipc.recheck(targetId, kind),
    );
  }

  acknowledgeIncident(incidentId: string): Promise<LocalAiIncident | undefined> {
    return this.runOperation(
      `acknowledge:${incidentId}`,
      `acknowledge:${incidentId}`,
      this.incidentOperations,
      () => this.ipc.acknowledgeIncident(incidentId),
    );
  }

  diagnoseTarget(targetId: string): Promise<LocalAiDiagnosticReport | undefined> {
    return this.runOperation(
      `diagnose:${targetId}`,
      `diagnose:${targetId}`,
      this.diagnosticOperations,
      () => this.ipc.diagnose(targetId),
      (report) => this.updateMap(this._diagnostics, targetId, report),
      false,
    );
  }

  repairTarget(
    targetId: string,
    action: LocalAiRepairAction,
    mode: 'guided' | 'automatic',
  ): Promise<LocalAiRepairResult | undefined> {
    return this.runOperation(
      this.operationIdentity(`repair:${targetId}`, { action, mode }),
      `repair:${targetId}`,
      this.repairOperations,
      () => this.ipc.repair(targetId, action, mode),
      (result) => this.updateMap(this._repairs, targetId, result),
    );
  }

  async loadEffectiveness(
    window: LocalAiEffectivenessSummary['window'],
  ): Promise<void> {
    const requestToken = ++this.latestEffectivenessToken;
    this._effectivenessWindow.set(window);
    this._effectiveness.set(null);
    this._effectivenessLoading.set(true);
    this._effectivenessError.set(null);
    try {
      const response = await this.ipc.getSummary(window);
      if (requestToken !== this.latestEffectivenessToken) return;
      if (
        !response.success
        || response.data === undefined
        || response.data.window !== window
      ) {
        this._effectiveness.set(null);
        this._effectivenessError.set(LOCAL_AI_EFFECTIVENESS_ERROR);
        return;
      }
      this._effectiveness.set(response.data);
    } catch {
      if (requestToken !== this.latestEffectivenessToken) return;
      this._effectiveness.set(null);
      this._effectivenessError.set(LOCAL_AI_EFFECTIVENESS_ERROR);
    } finally {
      if (requestToken === this.latestEffectivenessToken) {
        this._effectivenessLoading.set(false);
      }
    }
  }

  diagnosticFor(targetId: string): LocalAiDiagnosticReport | null {
    return this._diagnostics().get(targetId) ?? null;
  }

  repairFor(targetId: string): LocalAiRepairResult | null {
    return this._repairs().get(targetId) ?? null;
  }

  knownTarget(targetId: string): LocalAiTarget | null {
    return this._knownTargets().get(targetId) ?? null;
  }

  destroy(): void {
    this.advanceGeneration();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.initialization = null;
    this.refreshInFlight = null;
    this.resolutionInFlight = null;
    ++this.latestFetchToken;
    ++this.latestEffectivenessToken;
    this.highestRevision = null;
    this._snapshot.set(null);
    this._isInitialized.set(false);
    this._error.set(null);
    this._resolvingFallbackId.set(null);
    this._discoveries.set([]);
    this._operationKey.set(null);
    this._operationError.set(null);
    this._diagnostics.set(new Map<string, LocalAiDiagnosticReport>());
    this._repairs.set(new Map<string, LocalAiRepairResult>());
    this._knownTargets.set(new Map<string, LocalAiTarget>());
    this._effectiveness.set(null);
    this._effectivenessWindow.set('24h');
    this._effectivenessLoading.set(false);
    this._effectivenessError.set(null);
    this.invalidatedTargetIds.clear();
  }

  private async performInitialization(generation: number): Promise<void> {
    await this.fetchSnapshot(generation);
    if (!this.isCurrent(generation)) return;

    const unsubscribe = this.ipc.onStatusDelta((next) => {
      if (!this.isCurrent(generation)) return;
      this.applyServerSnapshot(next);
    });
    if (!this.isCurrent(generation)) {
      unsubscribe();
      return;
    }
    this.unsubscribe = unsubscribe;

    await this.fetchSnapshot(generation);
    if (!this.isCurrent(generation)) return;
    this._isInitialized.set(true);
  }

  private async fetchSnapshot(generation: number): Promise<void> {
    const requestToken = ++this.latestFetchToken;
    const startingRevision = this.highestRevision;
    try {
      const response = await this.ipc.getSnapshot();
      if (!this.isCurrent(generation)) return;
      if (!response.success || !response.data) {
        this.recordFetchFailure(generation, requestToken, startingRevision);
        return;
      }
      this.applyServerSnapshot(response.data);
      this._error.set(null);
    } catch {
      this.recordFetchFailure(generation, requestToken, startingRevision);
    }
  }

  private async performResolution(
    requestId: string,
    resolution: LocalAiFallbackResolution,
    generation: number,
  ): Promise<void> {
    try {
      const response = await this.ipc.resolveFallback(requestId, resolution);
      if (!this.isCurrent(generation)) return;
      if (!response.success || !response.data) {
        this._error.set(LOCAL_AI_RESOLUTION_ERROR);
        return;
      }

      const current = this._snapshot();
      if (current) {
        this._snapshot.set({
          ...current,
          pendingFallbacks: current.pendingFallbacks.filter(
            (request) => request.id !== requestId,
          ),
        });
      }
      await this.refresh();
    } catch {
      if (this.isCurrent(generation)) this._error.set(LOCAL_AI_RESOLUTION_ERROR);
    }
  }

  private applyServerSnapshot(snapshot: LocalAiGuardSnapshot): void {
    if (
      this.highestRevision !== null
      && compareLocalAiRevisionCursors(snapshot.revision, this.highestRevision) <= 0
    ) {
      return;
    }
    this.highestRevision = snapshot.revision;
    this.replaceKnownTargets(snapshot.targetConfigs ?? []);
    this._snapshot.set(snapshot);
    this._error.set(null);
  }

  private recordFetchFailure(
    generation: number,
    requestToken: number,
    startingRevision: string | null,
  ): void {
    if (
      this.isCurrent(generation)
      && requestToken === this.latestFetchToken
      && this.highestRevision === startingRevision
    ) {
      this._error.set(LOCAL_AI_STATUS_ERROR);
    }
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  private advanceGeneration(): number {
    const generation = ++this.generation;
    const staleQueue = this.operationQueue;
    const staleEntries = [
      ...(staleQueue.active ? [staleQueue.active] : []),
      ...staleQueue.pending,
    ];
    staleQueue.active = null;
    staleQueue.pending = [];
    this.operationQueue = { generation, active: null, pending: [] };
    this.clearOperationMaps();
    this._operationKey.set(null);
    for (const entry of staleEntries) entry.cancel();
    return generation;
  }

  private clearOperationMaps(): void {
    this.discoveryOperations.clear();
    this.validationOperations.clear();
    this.targetOperations.clear();
    this.statusOperations.clear();
    this.incidentOperations.clear();
    this.diagnosticOperations.clear();
    this.repairOperations.clear();
  }

  private runOperation<T>(
    identity: string,
    key: string,
    operations: Map<string, Promise<T | undefined>>,
    operation: () => Promise<IpcResponse<T>>,
    onSuccess?: (data: T) => void,
    refreshAfter = true,
  ): Promise<T | undefined> {
    const existing = operations.get(identity);
    if (existing) return existing;

    const generation = this.generation;
    const queue = this.operationQueue;
    let resolvePending!: (result: T | undefined) => void;
    const pending = new Promise<T | undefined>((resolve) => {
      resolvePending = resolve;
    });
    let settled = false;
    const settle = (result: T | undefined) => {
      if (settled) return;
      settled = true;
      resolvePending(result);
      if (operations.get(identity) === pending) {
        operations.delete(identity);
      }
      if (queue.active === entry) {
        queue.active = null;
        if (this.operationQueue === queue && this.isCurrent(generation)) {
          this._operationKey.set(null);
          this.startNextOperation(queue);
        }
      }
    };
    const entry: LocalAiOperationEntry = {
      start: () => {
        if (!this.isCurrent(generation)) {
          settle(undefined);
          return;
        }
        this._operationKey.set(key);
        this._operationError.set(null);
        void this.performOperation(operation, generation, onSuccess, refreshAfter)
          .then(settle, () => settle(undefined));
      },
      cancel: () => settle(undefined),
    };
    operations.set(identity, pending);
    if (queue.active) {
      queue.pending.push(entry);
    } else {
      queue.active = entry;
      entry.start();
    }
    return pending;
  }

  private startNextOperation(queue: LocalAiOperationQueue): void {
    if (
      this.operationQueue !== queue
      || queue.generation !== this.generation
      || queue.active
    ) {
      return;
    }
    const next = queue.pending.shift();
    if (!next) return;
    queue.active = next;
    next.start();
  }

  private operationIdentity(key: string, input: unknown): string {
    return `${key}:${JSON.stringify(input)}`;
  }

  private async performOperation<T>(
    operation: () => Promise<IpcResponse<T>>,
    generation: number,
    onSuccess: ((data: T) => void) | undefined,
    refreshAfter: boolean,
  ): Promise<T | undefined> {
    try {
      const response = await operation();
      if (!this.isCurrent(generation)) return undefined;
      if (!response.success || response.data === undefined) {
        this._operationError.set(LOCAL_AI_OPERATION_ERROR);
        return undefined;
      }
      onSuccess?.(response.data);
      this._operationError.set(null);
      if (refreshAfter) await this.refresh();
      return response.data;
    } catch {
      if (this.isCurrent(generation)) this._operationError.set(LOCAL_AI_OPERATION_ERROR);
      return undefined;
    }
  }

  private rememberTarget(target: LocalAiTarget): void {
    const next = new Map(this._knownTargets());
    if (target.lifecycle === 'retired') {
      next.delete(target.id);
      this.invalidateLinkedTarget(target.id);
    } else {
      next.set(target.id, target);
      this.invalidatedTargetIds.delete(target.id);
    }
    this._knownTargets.set(next);
    this.reconcileDiscoveries();
  }

  private replaceKnownTargets(targets: LocalAiTarget[]): void {
    const previous = this._knownTargets();
    const next = new Map(
      targets
        .filter((target) => target.lifecycle !== 'retired')
        .map((target) => [target.id, target]),
    );
    for (const targetId of previous.keys()) {
      if (!next.has(targetId)) this.invalidateLinkedTarget(targetId);
    }
    for (const targetId of next.keys()) this.invalidatedTargetIds.delete(targetId);
    this._knownTargets.set(next);
    this.reconcileDiscoveries();
  }

  private setDiscoveries(endpoints: LocalAiDiscoveredEndpoint[]): void {
    this._discoveries.set(this.withEnrolmentLinks(endpoints));
  }

  private reconcileDiscoveries(): void {
    this._discoveries.update((endpoints) => this.withEnrolmentLinks(endpoints));
  }

  private withEnrolmentLinks(
    endpoints: LocalAiDiscoveredEndpoint[],
  ): LocalAiDiscoveredEndpoint[] {
    const targetByIdentity = new Map<string, string>();
    for (const target of this._knownTargets().values()) {
      targetByIdentity.set(endpointIdentityKey(target), target.id);
    }
    return endpoints.map((endpoint) => {
      const enrolledTargetId = targetByIdentity.get(endpointIdentityKey(endpoint.identity));
      if (enrolledTargetId) return { ...endpoint, enrolledTargetId };
      if (endpoint.enrolledTargetId === undefined) return endpoint;
      const linkedTarget = this._knownTargets().get(endpoint.enrolledTargetId);
      if (
        !this.invalidatedTargetIds.has(endpoint.enrolledTargetId)
        && linkedTarget === undefined
      ) {
        return endpoint;
      }
      return {
        identity: endpoint.identity,
        label: endpoint.label,
        models: endpoint.models,
        healthy: endpoint.healthy,
      };
    });
  }

  private invalidateLinkedTarget(targetId: string): void {
    if (this._discoveries().some((endpoint) => endpoint.enrolledTargetId === targetId)) {
      this.invalidatedTargetIds.add(targetId);
    }
  }

  private updateMap<T>(
    destination: ReturnType<typeof signal<Map<string, T>>>,
    key: string,
    value: T,
  ): void {
    const next = new Map(destination());
    next.set(key, value);
    destination.set(next);
  }
}

function endpointIdentityKey(
  identity: Pick<LocalAiTarget, 'location' | 'provider' | 'endpointId' | 'baseUrl'>,
): string {
  return JSON.stringify([
    identity.location.type,
    identity.location.type === 'worker' ? identity.location.nodeId : '',
    identity.provider,
    identity.endpointId,
    identity.baseUrl,
  ]);
}
