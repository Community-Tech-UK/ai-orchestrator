import { randomUUID } from 'node:crypto';
import { computeProviderTokenCost } from '../../shared/data/model-pricing';
import type { AuxiliaryLlmSlot } from '../../shared/types/auxiliary-llm.types';
import type {
  LocalAiFallbackPolicy,
  LocalAiFallbackRequest,
  LocalAiFallbackRequestInput,
  LocalAiFallbackResolution,
  LocalAiFallbackVerdict,
  LocalAiIncident,
  LocalAiLocalRouteVerdict,
  LocalAiRoutingDecisionReason,
  LocalAiRoutingEvent,
  LocalAiTarget,
  LocalAiTargetStatus,
} from '../../shared/types/local-ai-guard.types';
import type { AppSettings } from '../../shared/types/settings.types';
import type { LocalAiHealthRepository } from './local-ai-health-repository';
import type { LocalAiHealthScheduler } from './local-ai-health-scheduler';
import type { LocalAiIncidentService } from './local-ai-incident-service';
import type { LocalAiTargetRepository } from './local-ai-target-repository';
import type { LocalAiFallbackApprovalCreation } from './local-ai-fallback-approval-service';
import type { LocalAiFallbackReservationLimits } from './local-ai-fallback-store';

interface RoutingApprovalService {
  request(
    input: LocalAiFallbackRequestInput,
    creation?: LocalAiFallbackApprovalCreation,
  ): Promise<LocalAiFallbackResolution>;
  listPending?(): LocalAiFallbackRequest[];
  hasIncidentAllowance?(incidentId: string): boolean;
}

type GuardSettings = Pick<
  AppSettings,
  | 'localAiGuardDefaultFallbackPolicy'
  | 'localAiGuardDailyFallbackBudgetUsd'
  | 'localAiGuardConfirmAboveInputTokens'
>;

export interface LocalAiRoutingGuardDependencies {
  targets: Pick<LocalAiTargetRepository, 'get'>;
  scheduler: Pick<LocalAiHealthScheduler, 'ensureFresh' | 'getStatus'>;
  health: Pick<
    LocalAiHealthRepository,
    | 'reserveFallbackRoutingEvent'
    | 'getRoutingEvent'
    | 'markFallbackDispatched'
    | 'listIncidents'
  >;
  approvals: RoutingApprovalService;
  incidents?: Pick<LocalAiIncidentService, 'recordFallback'>;
  settings: () => GuardSettings;
  resolveFallbackModel?: (
    slot: AuxiliaryLlmSlot,
  ) => { provider: string; model: string } | undefined;
  notifyFallback?: (event: LocalAiRoutingEvent) => void;
  now?: () => number;
  createId?: () => string;
}

export interface LocalAiFallbackAuthorizationInput {
  slot: AuxiliaryLlmSlot;
  intendedTargetId?: string;
  reason: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  slotAllowsFrontier: boolean;
}

interface PolicyDecision {
  policy: LocalAiFallbackPolicy;
  reason: LocalAiRoutingDecisionReason;
  incident?: LocalAiIncident;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

export class LocalAiRoutingGuard {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly dispatched = new Set<string>();

  constructor(private readonly dependencies: LocalAiRoutingGuardDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.createId = dependencies.createId ?? randomUUID;
  }

  async evaluateLocalTarget(input: {
    targetId: string;
    slot: AuxiliaryLlmSlot;
  }): Promise<LocalAiLocalRouteVerdict> {
    const target = this.dependencies.targets.get(input.targetId);
    if (!target || target.lifecycle === 'unmanaged') {
      return {
        eligible: true,
        ...(target ? { targetId: target.id } : {}),
        reason: 'unmanaged-compatibility',
      };
    }
    if (target.lifecycle !== 'enrolled') {
      return { eligible: false, targetId: target.id, reason: `lifecycle-${target.lifecycle}` };
    }

    const current = this.dependencies.scheduler.getStatus(target.id);
    if (current?.state === 'unavailable' || current?.state === 'paused') {
      return this.ineligible(target, current, `health-${current.state}`);
    }

    let status: LocalAiTargetStatus;
    try {
      status = await this.dependencies.scheduler.ensureFresh(target.id, input.slot);
    } catch {
      return this.ineligible(target, current, 'freshness-check-failed');
    }
    if (status.state !== 'healthy' && status.state !== 'degraded') {
      return this.ineligible(target, status, `health-${status.state}`);
    }
    if (!status.routableRoles.includes(input.slot)) {
      return this.ineligible(target, status, 'role-not-routable');
    }
    return {
      eligible: true,
      targetId: target.id,
      status,
      reason: 'eligible-current-health',
    };
  }

