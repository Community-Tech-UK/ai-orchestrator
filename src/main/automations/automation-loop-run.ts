import { assertAutomationLoopShape } from './automation-loop-authority';
import { boundAutomationSpawnOptions } from './automation-execution-authority';
import { AutomationLoopRunLimits } from './automation-loop-run-limits';
import { automationInvocations } from './automation-invocation-context';
import { AutomationStopAttempts } from './automation-stop-attempts';
import { AutomationDeadlineCancelledError } from './automation-pause-startup';
import type { AutomationResult } from '@contracts/schemas/automation';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
/**
 * Fable WS5 Task 4 — the `spawn-loop` automation action.
 *
 * When an automation's action carries `loop`, its (already webhook-interpolated,
 * egress-gated) prompt becomes an autonomous LOOP goal instead of a one-shot
 * instance turn: issue in, worked branch out. The loop starts through the same
 * `prepareLoopStartConfig` seam as user-started loops, so the WS6
 * verification-authority policy and cap rules apply unchanged — a loop action
 * without a real verify command is refused at dispatch, not silently weakened.
 *
 * The dispatcher owns the loopRunId → automation-run mapping and resolves the
 * automation run when the loop reaches a terminal status (via the coordinator's
 * `loop:state-changed` events, same signal the campaign engine uses). A loop
 * that ran to a terminal failure is a FINAL automation outcome (retryable:
 * false) — re-running a whole loop automatically would double cost blindly —
 * but it still counts toward the automation's auto-disable failure streak,
 * which is exactly the WS5 circuit-breaker behaviour.
 *
 * All collaborators are injected for tests; production defaults bind the real
 * loop coordinator lazily (never at module load, to keep import cycles inert).
 */

import type {
  AutomationRun,
  AutomationRunStatus,
  ClaimedAutomationRun,
} from '../../shared/types/automation.types';
import type { LoopConfig, LoopStatus } from '../../shared/types/loop.types';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import { getLogger } from '../logging/logger';
import { isTerminalLoopRuntimeState } from '../orchestration/loop-runtime-status';

import { isAutomaticStartupCancelled, type AutomaticStartup } from '../work-admission/automatic-startup';

const logger = getLogger('AutomationLoopRun');

/** Loop terminal statuses that count as a successful automation outcome. */
const SUCCESS_STATUSES = new Set<LoopStatus>(['completed', 'completed-needs-review']);
interface AutomationLoopState { status: LoopStatus; endedAt?: number | null; lastCompletionOutcome?: string }

export interface AutomationLoopRunStorePort {
  getRunFacts(runId: string): { result: AutomationResult | null };
  recordStopFailure(runId: string): void;
  addProcessedUsage(runId: string, instanceId: string, source: 'provider' | 'attributed', tokens: number): number;
  attachLoopRun(runId: string, loopRunId: string, now?: number): AutomationRun | null;
  terminalizeRun(
    runId: string,
    status: Exclude<AutomationRunStatus, 'pending' | 'running'>,
    error?: string,
    outputSummary?: string,
    nowOrOptions?: number | { now?: number; outputFullRef?: string; monitorOutput?: string },
  ): AutomationRun | null;
}

export interface AutomationLoopRunDeps {
  store: AutomationLoopRunStorePort;
  now: () => number;
  /** Terminal-run hand-off back to the runner (retry/streak/notification seam). */
  onTerminal: (run: AutomationRun, options?: { retryable?: boolean }) => void;
  cancelLoop?: (loopId: string) => Promise<unknown>;
  onStopFailure?: (runId: string) => void;
  /** Injectable loop start (defaults to the real coordinator, bound lazily). */
  startLoop?: (chatId: string, config: Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string }) => Promise<{ id: string }>;
  /** Injectable start-config preparation (WS6 gates). */
  prepareConfig?: (
    config: Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string },
  ) => Promise<Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string }>;
  /** Injectable subscription to loop state changes. */
  subscribeLoopStateChanged?: (
    listener: (payload: { loopRunId: string; state: AutomationLoopState }) => void,
  ) => void;
}

