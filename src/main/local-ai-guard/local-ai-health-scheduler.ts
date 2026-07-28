import { randomUUID } from 'node:crypto';
import type { AuxiliaryLlmSlot } from '../../shared/types/auxiliary-llm.types';
import type {
  LocalAiHealthSample,
  LocalAiIncident,
  LocalAiProbeResult,
  LocalAiTarget,
  LocalAiTargetStatus,
} from '../../shared/types/local-ai-guard.types';
import { LocalAiProbeResultSchema } from '../../shared/validation/local-ai-guard.schemas';
import { getLogger } from '../logging/logger';
import { LocalAiActivityRegistry } from './local-ai-activity-registry';
import { LocalAiHealthEngine } from './local-ai-health-engine';
import type { LocalAiHealthRepository } from './local-ai-health-repository';
import type { LocalAiIncidentService } from './local-ai-incident-service';
import { LocalAiPauseExpiryController } from './local-ai-pause-expiry-controller';
import type { LocalAiProbeService } from './local-ai-probe-service';
import type { LocalAiTargetRepository } from './local-ai-target-repository';
import {
  groupLocalAiHealthSamples as groupSamples,
  localAiCheckKey as checkKey,
  localAiDeferredCheckKey as deferredKey,
  newestLocalAiProbeTimestamp as newestTimestamp,
  runLocalAiFailSoft,
} from './local-ai-health-scheduler-utils';

export type LocalAiCheckKind = 'lightweight' | 'functional';

export interface LocalAiSchedulerTimerPort {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface LocalAiHealthSchedulerLogger {
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface LocalAiHealthSchedulerDependencies {
  targets: Pick<LocalAiTargetRepository, 'get' | 'list' | 'setLifecycle'>;
  health: Pick<
    LocalAiHealthRepository,
    'appendSample' | 'latestSamples' | 'listIncidents' | 'runRetention'
  >;
  probes: Pick<LocalAiProbeService, 'check'>;
  incidents: Pick<LocalAiIncidentService, 'handleTransition'>;
  activity?: LocalAiActivityRegistry;
  engine?: LocalAiHealthEngine;
  now?: () => number;
  random?: () => number;
  timers?: LocalAiSchedulerTimerPort;
  createId?: () => string;
  logger?: LocalAiHealthSchedulerLogger;
}

const DEFAULT_LIGHTWEIGHT_INTERVAL_MS = 60_000;
const DEFAULT_FUNCTIONAL_INTERVAL_MS = 10 * 60_000;
const DEFAULT_FRESHNESS_LIMIT_MS = 120_000;
const FUNCTIONAL_BUSY_RETRY_MS = 5_000;
const RETENTION_INTERVAL_MS = 24 * 60 * 60_000;
const MAX_OUTAGE_BACKOFF_MS = 15 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
interface ScheduledTimer {
  handle: unknown;
  token: symbol;
}

interface DeferredCheck {
  promise: Promise<LocalAiTargetStatus>;
  reject(error: Error): void;
}

interface InFlightCheck {
  promise: Promise<LocalAiTargetStatus>;
  generation: number;
  targetRevision: number;
  targetUpdatedAt: number;
}

interface ReplacementCheck extends DeferredCheck, Omit<InFlightCheck, 'promise'> {}
export class LocalAiHealthScheduler {
  private readonly engine: LocalAiHealthEngine;
  private readonly activity: LocalAiActivityRegistry;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly timers: LocalAiSchedulerTimerPort;
  private readonly createId: () => string;
  private readonly logger: LocalAiHealthSchedulerLogger;
  private readonly pauseExpiries: LocalAiPauseExpiryController;
  private readonly scheduled = new Map<string, ScheduledTimer>();
  private readonly inFlight = new Map<string, InFlightCheck>();
  private readonly replacementChecks = new Map<string, ReplacementCheck>();
  private readonly deferredChecks = new Map<string, DeferredCheck>();
  private readonly failureCounts = new Map<string, number>();
  private readonly statuses = new Map<string, LocalAiTargetStatus>();
  private readonly connectedWorkerNodes = new Set<string>();
  private readonly targetRevisions = new Map<string, number>();
  private readonly validatedGenerations = new Map<string, number>();
  private readonly listeners = new Set<(status: LocalAiTargetStatus) => void>();
  private started = false;
  private generation = 0;

