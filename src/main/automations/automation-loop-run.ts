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

const logger = getLogger('AutomationLoopRun');

/** Loop terminal statuses that count as a successful automation outcome. */
const SUCCESS_STATUSES = new Set<LoopStatus>(['completed', 'completed-needs-review']);
/** All loop terminal statuses (mirrors campaign-loop-status's terminal set). */
const TERMINAL_STATUSES = new Set<LoopStatus>([
  'completed',
  'completed-needs-review',
  'cancelled',
  'failed',
  'error',
  'no-progress',
  'cap-reached',
  'cost-exceeded',
  'needs-human-arbitration',
  'reviewer-unreliable',
  'reviewer-unavailable',
  'builder-unreliable',
]);

export interface AutomationLoopRunStorePort {
  attachLoopRun(runId: string, loopRunId: string, now?: number): AutomationRun | null;
  terminalizeRun(
    runId: string,
    status: Exclude<AutomationRunStatus, 'pending' | 'running'>,
    error?: string,
    outputSummary?: string,
    nowOrOptions?: number | { now?: number },
  ): AutomationRun | null;
}

export interface AutomationLoopRunDeps {
  store: AutomationLoopRunStorePort;
  now: () => number;
  /** Terminal-run hand-off back to the runner (retry/streak/notification seam). */
  onTerminal: (run: AutomationRun, options?: { retryable?: boolean }) => void;
  /** Injectable loop start (defaults to the real coordinator, bound lazily). */
  startLoop?: (chatId: string, config: Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string }) => Promise<{ id: string }>;
  /** Injectable start-config preparation (WS6 gates). */
  prepareConfig?: (
    config: Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string },
  ) => Promise<Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string }>;
  /** Injectable subscription to loop state changes. */
  subscribeLoopStateChanged?: (
    listener: (payload: { loopRunId: string; state: { status: LoopStatus } }) => void,
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
  const loop = action.loop!;
  const base = defaultLoopConfig(action.workingDirectory, action.prompt);
  return {
    ...base,
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
      opts.dispatcher().track(run.loopRunId, run.id, run.automationId);
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

  constructor(private readonly deps: AutomationLoopRunDeps) {}

  /** Re-track a restored running run (app-restart recovery). */
  track(loopRunId: string, runId: string, automationId: string): void {
    this.ensureSubscribed();
    this.trackedByLoopRunId.set(loopRunId, { runId, automationId });
  }

  /**
   * Start the loop for a claimed loop-action run. On start the automation run
   * stays `running` until the loop reaches a terminal status; a dispatch
   * failure (WS6 policy refusal, coordinator error) terminalizes immediately.
   */
  async dispatch(claimed: ClaimedAutomationRun): Promise<void> {
    const run = claimed.run;
    try {
      const prepare = this.deps.prepareConfig ?? (await this.defaultPrepare());
      const startLoop = this.deps.startLoop ?? (await this.defaultStartLoop());
      const prepared = await prepare(buildAutomationLoopConfig(claimed));
      this.ensureSubscribed();
      const state = await startLoop(automationLoopChatId(run.automationId, run.id), prepared);
      this.trackedByLoopRunId.set(state.id, { runId: run.id, automationId: run.automationId });
      const attached = this.deps.store.attachLoopRun(run.id, state.id, this.deps.now());
      logger.info('Automation loop started', {
        automationId: run.automationId,
        runId: run.id,
        loopRunId: state.id,
      });
      if (!attached) {
        logger.warn('Automation run vanished while attaching its loop run', { runId: run.id });
      }
    } catch (error) {
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
  handleLoopStateChanged(payload: { loopRunId: string; state: { status: LoopStatus } }): void {
    const tracked = this.trackedByLoopRunId.get(payload.loopRunId);
    if (!tracked || !TERMINAL_STATUSES.has(payload.state.status)) {
      return;
    }
    this.trackedByLoopRunId.delete(payload.loopRunId);

    const status = payload.state.status;
    const succeeded = SUCCESS_STATUSES.has(status);
    const run = this.deps.store.terminalizeRun(
      tracked.runId,
      succeeded ? 'succeeded' : 'failed',
      succeeded ? undefined : `Loop ended ${status}`,
      status === 'completed-needs-review'
        ? 'Loop completed but flagged items for human review.'
        : succeeded ? 'Loop completed.' : undefined,
      this.deps.now(),
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
