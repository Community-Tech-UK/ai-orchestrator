import { randomUUID } from 'node:crypto';
import { computeProviderTokenCost } from '../../shared/data/model-pricing';
import { getReservedAuxiliarySpendToday } from '../core/system/cost-attribution';
import { getLogger } from '../logging/logger';
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
import { estimateFallbackCallUsd, resolveHelperDailyBudgetUsd,
  UNKNOWN_FALLBACK_COST_USD, type FallbackRung } from './helper-daily-budget';

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
> & Partial<Pick<AppSettings, 'auxiliaryLlmDailySpendCapUsd'>>;

export interface LocalAiRoutingGuardDependencies {
  targets: Pick<LocalAiTargetRepository, 'get'>;
  scheduler: Pick<LocalAiHealthScheduler, 'ensureFresh' | 'getStatus'>;
  health: Pick<
    LocalAiHealthRepository,
    | 'appendRoutingEvent'
    | 'reserveFallbackRoutingEvent'
    | 'getRoutingEvent'
    | 'markFallbackDispatched'
    | 'listIncidents'
  > & { getFallbackSpend?: LocalAiHealthRepository['getFallbackSpend'] };
  approvals: RoutingApprovalService;
  incidents?: Pick<LocalAiIncidentService, 'recordFallback'>;
  settings: () => GuardSettings;
  resolveFallbackModel?: (
    slot: AuxiliaryLlmSlot,
  ) => FallbackRung | undefined;
  notifyFallback?: (event: LocalAiRoutingEvent) => void;
  notifyHelperBudgetExceeded?: () => void;
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
  intendedProvider?: string;
  intendedModel?: string;
  /**
   * Set only by an explicit user action such as "Compact now" (Step 7 item 5:
   * not a helper call, not capped). It skips the shared daily helper limit. The
   * event is still stored with its estimate, so the day's spend stays truthful.
   * The fallback policy, the slot's own frontier setting and any per-target or
   * incident ceiling still apply.
   */
  userInitiated?: boolean;
}

export interface LocalAiLocalCompletionInput {
  slot: AuxiliaryLlmSlot;
  /** Managed target the call ran on, when its endpoint is enrolled. */
  targetId?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

interface PolicyDecision {
  policy: LocalAiFallbackPolicy;
  reason: LocalAiRoutingDecisionReason;
  incident?: LocalAiIncident;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const logger = getLogger('LocalAiRoutingGuard');

export class LocalAiRoutingGuard {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly dispatched = new Set<string>();
  private spendReadFailureLogged = false;

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
    const fallbackModel = input.intendedProvider && input.intendedModel
      ? { provider: input.intendedProvider, model: input.intendedModel }
      : this.dependencies.resolveFallbackModel?.(input.slot);
    const estimate = estimateFallbackCallUsd(fallbackModel, {
      inputTokens: input.estimatedInputTokens,
      outputTokens: input.estimatedOutputTokens,
    });
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
      // Separate stores are not read atomically; one concurrent call can overshoot.
      globalDailyBudgetUsd: input.userInitiated ? null : sharedFallbackLimit(currentSettings),
      targetDailyBudgetUsd: target?.dailyFallbackBudgetUsd,
      incidentBudgetUsd: decision.incident ? target?.incidentFallbackBudgetUsd : undefined,
    };
    if (proposedEvent.policy === 'require-confirmation') {
      return this.confirm(proposedEvent, decision.incident, reservationLimits, input.userInitiated === true);
    }
    const event = this.dependencies.health.reserveFallbackRoutingEvent(
      proposedEvent,
      reservationLimits,
    );

    if (proposedEvent.disposition === 'allowed' && !input.userInitiated) this.notifyGlobalBudgetRefusal(event);
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