/** Synthetic chat root for automation-born loops (mirrors `campaign:` roots). */
export function automationLoopChatId(automationId: string, runId: string): string {
  return `automation:${automationId}:${runId}`;
}

/** Build the LoopConfig for a loop-action automation run. Exported for specs. */
export function buildAutomationLoopConfig(
  claimed: ClaimedAutomationRun,
): Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string } {
  const action = claimed.snapshot.action;
  assertAutomationLoopShape(action);
  boundAutomationSpawnOptions(action.executionAuthority, action.provider ?? '', action);
  const loop = action.loop!;
  const base = defaultLoopConfig(action.workingDirectory, action.prompt);
  return {
    ...base,
    ...(action.model ? { model: action.model } : {}),
    ...(action.reasoningEffort ? { reasoningEffort: action.reasoningEffort } : {}),
    ...(action.yoloMode !== undefined ? { yoloMode: action.yoloMode } : {}),
    ...(action.executionAuthority ? { executionAuthority: Object.freeze({ ...action.executionAuthority }) } : {}),
    ...(action.provider && action.provider !== 'auto' ? { provider: action.provider } : {}),
    // Externally triggered work must not dirty the operator's checkout.
    isolateLoopWorkspaces: loop.isolateWorkspace ?? true,
    ...(loop.loopRecipe ? { loopRecipe: loop.loopRecipe } : {}),
    caps: {
      ...base.caps,
      ...(loop.maxIterations ? { maxIterations: loop.maxIterations } : {}),
      ...(loop.maxCostCents ? { maxCostCents: loop.maxCostCents } : {}),
    },
    completion: {
      ...base.completion,
      ...(action.executionAuthority ? { crossModelReview: { enabled: false, blockingSeverities: ['critical' as const, 'high' as const], timeoutSeconds: 300, reviewDepth: 'structured' as const } } : {}),
      verifyCommand: loop.verifyCommand,
    },
  };
}

/**
 * App-restart recovery: loop-linked running runs are NOT orphaned — the loop
 * engine recovers its own runs. Re-track each so the terminal subscription
 * resolves it; fail honestly when the loop's durable record is gone entirely.
 * Extracted from `AutomationRunner.initialize` (LOC + cohesion).
 */
export function recoverLoopLinkedRuns(opts: {
  runs: AutomationRun[];
  dispatcher: () => AutomationLoopRunDispatcher;
  loopRunExists: (loopRunId: string) => boolean;
  store: AutomationLoopRunStorePort;
  now: () => number;
  onTerminal: (run: AutomationRun, options?: { retryable?: boolean }) => void;
}): void {
  for (const run of opts.runs) {
    if (!run.loopRunId) continue;
    if (opts.loopRunExists(run.loopRunId)) {
      opts.dispatcher().track(run.loopRunId, run);
    } else {
      const failed = opts.store.terminalizeRun(
        run.id,
        'failed',
        `Loop run ${run.loopRunId} missing after app restart`,
        undefined,
        opts.now(),
      );
      if (failed) {
        opts.onTerminal(failed, { retryable: false });
      }
    }
  }
}

/**
 * Default existence probe for {@link recoverLoopLinkedRuns}: the loop store's
 * durable run summary. Store unavailable ⇒ keep tracking (the subscription or
 * the next restart resolves it) rather than failing a possibly-live loop.
 */
export function defaultLoopRunExists(loopRunId: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getLoopStoreService } = require('../orchestration/loop-store') as typeof import('../orchestration/loop-store');
    return getLoopStoreService().store.getRunSummary(loopRunId) != null;
  } catch {
    return true;
  }
}

export class AutomationLoopRunDispatcher {
  private readonly trackedByLoopRunId = new Map<string, { runId: string; automationId: string }>();
  private subscribed = false;
  private readonly limits: AutomationLoopRunLimits;
  private readonly stops: AutomationStopAttempts;

