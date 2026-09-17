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
import { detectAvailableClis, getCliDetectionService, type CliInfo } from '../cli/cli-detection';
import { classifyLoopError } from '../core/loop-error-classification';
import { isProviderParkedForFailover } from '../providers/account-pool/provider-parked-veto';
import { getNotificationService } from '../notifications/notification-service';
import { getFailoverManager } from '../providers/failover-manager';
import { getLogger } from '../logging/logger';
import type { LoopCompletionContextStore } from './loop-completion-context-store';

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

interface CoordinatorLoopFailoverArgs {
  state: LoopState;
  seq: number;
  stage: LoopStage;
  downshiftModel?: string | null;
  onSwitched: (from: LoopProvider) => void;
  emit: (eventName: string, payload: unknown) => void;
}

function installedProvidersFrom(clis: readonly CliInfo[]): ReadonlySet<string> {
  return new Set(clis.filter((cli) => cli.installed).map((cli) => cli.name));
}

function runCoordinatorFailoverAttempt(
  args: CoordinatorLoopFailoverArgs,
  error: unknown,
  installed: ReadonlySet<string>,
  classify: AttemptLoopFailoverDeps['classify'],
): boolean {
  const outcome = attemptLoopFailover(args.state, error, args.seq, args.stage, {
    classify,
    selectTarget: (request) => getFailoverManager().selectLoopFailoverTarget(request),
    isProviderParked: (provider) => isProviderParkedForFailover(provider),
    installedProviders: installed,
    notify: (input) => {
      try {
        getNotificationService().notify({
          kind: 'loop-failover',
          title: input.title,
          body: input.body,
          urgency: 'normal',
          fingerprintFields: { loopRunId: args.state.id, seq: args.seq },
        });
      } catch { /* notification is best-effort */ }
    },
    emitActivity: (payload) => args.emit('loop:activity', {
      loopRunId: args.state.id,
      seq: args.seq,
      stage: args.stage,
      timestamp: Date.now(),
      kind: 'status',
      message: payload.message,
      detail: payload.detail,
    }),
  });
  if (outcome.switched && outcome.from) {
    args.onSwitched(outcome.from);
  }
  return outcome.switched;
}

export async function runCoordinatorLoopFailover(
  args: CoordinatorLoopFailoverArgs & { error: unknown },
): Promise<boolean> {
  if (!args.state.config.failover?.enabled) return false;

  let installed: ReadonlySet<string>;
  try {
    installed = installedProvidersFrom(await detectAvailableClis());
  } catch {
    installed = new Set();
  }
  return runCoordinatorFailoverAttempt(args, args.error, installed, (err) => classifyLoopError(err, {
    provider: args.state.config.provider,
    model: args.downshiftModel ?? undefined,
  }));
}

/**
 * Provider-limit variant: the loop is about to park (or terminate) on a usage
 * limit. A limit is by definition a failover category, so no error
 * classification is needed; the same opt-in, switch budget and vetoes apply.
 *
 * Synchronous because every park site is. CLI availability comes from the
 * detection cache, which the coordinator warms before each iteration of a
 * failover-enabled run; with no cache yet every candidate is vetoed and the
 * loop parks exactly as it would have without failover.
 */
export function runCoordinatorProviderLimitFailover(
  args: CoordinatorLoopFailoverArgs & { reason: string },
): boolean {
  if (!args.state.config.failover?.enabled) return false;

  const cached = getCliDetectionService().peekCachedResult();
  const installed = cached ? installedProvidersFrom(cached.detected) : new Set<string>();
  return runCoordinatorFailoverAttempt(args, args.reason, installed, () => ({
    axes: { shouldFailover: true },
    reason: 'provider usage limit',
    message: args.reason,
  }));
}

type LoopFailoverContextStore = Pick<
  LoopCompletionContextStore,
  'getDownshiftModel' | 'setPendingFailover' | 'requestContextReset' | 'clearDownshiftModel'
>;

/**
 * The coordinator's entry points into provider failover. Selection routes
 * through the FailoverManager (cooldown/circuit telemetry) with loop-scope
 * vetoes: WS2 provider-limit ledger park and CLI availability. On success the
 * run's provider is switched, the switch budget is consumed, the next
 * iteration is tagged `failedOverFrom` and forced onto a fresh session.
 */
export class LoopFailoverRunner {
  constructor(private readonly deps: {
    completionContext: LoopFailoverContextStore;
    emit: (eventName: string, payload: unknown) => void;
  }) {}

  /** After terminal invocation failure. Never throws; false = proceed to terminal handling. */
  afterInvocationFailure(state: LoopState, error: unknown, seq: number, stage: LoopStage): Promise<boolean> {
    return runCoordinatorLoopFailover({
      state,
      error,
      seq,
      stage,
      downshiftModel: this.deps.completionContext.getDownshiftModel(state.id),
      onSwitched: (from) => this.onSwitched(state, from),
      emit: this.deps.emit,
    });
  }

  /** In place of a provider-limit park or terminate. Never throws; false = park. */
  onProviderLimit(state: LoopState, reason: string): boolean {
    return runCoordinatorProviderLimitFailover({
      state,
      reason,
      seq: state.totalIterations,
      stage: state.currentStage,
      onSwitched: (from) => this.onSwitched(state, from),
      emit: this.deps.emit,
    });
  }

  /** Refresh the CLI detection cache that {@link onProviderLimit} reads synchronously. */
  async warmCliDetection(state: LoopState): Promise<void> {
    if (!state.config.failover?.enabled) return;
    await detectAvailableClis().catch(() => []);
  }

  private onSwitched(state: LoopState, from: LoopProvider): void {
    this.deps.completionContext.setPendingFailover(state.id, from);
    this.deps.completionContext.requestContextReset(state.id);
    // A downshift model belongs to the old provider's catalog.
    this.deps.completionContext.clearDownshiftModel(state.id);
    state.lastThreadCaps = undefined;
  }
}
