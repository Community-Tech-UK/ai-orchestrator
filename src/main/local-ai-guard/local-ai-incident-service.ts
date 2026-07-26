import { createHash, randomUUID } from 'node:crypto';
import type {
  LocalAiFailureCode,
  LocalAiHealthLayer,
  LocalAiHealthTransition,
  LocalAiIncident,
  LocalAiProbeResult,
  LocalAiRoutingEvent,
} from '../../shared/types/local-ai-guard.types';
import type {
  LocalAiIncidentNotificationKind,
  LocalAiIncidentNotificationTransition,
  LocalAiNotificationEndpointIdentity,
  LocalAiNotificationEndpointIdentityResolver,
  NotificationUrgency,
} from '../../shared/types/notification.types';
import { LocalAiHealthTransitionSchema } from '../../shared/validation/local-ai-guard.schemas';
import { getLogger } from '../logging/logger';
import type { NotificationService } from '../notifications/notification-service';
import {
  type LocalAiHealthRepository,
  type LocalAiNotificationClaim,
  type LocalAiNotificationReference,
} from './local-ai-health-repository';

export interface LocalAiIncidentServiceOptions {
  resolveTargetIdentity: LocalAiNotificationEndpointIdentityResolver;
  logger?: LocalAiIncidentServiceLogger;
  now?: () => number;
  createId?: () => string;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
}

export interface LocalAiIncidentServiceLogger {
  warn(message: string, data?: Record<string, unknown>): void;
}

type FailureFamily = 'worker' | 'endpoint' | 'model' | 'inference' | 'effectiveness';
type OutboxDeliveryResult = 'processed' | 'not-claimed' | 'claim-error';

const OUTBOX_LEASE_MS = 30_000;
const OUTBOX_RETRY_BACKOFF_MS = 30_000;
const OUTBOX_BATCH_SIZE = 100;
const OUTBOX_MAX_BATCHES_PER_FLUSH = 100;
const OUTBOX_CONTINUATION_DELAY_MS = 1;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const CRITICAL_FAILURE_CODES = new Set<LocalAiFailureCode>([
  'worker-offline',
  'authentication-error',
  'missing-required-model',
]);
const FAILURE_FAMILIES: Record<LocalAiFailureCode, FailureFamily> = {
  'worker-offline': 'worker',
  'worker-degraded': 'worker',
  'rpc-unavailable': 'worker',
  'endpoint-not-advertised': 'endpoint',
  'configuration-drift': 'endpoint',
  'connection-refused': 'endpoint',
  'endpoint-timeout': 'endpoint',
  'protocol-error': 'endpoint',
  'authentication-error': 'endpoint',
  'missing-required-model': 'model',
  'insufficient-context': 'model',
  'inference-timeout': 'inference',
  'malformed-inference-output': 'inference',
  'latency-exceeded': 'effectiveness',
  flapping: 'effectiveness',
  'monitor-error': 'effectiveness',
};
const LAYER_ORDER: Record<LocalAiHealthLayer, number> = {
  worker: 0,
  endpoint: 1,
  model: 2,
  inference: 3,
  effectiveness: 4,
};

export class LocalAiIncidentService {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly resolveTargetIdentity: LocalAiNotificationEndpointIdentityResolver;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelScheduled: (handle: unknown) => void;
  private readonly logger: LocalAiIncidentServiceLogger;
  private scheduledDrain?: { handle: unknown; wakeAt: number };
  private flushing = false;
  private disposed = false;

  constructor(
    private readonly repository: LocalAiHealthRepository,
    private readonly notifications: NotificationService,
    options: LocalAiIncidentServiceOptions,
  ) {
    this.resolveTargetIdentity = options.resolveTargetIdentity;
    this.logger = options.logger ?? getLogger('LocalAiIncidentService');
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelScheduled = options.cancelScheduled
      ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.flushOutbox();
  }