  constructor(private readonly deps: AutomationLoopRunDeps) {
    this.stops = new AutomationStopAttempts(loopId => {
      const tracked = this.stoppingRuns.get(loopId);
      if (tracked) {
        deps.store.recordStopFailure(tracked.runId);
        deps.onStopFailure?.(tracked.runId);
      }
    });
    this.limits = new AutomationLoopRunLimits(deps.now, (loopId, reason, output) => {
      const tracked = this.trackedByLoopRunId.get(loopId);
      if (!tracked) return;
      this.stoppingRuns.set(loopId, tracked);
      const rootId = automationLoopChatId(tracked.automationId, tracked.runId);
      automationInvocations.revoke(rootId);
      this.trackedByLoopRunId.delete(loopId);
      const failed = deps.store.terminalizeRun(tracked.runId, 'failed', reason, output.summary, { now: deps.now(), outputFullRef: output.fullRef });
      if (failed) deps.onTerminal(failed, { retryable: false });
      const cancel = deps.cancelLoop ?? (async id => (await import('../orchestration/loop-coordinator')).getLoopCoordinator().cancelLoop(id));
      this.stops.request(loopId, async () => {
        await Promise.all([automationInvocations.stop(rootId), cancel(loopId)]);
        this.stoppingRuns.delete(loopId);
      });
    }, (runId, instanceId, source, tokens) => deps.store.addProcessedUsage(runId, instanceId, source, tokens));
  }
  private readonly stoppingRuns = new Map<string, { runId: string; automationId: string }>();
  isStoppingAutomation(id: string): boolean { return [...this.stoppingRuns.values()].some(run => run.automationId === id); }
  observeProviderEvent(event: ProviderRuntimeEventEnvelope): void { this.limits.observe(event); }

  /** Re-track a restored running run (app-restart recovery). */
  track(loopRunId: string, run: AutomationRun): void {
    automationInvocations.register(automationLoopChatId(run.automationId, run.id), run.id);
    this.ensureSubscribed();
    this.trackedByLoopRunId.set(loopRunId, { runId: run.id, automationId: run.automationId });
    this.limits.track(loopRunId, run);
  }

