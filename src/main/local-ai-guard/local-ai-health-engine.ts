import type { AuxiliaryLlmSlot } from '../../shared/types/auxiliary-llm.types';
import type {
  LocalAiAggregateStatus,
  LocalAiFailureCode,
  LocalAiHealthState,
  LocalAiHealthTransition,
  LocalAiProbeResult,
  LocalAiRecoveryState,
  LocalAiStateTransitionEvidence,
  LocalAiTarget,
  LocalAiTargetStatus,
} from '../../shared/types/local-ai-guard.types';
import {
  isMateriallyNewLayerWinner,
  layerValues,
  mergeLayers,
  newestCheckedAt,
  normalizeRoles,
  parseProbeResult,
  probesEqual,
  selectLayerSamples,
  validatePreviousStatus,
} from './local-ai-health-normalization';

export const LOCAL_AI_FLAPPING_WINDOW_MS = 10 * 60 * 1_000;
export const LOCAL_AI_FLAPPING_TRANSITION_THRESHOLD = 4;
export const LOCAL_AI_MAX_STATE_TRANSITIONS = 8;
export const LOCAL_AI_CRITICAL_FAILURE_CODES = [
  'worker-offline',
  'authentication-error',
  'missing-required-model',
] as const satisfies readonly LocalAiFailureCode[];

const CRITICAL_FAILURE_CODES = new Set<LocalAiFailureCode>(LOCAL_AI_CRITICAL_FAILURE_CODES);
const RECOVERY_SUCCESS_THRESHOLD = 2;
const DEGRADED_FAILURE_THRESHOLD = 2;
const UNAVAILABLE_FAILURE_THRESHOLD = 3;

const ACTIVE_STATES = new Set<LocalAiHealthState>(['healthy', 'degraded', 'unavailable']);