  constructor(private readonly dependencies: LocalAiHealthSchedulerDependencies) {
    this.engine = dependencies.engine ?? new LocalAiHealthEngine();
    this.activity = dependencies.activity ?? new LocalAiActivityRegistry();
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
    this.timers = dependencies.timers ?? {
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.createId = dependencies.createId ?? randomUUID;
    this.logger = dependencies.logger ?? getLogger('LocalAiHealthScheduler');
    this.pauseExpiries = new LocalAiPauseExpiryController(
      dependencies.targets, this.timers, this.now,
      (targetId) => this.targetRevisions.get(targetId) ?? 0,
      (targetId) => this.targetChanged(targetId), this.logger);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.generation += 1;
    for (const target of this.dependencies.targets.list({ includeRetired: true })) {
      this.reconstructSafeStatus(target);
      if (target.lifecycle === 'paused') this.pauseExpiries.schedule(target);
      else if (this.shouldPoll(target)) this.scheduleTarget(target, true);
    }
    this.scheduleRetention(0);
  }

  stop(): void {
    const idle = !this.started && this.scheduled.size === 0 && this.inFlight.size === 0
      && this.deferredChecks.size === 0 && this.replacementChecks.size === 0;
    if (idle) return;
    this.started = false;
    this.generation += 1;
    for (const timer of this.scheduled.values()) this.timers.cancel(timer.handle);
    this.scheduled.clear();
    this.pauseExpiries.stop();
    for (const deferred of this.deferredChecks.values()) {
      deferred.reject(new Error('Local AI Guard scheduler stopped'));
    }
    this.deferredChecks.clear();
    for (const replacement of this.replacementChecks.values()) {
      replacement.reject(new Error('Local AI Guard scheduler stopped'));
    }
    this.replacementChecks.clear();
  }

  recheck(targetId: string, kind: LocalAiCheckKind): Promise<LocalAiTargetStatus> {
    const target = this.dependencies.targets.get(targetId);
    if (!target || !this.shouldPoll(target)) {
      return Promise.reject(new Error('Local AI target is not available for health checks'));
    }
    const key = checkKey(targetId, kind);
    const existing = this.inFlight.get(key);
    if (existing && this.isCurrentFlight(existing, target)) return existing.promise;
    const replacement = this.replacementChecks.get(key);
    if (replacement && this.isCurrentReplacement(replacement, target)) {
      return replacement.promise;
    }
    if (existing) return this.queueReplacement(target, kind, existing);
    const deferred = this.deferredChecks.get(key);
    if (deferred) return deferred.promise;
    if (kind === 'functional' && this.activity.isBusy(targetId)) {
      return this.deferManualFunctionalCheck(target);
    }
    return this.beginCheck(target, kind, 'manual', true);
  }

  ensureFresh(targetId: string, role: AuxiliaryLlmSlot): Promise<LocalAiTargetStatus> {
    const target = this.dependencies.targets.get(targetId);
    if (!target || target.lifecycle !== 'enrolled' || !target.routingRoles.includes(role)) {
      return Promise.reject(new Error('Local AI target is not enrolled for this role'));
    }
    const status = this.statuses.get(targetId) ?? this.reconstructSafeStatus(target);
    const age = this.currentTimestamp() - status.checkedAt;
    if (
      this.validatedGenerations.get(targetId) === this.generation
      && status.state !== 'checking'
      && age >= 0
      && age <= this.freshnessFor(target)
    ) {
      return Promise.resolve(status);
    }
    return this.recheck(targetId, 'lightweight');
  }

  getStatus(targetId: string): LocalAiTargetStatus | undefined {
    return this.statuses.get(targetId);
  }

  subscribe(listener: (status: LocalAiTargetStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  targetChanged(targetId: string): void {
    this.invalidateTarget(targetId);
    this.validatedGenerations.delete(targetId);
    const target = this.dependencies.targets.get(targetId);
    this.cancelTarget(targetId);
    if (!target) {
      this.statuses.delete(targetId);
      return;
    }
    if (!this.shouldPoll(target)) {
      const previous = this.statuses.get(target.id);
      this.statuses.set(
        target.id,
        this.engine.apply(target, previous, [], this.currentTimestamp()).current,
      );
      this.notify(this.statuses.get(target.id)!);
      if (this.started && target.lifecycle === 'paused') this.pauseExpiries.schedule(target);
      return;
    }
    this.notify(this.reconstructSafeStatus(target));
    if (this.started) this.scheduleTarget(target, true);
  }

  workerConnected(nodeId: string): void {
    this.connectedWorkerNodes.add(nodeId);
    for (const target of this.workerTargets(nodeId)) {
      this.invalidateTarget(target.id);
      this.validatedGenerations.delete(target.id);
      if (!this.started) continue;
      if (!this.shouldPoll(target)) continue;
      this.scheduleTarget(target, false);
      runLocalAiFailSoft(() => this.recheck(target.id, 'lightweight'), this.logger, 'worker-reconnect-check');
    }
  }

  workerDisconnected(nodeId: string): void {
    const wasConnected = this.connectedWorkerNodes.delete(nodeId);
    for (const target of this.workerTargets(nodeId)) {
      this.invalidateTarget(target.id);
      this.validatedGenerations.delete(target.id);
      if (wasConnected && target.lifecycle === 'enrolled') this.recordWorkerOffline(target);
      this.cancelTarget(target.id);
    }
  }

  private workerTargets(nodeId: string): LocalAiTarget[] {
    return this.dependencies.targets.list({ includeRetired: true }).filter((target) =>
      target.location.type === 'worker' && target.location.nodeId === nodeId);
  }

  private scheduleTarget(target: LocalAiTarget, immediateLightweight: boolean): void {
    if (!this.shouldPoll(target)) return;
    this.scheduleCheck(
      target,
      'lightweight',
      immediateLightweight ? 0 : this.intervalFor(target, 'lightweight'),
    );
    if (!this.scheduled.has(checkKey(target.id, 'functional'))) {
      this.scheduleCheck(target, 'functional', this.intervalFor(target, 'functional'));
    }
  }

  private scheduleCheck(target: LocalAiTarget, kind: LocalAiCheckKind, delayMs: number): void {
    const key = checkKey(target.id, kind);
    this.scheduleTimer(key, delayMs, () => {
      if (!this.started) return;
      const current = this.dependencies.targets.get(target.id);
      if (!current || !this.shouldPoll(current)) {
        this.cancelTarget(target.id);
        return;
      }
      if (kind === 'functional' && this.activity.isBusy(target.id)) {
        this.scheduleCheck(current, kind, FUNCTIONAL_BUSY_RETRY_MS);
        return;
      }
      return this.beginCheck(current, kind, 'scheduler', false).then(() => undefined);
    });
  }

  private beginCheck(
    target: LocalAiTarget,
    kind: LocalAiCheckKind,
    origin: LocalAiHealthSample['origin'],
    manual: boolean,
  ): Promise<LocalAiTargetStatus> {
    const key = checkKey(target.id, kind);
    const existing = this.inFlight.get(key);
    if (existing) return existing.promise;
    const generation = this.generation;
    const targetRevision = this.targetRevisions.get(target.id) ?? 0;
    const pending = this.performCheck(target, kind, origin, generation, targetRevision)
      .then((status) => {
        const current = this.dependencies.targets.get(target.id);
        if (this.started && current && this.shouldPoll(current)) {
          const invalidated = targetRevision !== (this.targetRevisions.get(target.id) ?? 0);
          this.scheduleCheck(current, kind, invalidated ? 0 : this.nextDelay(current, kind));
        }
        return status;
      })
      .finally(() => {
        if (this.inFlight.get(key)?.promise === pending) this.inFlight.delete(key);
      });
    this.inFlight.set(key, {
      promise: pending,
      generation,
      targetRevision,
      targetUpdatedAt: target.updatedAt,
    });
    if (manual) this.cancelTimer(key);
    return pending;
  }

  private deferManualFunctionalCheck(target: LocalAiTarget): Promise<LocalAiTargetStatus> {
    const key = checkKey(target.id, 'functional');
    this.cancelTimer(key);
    let resolveDeferred!: (status: LocalAiTargetStatus) => void;
    let rejectDeferred!: (error: Error) => void;
    const promise = new Promise<LocalAiTargetStatus>((resolve, reject) => {
      resolveDeferred = resolve;
      rejectDeferred = reject;
    });
    this.deferredChecks.set(key, { promise, reject: rejectDeferred });
    const attempt = () => {
      const current = this.dependencies.targets.get(target.id);
      if (!current || !this.shouldPoll(current)) {
        this.deferredChecks.delete(key);
        rejectDeferred(new Error('Local AI target is not available for health checks'));
        return;
      }
      if (this.activity.isBusy(target.id)) {
        this.scheduleTimer(deferredKey(key), FUNCTIONAL_BUSY_RETRY_MS, attempt);
        return;
      }
      this.deferredChecks.delete(key);
      this.beginCheck(current, 'functional', 'manual', true).then(resolveDeferred, rejectDeferred);
    };
    this.scheduleTimer(deferredKey(key), FUNCTIONAL_BUSY_RETRY_MS, attempt);
    return promise;
  }

  private queueReplacement(
    target: LocalAiTarget,
    kind: LocalAiCheckKind,
    flight: InFlightCheck,
  ): Promise<LocalAiTargetStatus> {
    const key = checkKey(target.id, kind);
    const existing = this.replacementChecks.get(key);
    if (existing) {
      if (this.isCurrentReplacement(existing, target)) return existing.promise;
      this.replacementChecks.delete(key);
      existing.reject(new Error('Local AI health check was invalidated'));
    }
    let resolveReplacement!: (status: LocalAiTargetStatus) => void;
    let rejectReplacement!: (error: Error) => void;
    const promise = new Promise<LocalAiTargetStatus>((resolve, reject) => {
      resolveReplacement = resolve;
      rejectReplacement = reject;
    });
    const replacement: ReplacementCheck = {
      promise,
      reject: rejectReplacement,
      generation: this.generation,
      targetRevision: this.targetRevisions.get(target.id) ?? 0,
      targetUpdatedAt: target.updatedAt,
    };
    this.replacementChecks.set(key, replacement);
    const launch = () => {
      if (this.replacementChecks.get(key) !== replacement) return;
      this.replacementChecks.delete(key);
      const current = this.dependencies.targets.get(target.id);
      if (replacement.generation !== this.generation) {
        rejectReplacement(new Error('Local AI Guard scheduler stopped'));
        return;
      }
      if (!current || !this.shouldPoll(current) || !this.isCurrentReplacement(replacement, current)) {
        rejectReplacement(new Error('Local AI target is not available for health checks'));
        return;
      }
      this.recheck(current.id, kind).then(resolveReplacement, rejectReplacement);
    };
    void flight.promise.then(launch, launch);
    return promise;
  }

  private async performCheck(
    target: LocalAiTarget,
    kind: LocalAiCheckKind,
    origin: LocalAiHealthSample['origin'],
    generation: number,
    targetRevision: number,
  ): Promise<LocalAiTargetStatus> {
    let rawSamples: LocalAiProbeResult[];
    try {
      rawSamples = await this.dependencies.probes.check(target, kind);
    } catch {
      rawSamples = [];
    }
    const current = this.dependencies.targets.get(target.id);
    if (
      generation !== this.generation
      || targetRevision !== (this.targetRevisions.get(target.id) ?? 0)
      || !current
      || !this.shouldPoll(current)
      || current.updatedAt !== target.updatedAt
    ) {
      return this.statuses.get(target.id) ?? this.engine.checking(target, this.currentTimestamp());
    }
    const samples = this.sanitizeSamples(target, kind, origin, rawSamples);
    const status = this.commitSamples(target, samples);
    this.validatedGenerations.set(target.id, this.generation);
    const failed = samples.some((sample) => sample.required && !sample.ok);
    const key = checkKey(target.id, kind);
    this.failureCounts.set(key, failed ? (this.failureCounts.get(key) ?? 0) + 1 : 0);
    return status;
  }

  private commitSamples(target: LocalAiTarget, samples: LocalAiHealthSample[]): LocalAiTargetStatus {
    for (const sample of samples) {
      try {
        this.dependencies.health.appendSample(sample);
      } catch {
        this.logger.warn('Local AI Guard sample persistence failed', { reason: 'repository-error' });
      }
    }
    const previous = this.statuses.get(target.id);
    const transition = this.engine.apply(
      this.targetWithDefaults(target),
      previous,
      samples,
      newestTimestamp(samples),
    );
    this.statuses.set(target.id, transition.current);
    try {
      this.dependencies.incidents.handleTransition(transition);
    } catch {
      this.logger.warn('Local AI Guard incident transition failed', { reason: 'incident-error' });
    }
    this.notify(transition.current);
    return transition.current;
  }

  private recordWorkerOffline(target: LocalAiTarget): void {
    const sample: LocalAiHealthSample = {
      id: this.createId(),
      targetId: target.id,
      layer: 'worker',
      checkType: 'lightweight',
      ok: false,
      required: true,
      affectedRoles: [...target.routingRoles],
      checkedAt: this.currentTimestamp(),
      durationMs: 0,
      failureCode: 'worker-offline',
      evidence: {},
      origin: 'scheduler',
    };
    this.commitSamples(target, [sample]);
  }

  private sanitizeSamples(
    target: LocalAiTarget,
    kind: LocalAiCheckKind,
    origin: LocalAiHealthSample['origin'],
    rawSamples: LocalAiProbeResult[],
  ): LocalAiHealthSample[] {
    const sanitized = rawSamples.flatMap((raw): LocalAiHealthSample[] => {
      const parsed = LocalAiProbeResultSchema.safeParse(raw);
      if (
        !parsed.success
        || parsed.data.targetId !== target.id
        || parsed.data.checkType !== kind
      ) {
        return [];
      }
      return [{
        id: this.createId(),
        targetId: target.id,
        layer: parsed.data.layer,
        checkType: kind,
        ok: parsed.data.ok,
        required: parsed.data.required,
        affectedRoles: [...parsed.data.affectedRoles],
        checkedAt: parsed.data.checkedAt,
        durationMs: parsed.data.durationMs,
        ...(parsed.data.failureCode ? { failureCode: parsed.data.failureCode } : {}),
        evidence: { ...parsed.data.evidence },
        origin,
      }];
    });
    return sanitized.length ? sanitized : [this.monitorFailure(target, kind, origin)];
  }

  private monitorFailure(
    target: LocalAiTarget,
    kind: LocalAiCheckKind,
    origin: LocalAiHealthSample['origin'],
  ): LocalAiHealthSample {
    return {
      id: this.createId(),
      targetId: target.id,
      layer: 'effectiveness',
      checkType: kind,
      ok: false,
      required: true,
      affectedRoles: [...target.routingRoles],
      checkedAt: this.currentTimestamp(),
      durationMs: 0,
      failureCode: 'monitor-error',
      evidence: {},
      origin,
    };
  }

  private reconstructSafeStatus(target: LocalAiTarget): LocalAiTargetStatus {
    const previous = this.rebuildPersistedStatus(target);
    const activeIncidents = this.activeIncidents(target.id);
    const base = previous ?? this.engine.checking(target, target.updatedAt);
    const status: LocalAiTargetStatus = activeIncidents.length > 0
      ? {
          ...base,
          lifecycle: target.lifecycle,
          state: 'unavailable',
          routableRoles: [],
          recoveryState: 'unavailable',
          incidentOpen: true,
          checkedAt: Math.max(base.checkedAt, ...activeIncidents.map((incident) => incident.updatedAt)),
        }
      : {
          ...base,
          lifecycle: target.lifecycle,
          state: target.lifecycle === 'paused' ? 'paused' : 'checking',
          routableRoles: [],
        };
    this.statuses.set(target.id, status);
    return status;
  }

  private rebuildPersistedStatus(target: LocalAiTarget): LocalAiTargetStatus | undefined {
    let samples: LocalAiHealthSample[] = [];
    try {
      samples = this.dependencies.health.latestSamples(target.id);
    } catch {
      return undefined;
    }
    let previous: LocalAiTargetStatus | undefined;
    for (const group of groupSamples(samples)) {
      previous = this.engine.apply(
        this.targetWithDefaults(target),
        previous,
        group,
        newestTimestamp(group),
      ).current;
    }
    return previous;
  }

  private activeIncidents(targetId: string): LocalAiIncident[] {
    try {
      return [
        ...this.dependencies.health.listIncidents({ targetId, state: 'open', limit: 1_000 }),
        ...this.dependencies.health.listIncidents({ targetId, state: 'acknowledged', limit: 1_000 }),
      ];
    } catch {
      return [];
    }
  }

  private nextDelay(target: LocalAiTarget, kind: LocalAiCheckKind): number {
    const base = this.intervalFor(target, kind);
    const failures = this.failureCounts.get(checkKey(target.id, kind)) ?? 0;
    if (failures === 0) return base;
    const exponential = Math.min(MAX_OUTAGE_BACKOFF_MS, base * (2 ** Math.min(failures, 30)));
    const sampled = this.random();
    const boundedRandom = Number.isFinite(sampled) ? Math.min(1, Math.max(0, sampled)) : 0.5;
    const jittered = Math.round(exponential * (0.75 + boundedRandom * 0.5));
    return Math.min(MAX_OUTAGE_BACKOFF_MS, Math.max(1, jittered));
  }

  private intervalFor(target: LocalAiTarget, kind: LocalAiCheckKind): number {
    const configured = kind === 'lightweight'
      ? target.endpointCheckIntervalMs
      : target.canary.intervalMs;
    const fallback = kind === 'lightweight'
      ? DEFAULT_LIGHTWEIGHT_INTERVAL_MS
      : DEFAULT_FUNCTIONAL_INTERVAL_MS;
    return Number.isSafeInteger(configured) && configured > 0 ? configured : fallback;
  }

  private freshnessFor(target: LocalAiTarget): number {
    return Number.isSafeInteger(target.freshnessLimitMs) && target.freshnessLimitMs > 0
      ? target.freshnessLimitMs
      : DEFAULT_FRESHNESS_LIMIT_MS;
  }

  private targetWithDefaults(target: LocalAiTarget): LocalAiTarget {
    return {
      ...target,
      freshnessLimitMs: this.freshnessFor(target),
    };
  }

  private shouldPoll(target: LocalAiTarget): boolean {
    return target.lifecycle === 'enrolled'
      && (
        target.location.type === 'coordinator'
        || this.connectedWorkerNodes.has(target.location.nodeId)
      );
  }

  private isCurrentFlight(flight: InFlightCheck, target: LocalAiTarget): boolean {
    return flight.generation === this.generation
      && flight.targetRevision === (this.targetRevisions.get(target.id) ?? 0)
      && flight.targetUpdatedAt === target.updatedAt;
  }

  private isCurrentReplacement(replacement: ReplacementCheck, target: LocalAiTarget): boolean {
    return replacement.generation === this.generation
      && replacement.targetRevision === (this.targetRevisions.get(target.id) ?? 0)
      && replacement.targetUpdatedAt === target.updatedAt;
  }

  private scheduleRetention(delayMs: number): void {
    this.scheduleTimer('retention', delayMs, () => {
      if (!this.started) return;
      try {
        this.dependencies.health.runRetention(this.currentTimestamp());
      } catch {
        this.logger.warn('Local AI Guard retention failed', { reason: 'repository-error' });
      } finally {
        if (this.started) this.scheduleRetention(RETENTION_INTERVAL_MS);
      }
    });
  }

  private scheduleTimer(
    key: string,
    delayMs: number,
    callback: () => void | Promise<void>,
  ): void {
    this.cancelTimer(key);
    const token = Symbol(key);
    const handle = this.timers.schedule(() => {
      if (this.scheduled.get(key)?.token !== token) return;
      this.scheduled.delete(key);
      try {
        const result = callback();
        if (result) {
          void result.catch(() => {
            this.logger.warn('Local AI Guard timer callback failed', { reason: 'callback-error' });
          });
        }
      } catch {
        this.logger.warn('Local AI Guard timer callback failed', { reason: 'callback-error' });
      }
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, Math.round(delayMs))));
    this.scheduled.set(key, { handle, token });
  }

  private cancelTarget(targetId: string): void {
    this.pauseExpiries.cancel(targetId);
    this.cancelTimer(checkKey(targetId, 'lightweight'));
    this.cancelTimer(checkKey(targetId, 'functional'));
    this.cancelTimer(deferredKey(checkKey(targetId, 'functional')));
    const deferred = this.deferredChecks.get(checkKey(targetId, 'functional'));
    if (deferred) {
      this.deferredChecks.delete(checkKey(targetId, 'functional'));
      deferred.reject(new Error('Local AI target is not available for health checks'));
    }
    for (const kind of ['lightweight', 'functional'] as const) {
      const key = checkKey(targetId, kind);
      const replacement = this.replacementChecks.get(key);
      if (!replacement) continue;
      this.replacementChecks.delete(key);
      replacement.reject(new Error('Local AI target is not available for health checks'));
    }
  }

  private invalidateTarget(targetId: string): void {
    this.targetRevisions.set(targetId, (this.targetRevisions.get(targetId) ?? 0) + 1);
  }

  private cancelTimer(key: string): void {
    const scheduled = this.scheduled.get(key);
    if (!scheduled) return;
    this.timers.cancel(scheduled.handle);
    this.scheduled.delete(key);
  }

  private currentTimestamp(): number {
    const now = this.now();
    return Number.isSafeInteger(now) && now >= 0 ? now : 0;
  }

  private notify(status: LocalAiTargetStatus): void {
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        this.logger.warn('Local AI Guard status listener failed', { reason: 'listener-error' });
      }
    }
  }
}
