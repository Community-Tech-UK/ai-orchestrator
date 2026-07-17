/**
 * Fable WS7 Phase B — regular-session provider failover.
 *
 * Consumes the `shouldFailover` classification axis for interactive sessions:
 * when a session's interrupt/unexpected-exit recovery ladder exhausts on a
 * provider-fault category, hand the conversation to the next configured
 * fallback provider (a cross-provider swap through the RuntimeReconciler)
 * instead of leaving a dead instance.
 *
 * Pure decision logic here; instance-lifecycle supplies the classification,
 * the target selection (FailoverManager — the single failover source of
 * truth), the WS2 provider-limit veto, and the actual swap closure.
 *
 * Guardrails (from the plan):
 *  - only at recovery-ladder EXHAUSTION (the handler wires this at its
 *    error-terminal catch — turn already over, ladder fully spent);
 *  - never on categories whose classification says `shouldFailover: false`;
 *  - bounded by `maxSwitches` per session (persisted on the Instance).
 */

import type { Instance } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('InstanceFailover');

export interface InstanceFailoverDecisionInput {
  /** `axes.shouldFailover` from `classifyLoopError`. */
  shouldFailover: boolean;
  /** The classification reason (for the decision note / telemetry). */
  reason: string;
  /** Ordered fallback providers configured for this session. */
  failoverProviders: readonly string[] | undefined;
  currentProvider: string;
  /** Switches already performed this session. */
  switchesSoFar: number;
  maxSwitches: number;
}

export type InstanceFailoverDecision =
  | { action: 'try-switch'; candidates: string[]; note: string }
  | { action: 'none'; note: string };

/**
 * Decide whether an exhausted session is ALLOWED to attempt a provider switch,
 * and with which ordered candidates. The concrete target still has to survive
 * FailoverManager selection (cooldown/circuit) + the caller's vetoes.
 */
export function decideInstanceFailover(
  input: InstanceFailoverDecisionInput,
): InstanceFailoverDecision {
  const providers = input.failoverProviders ?? [];
  if (providers.length === 0) {
    return { action: 'none', note: 'no fallback providers configured (failover off)' };
  }
  if (!input.shouldFailover) {
    return { action: 'none', note: `classification "${input.reason}" is not a failover category` };
  }
  const maxSwitches = Math.max(1, input.maxSwitches);
  if (input.switchesSoFar >= maxSwitches) {
    return { action: 'none', note: `failover budget exhausted (${input.switchesSoFar}/${maxSwitches})` };
  }
  const candidates = providers.filter((provider) => provider !== input.currentProvider);
  if (candidates.length === 0) {
    return { action: 'none', note: 'no fallback providers besides the current one' };
  }
  return {
    action: 'try-switch',
    candidates,
    note: `classification "${input.reason}" allows failover (switch ${input.switchesSoFar + 1}/${maxSwitches})`,
  };
}

/**
 * WS7 Phase B offered switch: decide whether a fresh quota-park warrants a
 * "switch provider" notification, and build it. Pure; returns null when no
 * offer applies (no fallbacks, or the park is short).
 */
export function buildParkFailoverOfferNotification(params: {
  instance: Pick<Instance, 'id' | 'displayName' | 'provider' | 'failoverProviders'> | undefined;
  provider: string;
  resumeAt: number;
  offerAfterMinutes: number;
  now?: number;
}): { kind: string; title: string; body: string; fingerprintFields: Record<string, unknown> } | null {
  const fallbacks = params.instance?.failoverProviders?.filter(
    (p) => p !== params.instance?.provider,
  ) ?? [];
  const offerAfterMs = Math.max(1, params.offerAfterMinutes) * 60_000;
  if (fallbacks.length === 0 || params.resumeAt - (params.now ?? Date.now()) <= offerAfterMs) {
    return null;
  }
  const name = params.instance?.displayName ?? params.instance?.id ?? 'session';
  return {
    kind: 'instance-failover-offer',
    title: `${params.provider} parked until ${new Date(params.resumeAt).toLocaleTimeString()}`,
    body: `"${name}" is waiting on a ${params.provider} limit. You can switch it to ${fallbacks[0]} now with the "Switch provider" button on the session.`,
    fingerprintFields: { instanceId: params.instance?.id, resumeAt: params.resumeAt },
  };
}