export class LocalAiHealthEngine {
  apply(
    target: LocalAiTarget,
    previous: LocalAiTargetStatus | undefined,
    samples: LocalAiProbeResult[],
    now?: number,
  ): LocalAiHealthTransition {
    const validatedPrevious = validatePreviousStatus(target.id, previous);
    const selected = selectLayerSamples(target.id, samples);
    const effectiveNow = Math.max(
      validatedPrevious?.checkedAt ?? 0,
      validTimestamp(now) ?? 0,
      newestCheckedAt(selected) ?? 0,
      validTimestamp(target.updatedAt) ?? 0,
    );
    const previousCopy = validatedPrevious
      ? {
          ...validatedPrevious,
          stateTransitions: normalizeTransitions(
            validatedPrevious.stateTransitions ?? [],
            effectiveNow,
          ),
        }
      : undefined;
    const priorRecoveryState = previousCopy?.recoveryState
      ?? inferRecoveryState(previousCopy);
    const priorIncidentOpen = previousCopy?.incidentOpen
      ?? previousCopy?.state === 'unavailable';

    if (target.lifecycle === 'paused') {
      return {
        previous: previousCopy,
        current: pausedStatus(target, previousCopy, effectiveNow),
        incidentAction: 'none',
      };
    }
    if (target.lifecycle !== 'enrolled') {
      return {
        previous: previousCopy,
        current: this.checking(target, effectiveNow),
        incidentAction: 'none',
      };
    }
    if (normalizeRoles(target.routingRoles).length === 0) {
      return {
        previous: previousCopy,
        current: this.checking(target, effectiveNow),
        incidentAction: 'none',
      };
    }

    const accepted = selected.filter((item) =>
      isMateriallyNewLayerWinner(item, previousCopy?.layers[item.layer]));
    const layers = mergeLayers(previousCopy?.layers ?? {}, selected);
    const checkedAt = Math.max(previousCopy?.checkedAt ?? 0, newestCheckedAt(layerValues(layers)) ?? 0);
    const stateTransitions = previousCopy?.stateTransitions ?? [];
    const newEvaluationCycle = accepted.length > 0;
    const newRequiredEvaluation = accepted.some((item) => item.required);
    const mergedSamples = layerValues(layers);
    const freshMergedSamples = mergedSamples.filter((item) =>
      isFresh(item.checkedAt, effectiveNow, target.freshnessLimitMs));
    const staleRequiredEvidence = mergedSamples.some((item) =>
      item.required && !isFresh(item.checkedAt, effectiveNow, target.freshnessLimitMs));
    const hasFreshRequiredEvidence = freshMergedSamples.some((item) => item.required);
    const evidenceIsUsable = hasFreshRequiredEvidence && !staleRequiredEvidence;

    if (!evidenceIsUsable) {
      return {
        previous: previousCopy,
        current: {
          targetId: target.id,
          lifecycle: target.lifecycle,
          state: previousCopy?.flapping ? 'unavailable' : 'checking',
          routableRoles: [],
          layers,
          consecutiveFailures: previousCopy?.consecutiveFailures ?? 0,
          consecutiveSuccesses: previousCopy?.consecutiveSuccesses ?? 0,
          flapping: previousCopy?.flapping ?? false,
          checkedAt,
          ...(priorRecoveryState ? { recoveryState: priorRecoveryState } : {}),
          incidentOpen: priorIncidentOpen,
          stateTransitions,
        },
        incidentAction: 'none',
      };
    }

    const requiredFailures = freshMergedSamples.filter((item) => item.required && !item.ok);
    const optionalFailures = freshMergedSamples.filter((item) => !item.required && !item.ok);
    const allFailures = [...requiredFailures, ...optionalFailures];
    const requiredCycleSucceeded = evidenceIsUsable && requiredFailures.length === 0;
    const failedPreRouteCheck = accepted.some((selectedItem) =>
      selectedItem.required
      && !selectedItem.ok
      && samples.some((rawItem) =>
        isPreRouteSample(rawItem)
        && probesEqual(parseProbeResult(rawItem), selectedItem)));
    const criticalFailure = requiredFailures.some((item) =>
      item.failureCode !== undefined && CRITICAL_FAILURE_CODES.has(item.failureCode))
      || failedPreRouteCheck;

    let consecutiveFailures = previousCopy?.consecutiveFailures ?? 0;
    let consecutiveSuccesses = previousCopy?.consecutiveSuccesses ?? 0;
    if (newRequiredEvaluation) {
      if (requiredFailures.length > 0) {
        consecutiveFailures = incrementBounded(consecutiveFailures, UNAVAILABLE_FAILURE_THRESHOLD);
        consecutiveSuccesses = 0;
      } else if (optionalFailures.length > 0) {
        consecutiveFailures = 0;
        consecutiveSuccesses = 0;
      } else if (requiredCycleSucceeded) {
        consecutiveFailures = 0;
        consecutiveSuccesses = incrementBounded(consecutiveSuccesses, RECOVERY_SUCCESS_THRESHOLD);
      }
    } else if (newEvaluationCycle && optionalFailures.length > 0) {
      consecutiveSuccesses = 0;
    }

    const recovering = previousCopy?.flapping === true || priorRecoveryState !== undefined;
    const recovered = recovering
      && newRequiredEvaluation
      && requiredCycleSucceeded
      && consecutiveSuccesses >= RECOVERY_SUCCESS_THRESHOLD;
    let candidateState = deriveCandidateState({
      previous: previousCopy,
      recoveryState: priorRecoveryState,
      requiredFailure: requiredFailures.length > 0,
      optionalFailure: optionalFailures.length > 0,
      criticalFailure,
      consecutiveFailures,
      requiredCycleSucceeded,
      recovered,
    });
    let routableRoles = deriveRoutableRoles({
      targetRoles: target.routingRoles,
      previous: previousCopy,
      failures: allFailures,
      recovering,
      recovered,
      requiredFailure: requiredFailures.length > 0,
      candidateState,
    });

    let flapping = previousCopy?.flapping ?? false;
    let transitionAppend = appendStateTransition(
      stateTransitions, previousCopy?.state, candidateState, effectiveNow, newEvaluationCycle,
    );
    if (previousCopy?.flapping) {
      if (!recovered) {
        candidateState = 'unavailable';
        routableRoles = [];
      } else {
        flapping = false;
        transitionAppend = {
          history: [{ state: candidateState, at: effectiveNow }],
          appended: true,
          transitionCount: 1,
        };
      }
    }

    const newlyFlapping = newEvaluationCycle
      && !previousCopy?.flapping
      && transitionAppend.appended
      && transitionAppend.transitionCount >= LOCAL_AI_FLAPPING_TRANSITION_THRESHOLD;
    if (newlyFlapping) {
      candidateState = 'unavailable';
      routableRoles = [];
      consecutiveSuccesses = 0;
      flapping = true;
    }

    let recoveryState = priorRecoveryState;
    if (recovered) {
      recoveryState = undefined;
    } else if (newlyFlapping) {
      recoveryState = 'unavailable';
    } else if (newEvaluationCycle && allFailures.length > 0) {
      recoveryState = worseRecoveryState(
        recoveryState,
        isRecoveryState(candidateState) ? candidateState : 'degraded',
      );
    }
    const incidentAction = incidentActionFor({
      priorIncidentOpen,
      currentState: candidateState,
      hasFailure: allFailures.length > 0,
      newlyFlapping,
      newRequiredEvaluation,
      recovered,
    });
    const incidentOpen = incidentAction === 'resolve'
      ? false
      : priorIncidentOpen || incidentAction === 'open' || incidentAction === 'update';
    const current = buildStatus({
      target,
      state: candidateState,
      routableRoles,
      layers,
      consecutiveFailures,
      consecutiveSuccesses,
      flapping,
      checkedAt,
      recoveryState,
      incidentOpen,
      stateTransitions: transitionAppend.history,
    });
    return {
      previous: previousCopy,
      current,
      incidentAction,
    };
  }