  handleTransition(input: LocalAiHealthTransition): LocalAiIncident | undefined {
    if (this.disposed) return undefined;
    const transition = coherentTransition(input);
    if (!transition || transition.incidentAction === 'none') return undefined;
    if (transition.incidentAction === 'resolve') return this.resolveTargetIncidents(transition);
    const failure = primaryFailure(transition);
    if (!failure) return undefined;
    const active = this.activeIncidents(transition.current.targetId);
    const existing = active.find((incident) =>
      FAILURE_FAMILIES[incident.failureCode] === FAILURE_FAMILIES[failure.failureCode]);
    const at = monotonicTimestamp(
      transition.current.checkedAt,
      this.now(),
      existing?.updatedAt,
      existing?.openedAt,
    );
    const incident = this.repository.upsertIncident({
      kind: 'open-or-update',
      incident: {
        id: existing?.id ?? this.createId(),
        targetId: transition.current.targetId,
        state: 'open',
        severity: worseSeverity(
          existing?.severity ?? 'warning',
          CRITICAL_FAILURE_CODES.has(failure.failureCode) ? 'critical' : 'warning',
        ),
        failureCode: existing?.failureCode ?? failure.failureCode,
        affectedLayers: orderedUnion(
          existing?.affectedLayers ?? [],
          failure.probes.map((probe) => probe.layer),
          (layer) => LAYER_ORDER[layer],
        ),
        affectedRoles: orderedUnion(
          existing?.affectedRoles ?? [],
          failure.probes.flatMap((probe) => probe.affectedRoles),
          (role) => role,
        ),
        openedAt: existing?.openedAt ?? at,
        updatedAt: at,
        fallbackCount: existing?.fallbackCount ?? 0,
        knownCostUsd: existing?.knownCostUsd ?? 0,
        estimatedCostUsd: existing?.estimatedCostUsd ?? 0,
      },
    });
    this.flushOutbox();
    return incident;
  }

  recordFallback(event: LocalAiRoutingEvent): LocalAiIncident | undefined {
    if (this.disposed) return undefined;
    if (event.actualRoute === 'local') return undefined;
    const result = this.repository.accountRoutingEvent(event, monotonicTimestamp(this.now()));
    if (!result) return undefined;
    this.flushOutbox();
    return result.incident;
  }

  acknowledge(incidentId: string): LocalAiIncident | undefined {
    if (this.disposed) return undefined;
    const incident = this.activeIncidents().find((candidate) => candidate.id === incidentId);
    if (!incident || incident.state !== 'open') return undefined;
    const at = monotonicTimestamp(this.now(), incident.openedAt, incident.updatedAt);
    return this.repository.upsertIncident({ kind: 'acknowledge', incidentId, at });
  }

  private resolveTargetIncidents(transition: LocalAiHealthTransition): LocalAiIncident | undefined {
    const incidents = this.activeIncidents(transition.current.targetId);
    let firstResolved: LocalAiIncident | undefined;
    for (const incident of incidents) {
      const at = monotonicTimestamp(
        transition.current.checkedAt,
        this.now(),
        incident.openedAt,
        incident.updatedAt,
      );
      const resolved = this.repository.upsertIncident({ kind: 'resolve', incidentId: incident.id, at });
      firstResolved ??= resolved;
    }
    if (firstResolved) this.flushOutbox();
    return firstResolved;
  }

  private activeIncidents(targetId?: string): LocalAiIncident[] {
    const states = ['open', 'acknowledged'] as const;
    const incidents = states.flatMap((state) =>
      this.repository.listIncidents({ ...(targetId ? { targetId } : {}), state, limit: 1_000 }));
    return [...new Map(incidents.map((incident) => [incident.id, incident])).values()]
      .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelScheduledDrain();
  }

  private flushOutbox(): void {
    if (this.disposed || this.flushing) return;
    this.cancelScheduledDrain();
    this.flushing = true;
    const at = monotonicTimestamp(this.now());
    let cappedWithProgress = false;
    let claimError = false;
    try {
      drain: for (let batch = 0; batch < OUTBOX_MAX_BATCHES_PER_FLUSH; batch += 1) {
        const references = this.repository.listRetryableNotifications(
          at,
          OUTBOX_LEASE_MS,
          OUTBOX_BATCH_SIZE,
        );
        if (!references.length) break;
        let claimed = 0;
        for (const reference of references) {
          const result = this.deliverOutboxReference(reference, at);
          if (result === 'claim-error') {
            claimError = true;
            break drain;
          }
          if (result === 'processed') claimed += 1;
        }
        if (claimed === 0) break;
        if (batch === OUTBOX_MAX_BATCHES_PER_FLUSH - 1) cappedWithProgress = true;
      }
    } finally {
      this.flushing = false;
    }
    if (this.disposed) return;
    if (claimError) {
      const retryBase = monotonicTimestamp(this.now());
      this.scheduleDrainAt(addTimestamp(retryBase, OUTBOX_RETRY_BACKOFF_MS), retryBase);
      return;
    }
    if (cappedWithProgress) {
      this.scheduleDrainAt(addTimestamp(at, OUTBOX_CONTINUATION_DELAY_MS));
      return;
    }
    const dueAt = this.repository.nextOutboxDueAt(at, OUTBOX_LEASE_MS);
    if (dueAt !== undefined) this.scheduleDrainAt(dueAt);
  }