  async authorizeFallback(
    input: LocalAiFallbackAuthorizationInput,
  ): Promise<LocalAiFallbackVerdict> {
    validateTokenEstimate(input.estimatedInputTokens, 'estimatedInputTokens');
    validateTokenEstimate(input.estimatedOutputTokens, 'estimatedOutputTokens');
    const at = this.currentTimestamp();
    const rawTarget = input.intendedTargetId
      ? this.dependencies.targets.get(input.intendedTargetId)
      : undefined;
    const target = rawTarget
      && rawTarget.lifecycle !== 'unmanaged'
      && rawTarget.lifecycle !== 'retired'
      ? rawTarget
      : undefined;
    const fallbackModel = this.dependencies.resolveFallbackModel?.(input.slot);
    const estimate = fallbackModel
      ? computeProviderTokenCost(fallbackModel.provider, fallbackModel.model, {
          inputTokens: input.estimatedInputTokens,
          outputTokens: input.estimatedOutputTokens,
        })
      : undefined;
    const currentSettings = this.dependencies.settings();
    const decision = input.slotAllowsFrontier
      ? this.resolvePolicy(
          target,
          input.slot,
          input.estimatedInputTokens,
          currentSettings,
        )
      : { policy: 'block-paid-fallback' as const, reason: 'policy' as const };
    const proposedEvent = this.createRoutingEvent({
      input,
      target,
      decision,
      estimate,
      fallbackModel,
      at,
    });
    const reservationLimits: LocalAiFallbackReservationLimits = {
      at,
      dayStart: utcDayStart(at),
      globalDailyBudgetUsd: currentSettings.localAiGuardDailyFallbackBudgetUsd,
      targetDailyBudgetUsd: target?.dailyFallbackBudgetUsd,
      incidentBudgetUsd: decision.incident ? target?.incidentFallbackBudgetUsd : undefined,
    };
    if (proposedEvent.policy === 'require-confirmation') {
      return this.confirm(proposedEvent, decision.incident, reservationLimits);
    }
    const event = this.dependencies.health.reserveFallbackRoutingEvent(
      proposedEvent,
      reservationLimits,
    );

    switch (event.policy) {
      case 'allow-silently':
        return this.allowedVerdict(event);
      case 'notify-and-allow':
        this.notify(event);
        return this.allowedVerdict(event);
      case 'defer-locally':
        return this.staticVerdict(event, false, 'deferred');
      case 'block-paid-fallback':
        return this.staticVerdict(event, false, 'blocked');
      case 'require-confirmation':
        throw new Error('Local AI confirmation event bypassed the atomic approval boundary');
    }
  }

  markFallbackDispatched(eventId: string): void {
    if (this.dispatched.has(eventId)) return;
    const completed = this.dependencies.health.markFallbackDispatched(
      eventId,
      this.currentTimestamp(),
    );
    if (!completed) return;
    this.dependencies.incidents?.recordFallback(completed);
    this.dispatched.add(eventId);
  }

  private resolvePolicy(
    target: LocalAiTarget | undefined,
    slot: AuxiliaryLlmSlot,
    estimatedInputTokens: number,
    settings: GuardSettings,
  ): PolicyDecision {
    const incident = target ? this.activeIncident(target.id) : undefined;
    if (thresholdExceeded(target?.confirmAboveInputTokens, estimatedInputTokens)
      || thresholdExceeded(settings.localAiGuardConfirmAboveInputTokens, estimatedInputTokens)) {
      return { policy: 'require-confirmation', reason: 'confirmation', ...(incident ? { incident } : {}) };
    }
    const policy = target?.slotFallbackPolicies[slot]
      ?? target?.fallbackPolicy
      ?? settings.localAiGuardDefaultFallbackPolicy;
    if (policy === 'require-confirmation'
      && incident
      && this.dependencies.approvals.hasIncidentAllowance?.(incident.id)) {
      return { policy: 'allow-silently', reason: 'confirmation', incident };
    }
    return {
      policy,
      reason: policy === 'require-confirmation' ? 'confirmation' : 'policy',
      ...(incident ? { incident } : {}),
    };
  }

  private activeIncident(targetId: string): LocalAiIncident | undefined {
    return (['open', 'acknowledged'] as const).flatMap((state) =>
      this.dependencies.health.listIncidents({ targetId, state, limit: 1_000 }))
      .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
      .at(0);
  }