  checking(target: LocalAiTarget, now?: number): LocalAiTargetStatus {
    const effectiveNow = validTimestamp(now) ?? validTimestamp(target.updatedAt) ?? 0;
    return {
      targetId: target.id,
      lifecycle: target.lifecycle,
      state: target.lifecycle === 'paused' ? 'paused' : 'checking',
      routableRoles: [],
      layers: {},
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      flapping: false,
      checkedAt: effectiveNow,
      stateTransitions: [],
    };
  }

  aggregate(targets: LocalAiTargetStatus[]): LocalAiAggregateStatus {
    const byTarget = new Map<string, LocalAiTargetStatus>();
    for (const target of targets) {
      const retained = byTarget.get(target.targetId);
      if (!retained || preferAggregateStatus(target, retained) > 0) {
        byTarget.set(target.targetId, target);
      }
    }
    const configured = [...byTarget.values()].filter((target) =>
      target.lifecycle !== 'unmanaged' && target.lifecycle !== 'retired');
    if (configured.length === 0) {
      return {
        state: 'not-configured',
        enrolled: 0,
        healthy: 0,
        degraded: 0,
        unavailable: 0,
        paused: 0,
      };
    }

    const active = configured.filter((target) =>
      target.lifecycle !== 'paused' && target.state !== 'paused');
    const counts = {
      healthy: active.filter((target) => target.state === 'healthy').length,
      degraded: active.filter((target) => target.state === 'degraded').length,
      unavailable: active.filter((target) => target.state === 'unavailable').length,
      paused: configured.length - active.length,
    };
    const state = active.length === 0
      ? 'paused'
      : active.reduce<LocalAiHealthState>((worst, target) =>
        stateSeverity(target.state) > stateSeverity(worst) ? target.state : worst, 'healthy');
    return {
      state,
      enrolled: configured.length,
      ...counts,
    };
  }
}

function deriveCandidateState(input: {
  previous: LocalAiTargetStatus | undefined;
  recoveryState: LocalAiRecoveryState | undefined;
  requiredFailure: boolean;
  optionalFailure: boolean;
  criticalFailure: boolean;
  consecutiveFailures: number;
  requiredCycleSucceeded: boolean;
  recovered: boolean;
}): LocalAiHealthState {
  if (input.criticalFailure || input.consecutiveFailures >= UNAVAILABLE_FAILURE_THRESHOLD) {
    return 'unavailable';
  }
  if (input.optionalFailure) {
    return input.previous?.state === 'unavailable' ? 'unavailable' : 'degraded';
  }
  if (input.requiredFailure) {
    if (input.consecutiveFailures >= DEGRADED_FAILURE_THRESHOLD) return 'degraded';
    return activeOrCheckingState(input.previous?.state);
  }
  if (input.requiredCycleSucceeded) {
    if (input.recovered || !input.previous) {
      return input.optionalFailure ? 'degraded' : 'healthy';
    }
    if (input.recoveryState) return input.recoveryState;
    if (input.previous.state === 'checking') return 'healthy';
    return activeOrCheckingState(input.previous.state);
  }
  return activeOrCheckingState(input.previous?.state);
}