export interface AttemptInstanceFailoverDeps {
  /** classifyLoopError bound to the instance's provider/model context. */
  classify: (error: unknown) => { axes: { shouldFailover: boolean }; reason: string; message: string };
  maxSwitches: number;
  /** FailoverManager.selectLoopFailoverTarget — the failover source of truth. */
  selectTarget: (request: {
    from: string;
    candidates: readonly string[];
    reason: string;
    correlationId?: string;
    veto?: (provider: string) => string | null;
  }) => { to: string | null; considered: Array<{ provider: string; vetoReason: string | null }> };
  /** WS2 provider-limit ledger consult: true = provider currently parked. */
  isProviderParked: (provider: string) => boolean;
  /** CLI names installed on this machine (provider ids). */
  installedProviders: ReadonlySet<string>;
  /**
   * Perform the cross-provider swap (recover the error state + reconciler
   * provider swap). Resolves true on a successful swap. May throw — caught.
   */
  swapProvider: (instanceId: string, targetProvider: string) => Promise<boolean>;
  /** WS10 operator notification (best-effort). */
  notify: (input: { title: string; body: string }) => void;
  /** Timeline / activity entry (best-effort). */
  emitActivity: (payload: { message: string; detail: Record<string, unknown> }) => void;
}

export interface InstanceFailoverOutcome {
  switched: boolean;
  from?: string;
  to?: string;
  note: string;
}

/**
 * Attempt a provider failover for a session whose recovery ladder exhausted.
 * On success MUTATES `instance.failoverSwitches`/`failedOverFrom`/`provider`
 * (the last via the swap closure). Never throws.
 */
export async function attemptInstanceFailover(
  instance: Instance,
  error: unknown,
  deps: AttemptInstanceFailoverDeps,
): Promise<InstanceFailoverOutcome> {
  try {
    const classification = deps.classify(error);
    const from = instance.provider;
    const decision = decideInstanceFailover({
      shouldFailover: classification.axes.shouldFailover,
      reason: classification.reason,
      failoverProviders: instance.failoverProviders,
      currentProvider: from,
      switchesSoFar: instance.failoverSwitches ?? 0,
      maxSwitches: deps.maxSwitches,
    });
    if (decision.action !== 'try-switch') {
      logger.info('Instance failover not attempted', { instanceId: instance.id, note: decision.note });
      return { switched: false, note: decision.note };
    }

    const { to, considered } = deps.selectTarget({
      from,
      candidates: decision.candidates,
      reason: classification.reason,
      correlationId: instance.id,
      veto: (provider) => {
        if (!deps.installedProviders.has(provider)) return 'cli_not_installed';
        if (deps.isProviderParked(provider)) return 'provider_limit_parked';
        return null;
      },
    });
    if (!to) {
      const note = `no eligible fallback provider (considered: ${considered.map((c) => `${c.provider}:${c.vetoReason ?? 'ok'}`).join(', ')})`;
      logger.warn('Instance failover found no target', { instanceId: instance.id, note });
      return { switched: false, note };
    }

    const swapped = await deps.swapProvider(instance.id, to);
    if (!swapped) {
      return { switched: false, note: `swap to ${to} did not complete` };
    }

    instance.failoverSwitches = (instance.failoverSwitches ?? 0) + 1;
    instance.failedOverFrom = from;
    const maxSwitches = Math.max(1, deps.maxSwitches);
    deps.emitActivity({
      message: `Provider failover: ${from} → ${to} after ${classification.reason} (${instance.failoverSwitches}/${maxSwitches} switches)`,
      detail: {
        reason: classification.reason,
        error: classification.message.slice(0, 300),
        from,
        to,
        considered,
      },
    });
    deps.notify({
      title: `Session switched to ${to}`,
      body: `"${(instance.displayName || instance.id).slice(0, 80)}" failed over from ${from} after ${classification.reason}; continuing on ${to}.`,
    });
    logger.warn('Instance provider failover performed', {
      instanceId: instance.id, from, to, reason: classification.reason,
    });
    return { switched: true, from, to, note: `${decision.note} — switched ${from} → ${to}` };
  } catch (err) {
    const note = `failover attempt errored: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn('Instance failover attempt threw — continuing to terminal handling', {
      instanceId: instance.id, note,
    });
    return { switched: false, note };
  }
}