  /**
   * Record an auxiliary call that completed on a local model. Fallbacks have
   * always been written here, but local completions never were, so the
   * effectiveness summary reported 0% local while ~95% of calls ran locally.
   * Disposition `not-needed` keeps these rows out of fallback spend, which sums
   * `allowed` rows; `estimatedCostUsd` is the frontier cost avoided.
   */
  recordLocalCompletion(input: LocalAiLocalCompletionInput): void {
    validateTokenEstimate(input.inputTokens, 'inputTokens');
    validateTokenEstimate(input.outputTokens, 'outputTokens');
    const at = this.currentTimestamp();
    const rawTarget = input.targetId ? this.dependencies.targets.get(input.targetId) : undefined;
    const target = rawTarget && rawTarget.lifecycle !== 'unmanaged' && rawTarget.lifecycle !== 'retired'
      ? rawTarget
      : undefined;
    const fallbackModel = this.dependencies.resolveFallbackModel?.(input.slot);
    const avoided = fallbackModel
      ? computeProviderTokenCost(fallbackModel.provider, fallbackModel.model, {
          inputTokens: input.inputTokens, outputTokens: input.outputTokens,
        })
      : undefined;
    this.dependencies.health.appendRoutingEvent({
      id: this.createId(),
      ...(target ? { targetId: target.id } : {}),
      slot: input.slot,
      intendedRoute: 'local',
      actualRoute: 'local',
      policy: target?.slotFallbackPolicies[input.slot]
        ?? target?.fallbackPolicy
        ?? this.dependencies.settings().localAiGuardDefaultFallbackPolicy,
      disposition: 'not-needed',
      decisionReason: 'health',
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      ...(avoided === undefined ? {} : { estimatedCostUsd: avoided }),
      createdAt: at,
      completedAt: at,
    });
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

  /**
   * Paid fallback spend since UTC midnight, for the shared helper limit. A failed
   * or non-finite ledger read is unknown spend, not zero spend: it returns
   * `Infinity`, so the caller's remaining cap collapses to nothing and the paid
   * call is refused (Step 7: unknown must not look like headroom). Never throws.
   */
  fallbackSpendTodayUsd(): number {
    try {
      const now = this.currentTimestamp();
      const spend = this.dependencies.health.getFallbackSpend?.({
        since: utcDayStart(now), until: now,
      });
      if (!spend) return 0;
      const total = spend.knownCostUsd + spend.estimatedCostUsd
        + spend.unknownReservations * UNKNOWN_FALLBACK_COST_USD;
      if (Number.isFinite(total)) {
        this.spendReadFailureLogged = false;
        return total;
      }
      this.logSpendReadFailure(new Error('non-finite fallback spend total'));
      return Number.POSITIVE_INFINITY;
    } catch (err) {
      this.logSpendReadFailure(err);
      return Number.POSITIVE_INFINITY;
    }
  }

  private logSpendReadFailure(err: unknown): void {
    if (this.spendReadFailureLogged) return;
    this.spendReadFailureLogged = true;
    logger.warn('Fallback spend unreadable; treating today as over the helper limit', {
      error: err instanceof Error ? err.message : String(err),
    });
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
    userInitiated: boolean,
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
      { routingEvent: event, reservationLimits, userInitiated },
    );
    const fallbackRequestId = this.dependencies.approvals.listPending?.()
      .find((request) => request.routingEventId === event.id)?.id;
    await pending;
    const resolvedEvent = this.dependencies.health.getRoutingEvent(event.id);
    if (!resolvedEvent || !['allowed', 'deferred', 'blocked'].includes(resolvedEvent.disposition)) {
      throw new Error(`Local AI fallback request did not durably resolve: ${event.id}`);
    }
    if (!userInitiated) this.notifyGlobalBudgetRefusal(resolvedEvent);
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

  private notifyGlobalBudgetRefusal(event: LocalAiRoutingEvent): void {
    if (event.disposition !== 'blocked' || event.decisionReason !== 'daily-budget') return;
    // A target ceiling shares the stored reason. Verify the global ceiling too;
    // exclude this event so an approval reservation is never counted twice.
    try {
      // Unreadable cheap-cloud reservations refuse the call (the shared limit
      // collapses to zero) but are unknown spend, not proof the limit was reached.
      const reservedUsd = getReservedAuxiliarySpendToday();
      if (!Number.isFinite(reservedUsd)) return;
      const limit = sharedFallbackLimit(this.dependencies.settings(), reservedUsd);
      if (limit === null) return;
      const at = this.currentTimestamp();
      const spend = this.dependencies.health.getFallbackSpend?.({
        since: utcDayStart(at), until: at, excludeEventId: event.id,
      });
      if (spend && spend.knownCostUsd + spend.estimatedCostUsd
        + spend.unknownReservations * UNKNOWN_FALLBACK_COST_USD
        + (event.estimatedCostUsd ?? UNKNOWN_FALLBACK_COST_USD) > limit) {
        this.dependencies.notifyHelperBudgetExceeded?.();
      }
    } catch {
      // A status/notification failure cannot change a blocked authorization.
    }
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

/**
 * The paid-fallback share of the one helper limit: the limit minus today's
 * cheap-cloud reservations. Unreadable reservations arrive as `Infinity`
 * (unknown spend), which leaves nothing, so unknown never looks like headroom.
 */
function sharedFallbackLimit(
  settings: GuardSettings,
  reservedUsd: number = getReservedAuxiliarySpendToday(),
): number | null {
  const limit = resolveHelperDailyBudgetUsd(settings);
  if (limit === null) return null;
  return Number.isFinite(reservedUsd) ? Math.max(0, limit - reservedUsd) : 0;
}

function validateTokenEstimate(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Local AI ${field} must be a non-negative safe integer`);
  }
}