function deriveRoutableRoles(input: {
  targetRoles: AuxiliaryLlmSlot[];
  previous: LocalAiTargetStatus | undefined;
  failures: LocalAiProbeResult[];
  recovering: boolean;
  recovered: boolean;
  requiredFailure: boolean;
  candidateState: LocalAiHealthState;
}): AuxiliaryLlmSlot[] {
  const targetRoles = normalizeRoles(input.targetRoles);
  if (input.candidateState === 'checking' || input.candidateState === 'paused') return [];
  const failedRoles = new Set(input.failures.flatMap((failure) => normalizeRoles(failure.affectedRoles)));
  const retainPriorQuarantine = input.previous !== undefined && (
    input.requiredFailure || (input.recovering && !input.recovered)
  );
  const baseRoles = retainPriorQuarantine
    ? normalizeRoles(input.previous!.routableRoles).filter((role) => targetRoles.includes(role))
    : targetRoles;
  return baseRoles.filter((role) => !failedRoles.has(role));
}

function incidentActionFor(input: {
  priorIncidentOpen: boolean;
  currentState: LocalAiHealthState;
  hasFailure: boolean;
  newlyFlapping: boolean;
  newRequiredEvaluation: boolean;
  recovered: boolean;
}): LocalAiHealthTransition['incidentAction'] {
  if (input.recovered && input.priorIncidentOpen) return 'resolve';
  if (input.newlyFlapping) {
    return input.priorIncidentOpen ? 'update' : 'open';
  }
  if (!input.newRequiredEvaluation) return 'none';
  if (input.currentState === 'unavailable' && input.hasFailure) {
    return input.priorIncidentOpen ? 'update' : 'open';
  }
  return 'none';
}

function pausedStatus(
  target: LocalAiTarget,
  previous: LocalAiTargetStatus | undefined,
  now: number,
): LocalAiTargetStatus {
  return {
    targetId: target.id,
    lifecycle: target.lifecycle,
    state: 'paused',
    routableRoles: [],
    layers: previous?.layers ?? {},
    consecutiveFailures: previous?.consecutiveFailures ?? 0,
    consecutiveSuccesses: previous?.consecutiveSuccesses ?? 0,
    flapping: previous?.flapping ?? false,
    checkedAt: previous?.checkedAt ?? now,
    ...(previous?.recoveryState ?? inferRecoveryState(previous)
      ? { recoveryState: previous?.recoveryState ?? inferRecoveryState(previous) }
      : {}),
    incidentOpen: previous?.incidentOpen ?? previous?.state === 'unavailable',
    stateTransitions: previous?.stateTransitions ?? [],
  };
}

function buildStatus(input: {
  target: LocalAiTarget;
  state: LocalAiHealthState;
  routableRoles: AuxiliaryLlmSlot[];
  layers: LocalAiTargetStatus['layers'];
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  flapping: boolean;
  checkedAt: number;
  recoveryState: LocalAiRecoveryState | undefined;
  incidentOpen: boolean;
  stateTransitions: LocalAiStateTransitionEvidence[];
}): LocalAiTargetStatus {
  return {
    targetId: input.target.id,
    lifecycle: input.target.lifecycle,
    state: input.state,
    routableRoles: normalizeRoles(input.routableRoles),
    layers: input.layers,
    consecutiveFailures: input.consecutiveFailures,
    consecutiveSuccesses: input.consecutiveSuccesses,
    flapping: input.flapping,
    checkedAt: input.checkedAt,
    ...(input.recoveryState ? { recoveryState: input.recoveryState } : {}),
    incidentOpen: input.incidentOpen,
    stateTransitions: input.stateTransitions,
  };
}

function appendStateTransition(
  history: LocalAiStateTransitionEvidence[],
  previousState: LocalAiHealthState | undefined,
  nextState: LocalAiHealthState,
  now: number,
  newEvaluationCycle: boolean,
): {
  history: LocalAiStateTransitionEvidence[];
  appended: boolean;
  transitionCount: number;
} {
  const latestState = history.at(-1)?.state ?? previousState;
  if (!newEvaluationCycle || !latestState || !ACTIVE_STATES.has(latestState)
    || !ACTIVE_STATES.has(nextState) || latestState === nextState) {
    return { history, appended: false, transitionCount: history.length };
  }
  const appended = [...history, { state: nextState, at: now }];
  return {
    history: appended.slice(-LOCAL_AI_MAX_STATE_TRANSITIONS),
    appended: true,
    transitionCount: appended.length,
  };
}