  private createRoutingEvent(input: {
    input: LocalAiFallbackAuthorizationInput;
    target?: LocalAiTarget;
    decision: PolicyDecision;
    estimate?: number;
    fallbackModel?: { provider: string; model: string };
    at: number;
  }): LocalAiRoutingEvent {
    const disposition = policyDisposition(input.decision.policy);
    return {
      id: this.createId(),
      ...(input.target ? { targetId: input.target.id } : {}),
      ...(input.decision.incident ? { incidentId: input.decision.incident.id } : {}),
      slot: input.input.slot,
      intendedRoute: 'local',
      actualRoute: disposition === 'allowed'
        ? 'frontier'
        : disposition === 'blocked'
          ? 'blocked'
          : 'deferred',
      policy: input.decision.policy,
      disposition,
      decisionReason: input.decision.reason,
      ...(input.fallbackModel ? {
        provider: input.fallbackModel.provider,
        model: input.fallbackModel.model,
      } : {}),
      inputTokens: input.input.estimatedInputTokens,
      outputTokens: input.input.estimatedOutputTokens,
      ...(input.estimate === undefined ? {} : { estimatedCostUsd: input.estimate }),
      createdAt: input.at,
    };
  }

  private async confirm(
    event: LocalAiRoutingEvent,
    incident: LocalAiIncident | undefined,
    reservationLimits: LocalAiFallbackReservationLimits,
  ): Promise<LocalAiFallbackVerdict> {
    const expiresAt = Math.min(Number.MAX_SAFE_INTEGER, event.createdAt + 5 * 60_000);
    const pending = this.dependencies.approvals.request(
      {
        routingEventId: event.id,
        ...(incident ? { incidentId: incident.id } : {}),
        slot: event.slot,
        estimatedInputTokens: event.inputTokens,
        ...(event.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: event.estimatedCostUsd }),
        expiresAt,
      },
      { routingEvent: event, reservationLimits },
    );
    const fallbackRequestId = this.dependencies.approvals.listPending?.()
      .find((request) => request.routingEventId === event.id)?.id;
    await pending;
    const resolvedEvent = this.dependencies.health.getRoutingEvent(event.id);
    if (!resolvedEvent || !['allowed', 'deferred', 'blocked'].includes(resolvedEvent.disposition)) {
      throw new Error(`Local AI fallback request did not durably resolve: ${event.id}`);
    }
    const disposition = resolvedEvent.disposition as LocalAiFallbackVerdict['disposition'];
    const allowed = disposition === 'allowed';
    return {
      allowed,
      disposition,
      policy: resolvedEvent.policy,
      routingEventId: event.id,
      ...(fallbackRequestId ? { fallbackRequestId } : {}),
    };
  }

  private allowedVerdict(event: LocalAiRoutingEvent): LocalAiFallbackVerdict {
    return this.staticVerdict(event, true, 'allowed');
  }

  private staticVerdict(
    event: LocalAiRoutingEvent,
    allowed: boolean,
    disposition: LocalAiFallbackVerdict['disposition'],
  ): LocalAiFallbackVerdict {
    return {
      allowed,
      disposition,
      policy: event.policy,
      routingEventId: event.id,
    };
  }

  private notify(event: LocalAiRoutingEvent): void {
    try {
      this.dependencies.notifyFallback?.(event);
    } catch {
      // Authorization remains authoritative; notification delivery is fail-soft.
    }
  }

  private ineligible(
    target: LocalAiTarget,
    status: LocalAiTargetStatus | undefined,
    reason: string,
  ): LocalAiLocalRouteVerdict {
    return {
      eligible: false,
      targetId: target.id,
      ...(status ? { status } : {}),
      reason,
    };
  }

  private currentTimestamp(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError('Local AI routing guard clock returned an invalid timestamp');
    }
    return now;
  }
}

function policyDisposition(policy: LocalAiFallbackPolicy): LocalAiRoutingEvent['disposition'] {
  switch (policy) {
    case 'allow-silently':
    case 'notify-and-allow':
      return 'allowed';
    case 'require-confirmation':
      return 'pending-confirmation';
    case 'defer-locally':
      return 'deferred';
    case 'block-paid-fallback':
      return 'blocked';
  }
}

function thresholdExceeded(threshold: number | null | undefined, estimated: number): boolean {
  return threshold !== null && threshold !== undefined && estimated > threshold;
}

function utcDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Number.isSafeInteger(start) ? start : Math.max(0, timestamp - DAY_MS);
}

function validateTokenEstimate(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Local AI ${field} must be a non-negative safe integer`);
  }
}