  private deliverOutboxReference(
    reference: LocalAiNotificationReference,
    at: number,
  ): OutboxDeliveryResult {
    const claimToken = randomUUID();
    let claim: LocalAiNotificationClaim | undefined;
    try {
      claim = this.repository.claimNotification(
        reference,
        claimToken,
        at,
        OUTBOX_LEASE_MS,
      );
    } catch {
      this.logger.warn('Local AI Guard notification claim failed; retrying later', {
        notificationIdHash: hashedTargetSuffix(reference.entityId),
        entity: reference.entity,
        transitionKind: reference.transitionKind,
        reason: 'repository-claim-error',
      });
      return 'claim-error';
    }
    if (!claim) return 'not-claimed';
    try {
      this.notifyClaim(claim);
      // notify() success means the in-app record was accepted. Its desktop projection remains best effort.
      this.repository.markNotificationDelivered(reference, claimToken, at);
    } catch {
      const retryBase = monotonicTimestamp(this.now());
      const retryAt = addTimestamp(retryBase, OUTBOX_RETRY_BACKOFF_MS);
      this.repository.markNotificationFailed(
        reference,
        claimToken,
        retryAt,
      );
      this.scheduleDrainAt(retryAt, retryBase);
    }
    return 'processed';
  }

  private notifyClaim(claim: LocalAiNotificationClaim): void {
    const transition = claim.reference.transitionKind;
    const title = transition === 'fallback-possible'
      ? 'Local AI paid fallback may be needed'
      : transition === 'budget-critical'
        ? 'Local AI fallback budget reached'
        : transition === 'recovered'
          ? 'Local AI endpoint recovered'
          : 'Local AI paid fallback used';
    this.sendNotification(
      claim.incident,
      transition,
      transition === 'fallback-possible' || transition === 'recovered' ? 'normal' : 'critical',
      title,
      claim.reference.entity === 'routing-event' ? claim.reference.entityId : undefined,
    );
  }

  private scheduleDrainAt(dueAt: number, sampledNow?: number): void {
    if (this.disposed) return;
    const now = sampledNow ?? monotonicTimestamp(this.now());
    const delayMs = dueAt <= now
      ? OUTBOX_CONTINUATION_DELAY_MS
      : Math.max(
        OUTBOX_CONTINUATION_DELAY_MS,
        Math.min(MAX_TIMER_DELAY_MS, dueAt - now),
      );
    const wakeAt = addTimestamp(now, delayMs);
    if (this.scheduledDrain && this.scheduledDrain.wakeAt <= wakeAt) return;
    this.cancelScheduledDrain();
    const handle = this.schedule(() => {
      if (this.disposed || this.scheduledDrain?.handle !== handle) return;
      this.scheduledDrain = undefined;
      this.flushOutbox();
    }, delayMs);
    this.scheduledDrain = { handle, wakeAt };
  }

  private cancelScheduledDrain(): void {
    if (!this.scheduledDrain) return;
    this.cancelScheduled(this.scheduledDrain.handle);
    this.scheduledDrain = undefined;
  }

  private sendNotification(
    incident: LocalAiIncident,
    transitionKind: LocalAiIncidentNotificationTransition,
    urgency: NotificationUrgency,
    title: string,
    eventId?: string,
  ): void {
    const kind: LocalAiIncidentNotificationKind = `local-ai-${transitionKind}`;
    const layers = incident.affectedLayers.length ? incident.affectedLayers.join(', ') : 'unknown';
    const roles = incident.affectedRoles.length ? incident.affectedRoles.join(', ') : 'none';
    const duration = transitionKind === 'recovered' && incident.resolvedAt !== undefined
      ? ` Duration: ${formatDuration(incident.resolvedAt - incident.openedAt)}.`
      : '';
    this.notifications.notify({
      kind,
      title,
      body:
        `Endpoint: ${this.endpointLabel(incident.targetId)}. Failed layer: ${layers}. ` +
        `Affected slots: ${roles}. Fallback impact: ${fallbackImpact(incident)}.${duration}`,
      urgency,
      fingerprintFields: {
        incidentId: incident.id,
        transitionKind,
        ...(eventId ? { eventId } : {}),
      },
    });
  }

  private endpointLabel(targetId: string): string {
    let identity: LocalAiNotificationEndpointIdentity | undefined;
    try {
      identity = this.resolveTargetIdentity(targetId);
    } catch {
      // Resolver errors may contain target configuration or credentials; fall back without logging.
    }
    const provider = identity?.provider === 'ollama'
      ? 'Ollama'
      : identity?.provider === 'openai-compatible'
        ? 'OpenAI-compatible'
        : undefined;
    const location = identity?.location === 'worker'
      ? 'Worker'
      : identity?.location === 'coordinator'
        ? 'Coordinator'
        : undefined;
    const stableTargetId = typeof identity?.stableTargetId === 'string'
      ? identity.stableTargetId
      : targetId;
    const suffix = hashedTargetSuffix(stableTargetId);
    return provider && location
      ? `${location} ${provider} endpoint #${suffix}`
      : `Local AI endpoint #${suffix}`;
  }
}