function normalizeTransitions(
  history: LocalAiStateTransitionEvidence[],
  now: number,
): LocalAiStateTransitionEvidence[] {
  const earliest = Math.max(0, now - LOCAL_AI_FLAPPING_WINDOW_MS);
  const byTimestamp = new Map<number, LocalAiHealthState>();
  for (const raw of history as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as { state?: unknown; at?: unknown };
    if (!isActiveState(item.state)) continue;
    const at = validTimestamp(item.at);
    if (at === undefined || at < earliest || at > now) continue;
    const existing = byTimestamp.get(at);
    if (!existing || stateSeverity(item.state) > stateSeverity(existing)) {
      byTimestamp.set(at, item.state);
    }
  }
  const normalized: LocalAiStateTransitionEvidence[] = [];
  for (const [at, state] of [...byTimestamp.entries()].sort(([left], [right]) => left - right)) {
    if (normalized.at(-1)?.state === state) continue;
    normalized.push({ state, at });
  }
  return normalized.slice(-LOCAL_AI_MAX_STATE_TRANSITIONS);
}

function isPreRouteSample(sample: unknown): boolean {
  return !!sample && typeof sample === 'object' && 'origin' in sample
    && sample.origin === 'pre-route';
}

function isFresh(checkedAt: number, now: number, freshnessLimitMs: number): boolean {
  return checkedAt <= now && now - checkedAt <= freshnessLimitMs;
}

function validTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function isActiveState(value: unknown): value is LocalAiHealthState {
  return typeof value === 'string' && ACTIVE_STATES.has(value as LocalAiHealthState);
}

function isRecoveryState(value: unknown): value is LocalAiRecoveryState {
  return value === 'healthy' || value === 'degraded' || value === 'unavailable';
}

function inferRecoveryState(
  status: LocalAiTargetStatus | undefined,
): LocalAiRecoveryState | undefined {
  if (!status) return undefined;
  if (isRecoveryState(status.recoveryState)) return status.recoveryState;
  if (status.state === 'unavailable') return 'unavailable';
  if (status.state === 'degraded') return 'degraded';
  return status.consecutiveFailures > 0 && status.state === 'healthy' ? 'healthy' : undefined;
}

function worseRecoveryState(
  previous: LocalAiRecoveryState | undefined,
  next: LocalAiRecoveryState,
): LocalAiRecoveryState {
  if (!previous) return next;
  return stateSeverity(next) > stateSeverity(previous) ? next : previous;
}

function preferAggregateStatus(
  incoming: LocalAiTargetStatus,
  retained: LocalAiTargetStatus,
): number {
  if (incoming.checkedAt !== retained.checkedAt) return incoming.checkedAt - retained.checkedAt;
  const lifecycleDifference = aggregateLifecycleRank(incoming) - aggregateLifecycleRank(retained);
  if (lifecycleDifference !== 0) return lifecycleDifference;
  const severityDifference = stateSeverity(incoming.state) - stateSeverity(retained.state);
  if (severityDifference !== 0) return severityDifference;
  return stableAggregateKey(incoming).localeCompare(stableAggregateKey(retained));
}

function aggregateLifecycleRank(status: LocalAiTargetStatus): number {
  return status.lifecycle === 'retired' || status.lifecycle === 'unmanaged' ? 0 : 1;
}

function stableAggregateKey(status: LocalAiTargetStatus): string {
  return JSON.stringify([
    status.lifecycle ?? '',
    status.state,
    normalizeRoles(status.routableRoles),
    status.consecutiveFailures,
    status.consecutiveSuccesses,
    status.flapping,
  ]);
}

function incrementBounded(value: number, maximum: number): number {
  return Math.min(value + 1, maximum);
}

function activeOrCheckingState(state: LocalAiHealthState | undefined): LocalAiHealthState {
  return state && ACTIVE_STATES.has(state) ? state : 'checking';
}

function stateSeverity(state: LocalAiHealthState): number {
  switch (state) {
    case 'unavailable': return 4;
    case 'degraded': return 3;
    case 'checking': return 2;
    case 'healthy': return 1;
    case 'paused': return 0;
  }
}