  /**
   * Start the loop for a claimed loop-action run. On start the automation run
   * stays `running` until the loop reaches a terminal status; a dispatch
   * failure (WS6 policy refusal, coordinator error) terminalizes immediately.
   */
  async dispatch(claimed: ClaimedAutomationRun, startup?: AutomaticStartup): Promise<void> {
    const run = claimed.run;
    const rootId = automationLoopChatId(run.automationId, run.id);
    automationInvocations.register(rootId, run.id);
    try {
      const prepare = this.deps.prepareConfig ?? (await this.defaultPrepare());
      const startLoop = this.deps.startLoop ?? (await this.defaultStartLoop());
      const prepared = await prepare(buildAutomationLoopConfig(claimed));
      startup?.signal.throwIfAborted();
      this.ensureSubscribed();
      const state = await startLoop(automationLoopChatId(run.automationId, run.id), prepared);
      const attached = this.deps.store.attachLoopRun(run.id, state.id, this.deps.now());
      startup?.register(state, async () => {
        if (startup.signal.reason instanceof AutomationDeadlineCancelledError) {
          const cancel = this.deps.cancelLoop ?? (async id => (await import('../orchestration/loop-coordinator')).getLoopCoordinator().cancelLoop(id));
          await Promise.all([automationInvocations.stop(rootId), cancel(state.id)]);
          return;
        }
        const { getLoopCoordinator } = await import('../orchestration/loop-coordinator');
        await getLoopCoordinator().pauseForGlobalPause(state.id);
      });
      this.track(state.id, { ...run, configSnapshot: claimed.snapshot });
      logger.info('Automation loop started', {
        automationId: run.automationId,
        runId: run.id,
        loopRunId: state.id,
      });
      if (!attached) {
        logger.warn('Automation run vanished while attaching its loop run', { runId: run.id });
      }
    } catch (error) {
      automationInvocations.revoke(rootId);
      if (startup?.signal.aborted || isAutomaticStartupCancelled(error)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      const failed = this.deps.store.terminalizeRun(
        run.id,
        'failed',
        `Loop dispatch failed: ${reason}`,
        undefined,
        this.deps.now(),
      );
      logger.warn('Automation loop dispatch failed', {
        automationId: run.automationId,
        runId: run.id,
        error: reason,
      });
      if (failed) {
        // Config-policy refusals (e.g. missing verify authority) are
        // deterministic — retrying spawns the same refusal.
        this.deps.onTerminal(failed, { retryable: false });
      }
    }
  }

  /** Exposed for direct spec-driving; production flow uses the subscription. */
  handleLoopStateChanged(payload: { loopRunId: string; state: AutomationLoopState }): void {
    if (this.limits.check(payload.loopRunId)) return;
    const tracked = this.trackedByLoopRunId.get(payload.loopRunId);
    const signOff = payload.state.status === 'paused' && payload.state.lastCompletionOutcome === 'unverifiable';
    if (!tracked || (!signOff && !isTerminalLoopRuntimeState({ ...payload.state, endedAt: payload.state.endedAt ?? null }))) {
      return;
    }
    this.trackedByLoopRunId.delete(payload.loopRunId);
    automationInvocations.revoke(automationLoopChatId(tracked.automationId, tracked.runId));
    const output = this.limits.output(payload.loopRunId);
    const monitorOutput = this.limits.monitorOutput(payload.loopRunId);
    const outputFullRef = this.limits.saveOutput(payload.loopRunId);
    this.limits.clear(payload.loopRunId);

    const status = payload.state.status;
    const empty = !output?.trim() && !this.deps.store.getRunFacts(tracked.runId).result;
    const succeeded = SUCCESS_STATUSES.has(status) && !empty;
    const run = this.deps.store.terminalizeRun(
      tracked.runId,
      succeeded ? 'succeeded' : 'failed',
      succeeded ? undefined : SUCCESS_STATUSES.has(status) && empty ? 'No result or assistant text was returned'
        : signOff ? 'Loop paused for sign-off: open the loop to Accept or Resume it' : `Loop ended ${status}`,
      output?.slice(0, 4000) ?? (status === 'completed-needs-review'
        ? 'Loop ended; check its notes.'
        : succeeded ? 'Loop completed.' : undefined),
      { now: this.deps.now(), outputFullRef, monitorOutput },
    );
    if (!run) {
      return;
    }
    logger.info('Automation loop reached terminal status', {
      automationId: tracked.automationId,
      runId: tracked.runId,
      loopRunId: payload.loopRunId,
      loopStatus: status,
      outcome: run.status,
    });
    // A finished loop is a final outcome either way — never auto-retry a whole
    // loop. Failures still feed the automation's auto-disable streak (breaker).
    this.deps.onTerminal(run, { retryable: false });
  }

  private ensureSubscribed(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    const subscribe = this.deps.subscribeLoopStateChanged ?? ((listener) => {
      // Lazy require keeps automations importable without the loop engine
      // (pure store/schedule tests) and avoids eager cycle evaluation.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getLoopCoordinator } = require('../orchestration/loop-coordinator') as typeof import('../orchestration/loop-coordinator');
      getLoopCoordinator().on('loop:state-changed', listener);
    });
    subscribe((payload) => this.handleLoopStateChanged(payload));
  }

  private async defaultPrepare(): Promise<NonNullable<AutomationLoopRunDeps['prepareConfig']>> {
    const { prepareLoopStartConfig } = await import('../orchestration/loop-start-config');
    return prepareLoopStartConfig;
  }

  private async defaultStartLoop(): Promise<NonNullable<AutomationLoopRunDeps['startLoop']>> {
    const { getLoopCoordinator } = await import('../orchestration/loop-coordinator');
    return (chatId, config) => getLoopCoordinator().startLoop(chatId, config);
  }
}