function coherentTransition(input: LocalAiHealthTransition): LocalAiHealthTransition | undefined {
  const parsed = LocalAiHealthTransitionSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const transition = parsed.data;
  if (transition.previous && transition.previous.targetId !== transition.current.targetId) return undefined;
  if (!coherentStatusLayers(transition.current)
    || (transition.previous && !coherentStatusLayers(transition.previous))) return undefined;
  const probes = Object.values(transition.current.layers)
    .filter((probe): probe is LocalAiProbeResult => probe !== undefined);
  if (transition.incidentAction === 'none') return transition;
  if (transition.incidentAction === 'resolve') {
    const recoveredState = transition.current.state === 'healthy' || transition.current.state === 'degraded';
    const requiredHealthy = probes.every((probe) => !probe.required || probe.ok);
    return recoveredState
      && transition.current.incidentOpen === false
      && transition.current.consecutiveSuccesses >= 2
      && probes.length > 0
      && probes.some((probe) => probe.required && probe.ok)
      && requiredHealthy
      ? transition
      : undefined;
  }
  return transition.current.state === 'unavailable'
    && transition.current.incidentOpen === true
    && probes.some((probe) => !probe.ok)
    ? transition
    : undefined;
}

function coherentStatusLayers(status: LocalAiHealthTransition['current']): boolean {
  return Object.entries(status.layers).every(([layer, probe]) =>
    probe !== undefined && probe.layer === layer && probe.targetId === status.targetId);
}

function primaryFailure(transition: LocalAiHealthTransition): {
  failureCode: LocalAiFailureCode;
  probes: LocalAiProbeResult[];
} | undefined {
  const failed = Object.values(transition.current.layers)
    .filter((probe): probe is LocalAiProbeResult => probe !== undefined && !probe.ok)
    .sort((left, right) =>
      Number(right.required) - Number(left.required)
      || LAYER_ORDER[left.layer] - LAYER_ORDER[right.layer]
      || right.checkedAt - left.checkedAt);
  if (transition.current.flapping) {
    return {
      failureCode: 'flapping',
      probes: failed.length ? failed : [syntheticFlappingProbe(transition)],
    };
  }
  const first = failed[0];
  if (!first) return undefined;
  const failureCode = first.failureCode ?? 'monitor-error';
  const family = FAILURE_FAMILIES[failureCode];
  return {
    failureCode,
    probes: failed.filter((probe) =>
      FAILURE_FAMILIES[probe.failureCode ?? 'monitor-error'] === family),
  };
}

function syntheticFlappingProbe(transition: LocalAiHealthTransition): LocalAiProbeResult {
  return {
    targetId: transition.current.targetId,
    layer: 'effectiveness',
    checkType: 'functional',
    ok: false,
    required: true,
    affectedRoles: transition.previous?.routableRoles ?? [],
    checkedAt: transition.current.checkedAt,
    durationMs: 0,
    failureCode: 'flapping',
    evidence: {},
  };
}

function hashedTargetSuffix(stableTargetId: string): string {
  return createHash('sha256').update(stableTargetId).digest('hex').slice(0, 12);
}

function monotonicTimestamp(...values: (number | undefined)[]): number {
  return Math.max(0, ...values.map((value) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0));
}

function addTimestamp(timestamp: number, delayMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, timestamp + delayMs);
}

function orderedUnion<T>(
  existing: readonly T[],
  incoming: readonly T[],
  order: (value: T) => number | string,
): T[] {
  return [...new Set([...existing, ...incoming])].sort((left, right) => {
    const leftOrder = order(left);
    const rightOrder = order(right);
    return typeof leftOrder === 'number' && typeof rightOrder === 'number'
      ? leftOrder - rightOrder
      : String(leftOrder).localeCompare(String(rightOrder));
  });
}

function worseSeverity(
  left: LocalAiIncident['severity'],
  right: LocalAiIncident['severity'],
): LocalAiIncident['severity'] {
  return left === 'critical' || right === 'critical' ? 'critical' : 'warning';
}

function fallbackImpact(incident: LocalAiIncident): string {
  const dispatches = `${incident.fallbackCount} paid dispatch${incident.fallbackCount === 1 ? '' : 'es'}`;
  return `${dispatches}; ${formatCost(incident.knownCostUsd)} known; ${formatCost(incident.estimatedCostUsd)} estimated`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

function formatDuration(durationMs: number): string {
  const bounded = Math.max(0, durationMs);
  if (bounded < 60_000) return `${Math.floor(bounded / 1_000)}s`;
  if (bounded < 3_600_000) return `${Math.floor(bounded / 60_000)}m`;
  return `${Math.floor(bounded / 3_600_000)}h`;
}
