/**
 * Fable WS7 Phase A — loop provider failover decision.
 *
 * Consumes the previously-unconsumed `shouldFailover` classification axis: a
 * loop iteration whose recovery exhausted on a provider-fault category retries
 * once per switch on the next configured fallback provider instead of dying.
 *
 * Pure decision logic; the coordinator supplies the classification, run state,
 * and the loop-scope vetoes (WS2 provider-limit ledger park, CLI installed),
 * and routes the actual target pick through the FailoverManager so its
 * telemetry stays the single source of failover truth.
 *
 * Guardrails (from the plan):
 *  - only at an ITERATION boundary (the caller wires this at the point the
 *    iteration would otherwise terminate the run);
 *  - never on categories whose classification says `shouldFailover: false`
 *    (validation, permission, prompt-delivery, safety refusals…);
 *  - bounded by `maxSwitches` per run, persisted on state.
 */

import type { LoopFailoverConfig } from '../../shared/types/loop.types';
import type { LoopProvider } from '../../shared/types/loop.types';
import type { LoopStage, LoopState } from '../../shared/types/loop.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('LoopFailover');

export interface LoopFailoverDecisionInput {
  /** `axes.shouldFailover` from `classifyLoopError`. */
  shouldFailover: boolean;
  /** The classification reason (for the decision note / telemetry). */
  reason: string;
  config: LoopFailoverConfig | undefined;
  currentProvider: string;
  /** Switches already performed this run (persisted on LoopState). */
  switchesSoFar: number;
}

export type LoopFailoverDecision =
  | { action: 'try-switch'; candidates: string[]; note: string }
  | { action: 'none'; note: string };

/**
 * Decide whether a failed iteration is ALLOWED to attempt a provider switch,
 * and with which ordered candidates. The concrete target still has to survive
 * the FailoverManager selection (cooldown/circuit) + the caller's vetoes.
 */
export function decideLoopFailover(input: LoopFailoverDecisionInput): LoopFailoverDecision {
  const config = input.config;
  if (!config?.enabled) {
    return { action: 'none', note: 'failover disabled for this run' };
  }
  if (!input.shouldFailover) {
    return { action: 'none', note: `classification "${input.reason}" is not a failover category` };
  }
  const maxSwitches = Math.max(1, config.maxSwitches ?? 1);
  if (input.switchesSoFar >= maxSwitches) {
    return { action: 'none', note: `failover budget exhausted (${input.switchesSoFar}/${maxSwitches} switches)` };
  }
  const candidates = config.providers.filter((provider) => provider !== input.currentProvider);
  if (candidates.length === 0) {
    return { action: 'none', note: 'no fallback providers configured besides the current one' };
  }
  return {
    action: 'try-switch',
    candidates,
    note: `classification "${input.reason}" allows failover (switch ${input.switchesSoFar + 1}/${maxSwitches})`,
  };
}

// ─── runtime orchestration (injected deps; exercised by the coordinator) ────

export interface AttemptLoopFailoverDeps {
  /** classifyLoopError bound to the run's provider/model context. */
  classify: (error: unknown) => { axes: { shouldFailover: boolean }; reason: string; message: string };
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
  /** CLI names installed on this machine (loop provider ids). */
  installedProviders: ReadonlySet<string>;
  /** WS10 operator notification (best-effort). */
  notify: (input: { title: string; body: string }) => void;
  /** Loop timeline entry. */
  emitActivity: (payload: { message: string; detail: Record<string, unknown> }) => void;
}

export interface LoopFailoverOutcome {
  switched: boolean;
  from?: LoopProvider;
  to?: LoopProvider;
  note: string;
}

/**
 * Attempt a provider switch for a run whose iteration invocation failed
 * terminally. On success, MUTATES `state.config.provider` and increments
 * `state.failoverSwitches`; the caller forces a fresh session (context reset)
 * and re-runs the iteration — the loop state files re-anchor the goal, the
 * same mechanism fresh-child mode uses. Never throws.
 */
export function attemptLoopFailover(
  state: LoopState,
  error: unknown,
  seq: number,
  stage: LoopStage,
  deps: AttemptLoopFailoverDeps,
): LoopFailoverOutcome {
  try {
    const classification = deps.classify(error);
    const decision = decideLoopFailover({
      shouldFailover: classification.axes.shouldFailover,
      reason: classification.reason,
      config: state.config.failover,
      currentProvider: state.config.provider,
      switchesSoFar: state.failoverSwitches ?? 0,
    });
    if (decision.action !== 'try-switch') {
      logger.info('Loop failover not attempted', { loopRunId: state.id, seq, note: decision.note });
      return { switched: false, note: decision.note };
    }

    const from = state.config.provider;
    const { to, considered } = deps.selectTarget({
      from,
      candidates: decision.candidates,
      reason: classification.reason,
      correlationId: state.id,
      veto: (provider) => {
        if (!deps.installedProviders.has(provider)) return 'cli_not_installed';
        if (deps.isProviderParked(provider)) return 'provider_limit_parked';
        return null;
      },
    });
    if (!to) {
      const note = `no eligible fallback provider (considered: ${considered.map((c) => `${c.provider}:${c.vetoReason ?? 'ok'}`).join(', ')})`;
      logger.warn('Loop failover found no target', { loopRunId: state.id, seq, note });
      return { switched: false, note };
    }

    state.config.provider = to as LoopProvider;
    state.failoverSwitches = (state.failoverSwitches ?? 0) + 1;
    const note = `${decision.note} — switching ${from} → ${to}`;
    deps.emitActivity({
      message: `Provider failover: ${from} → ${to} after ${classification.reason} (${state.failoverSwitches}/${Math.max(1, state.config.failover?.maxSwitches ?? 1)} switches)`,
      detail: {
        reason: classification.reason,
        error: classification.message.slice(0, 300),
        from,
        to,
        seq,
        stage,
        considered,
      },
    });
    deps.notify({
      title: `Loop switched to ${to}`,
      body: `Loop "${state.config.initialPrompt.slice(0, 80)}" failed over from ${from} after ${classification.reason}; continuing on ${to}.`,
    });
    logger.warn('Loop provider failover performed', { loopRunId: state.id, seq, from, to, reason: classification.reason });
    return { switched: true, from: from as LoopProvider, to: to as LoopProvider, note };
  } catch (err) {
    const note = `failover attempt errored: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn('Loop failover attempt threw — continuing to terminal handling', { loopRunId: state.id, seq, note });
    return { switched: false, note };
  }
}
