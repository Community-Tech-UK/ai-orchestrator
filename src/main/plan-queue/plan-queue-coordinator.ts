/**
 * PlanQueueCoordinator — works through plan or livetest documents with one
 * visibly-parented worker instance per document, a different-provider verifier
 * per round, and one squash commit per verified item.
 *
 * Deterministic by design: code decides what runs next, whether an item is
 * done and when it lands. LLMs only triage, work and judge, and report through
 * caller-checked MCP tools. See docs/plans/2026-09-18-plan-queue_spec_completed.md.
 *
 * Concurrency: worker slots per run (items holding a worktree), verification
 * slots shared by every run, and one landing at a time (PlanQueueItemFlow).
 */

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_PLAN_QUEUE_CONFIG,
  type PlanQueueAlert,
  type PlanQueueControlPayload,
  type PlanQueueItemState,
  type PlanQueueKind,
  type PlanQueueReportTriageArgs,
  type PlanQueueReportVerdictArgs,
  type PlanQueueRunConfig,
  type PlanQueueRunDto,
  type PlanQueueStateChangedEvent,
} from '@contracts/schemas/plan-queue';
import type { InstanceProvider } from '../../shared/types/instance.types';
import { AUTOMATION_FAILURE_STATUSES } from '../../shared/types/instance-status-policy';
import { getLogger } from '../logging/logger';
import { discoverPlanQueueDocuments } from './plan-queue-discovery';
import { currentBranch, diffStat, repositoryRoot } from './plan-queue-git';
import {
  PlanQueueInstanceTracker,
  type PlanQueueInstanceEventSource,
  type PlanQueueTurnOutcome,
} from './plan-queue-instance-tracker';
import type { PlanQueueFlowHost, PlanQueueInstancePort, PlanQueueRoleRecord } from './plan-queue-host';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import {
  buildQuestionsMessage,
  buildRunSummaryMessage,
  notReadyQuestion,
  runToDto,
  untriagedQuestion,
  withSkipOption,
} from './plan-queue-messages';
import { buildTriagePrompt } from './plan-queue-prompts';
import { reconcilePlanQueueWorktrees } from './plan-queue-reconciler';
import { recoverPlanQueue } from './plan-queue-recovery';
import type { PlanQueueRelaxation } from './plan-queue-relaxation';
import { assertItemTransition, isTerminalItemState, itemHoldsWorktree, newPlanQueueItem } from './plan-queue-state';
import type { PlanQueueStore } from './plan-queue-store';
import { PlanQueueWorktreeService, type PlanQueueWorktreeCreator } from './plan-queue-worktree';
import { selectPlanQueueVerifier, type VerifierSelectInput, type VerifierSelection } from './plan-queue-verifier-select';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

const logger = getLogger('PlanQueueCoordinator');

const DEFAULT_PUMP_INTERVAL_MS = 30_000;
/** Triage attempts before undecided documents are handed to James. */
const MAX_TRIAGE_ATTEMPTS = 2;
const PRE_START_STATES = new Set<PlanQueueItemState>(['discovered', 'needs-answer', 'queued']);

export type PlanQueueInstanceManagerPort = PlanQueueInstancePort & Pick<PlanQueueInstanceEventSource, 'on'>;

export interface PlanQueueCoordinatorDeps {
  store: PlanQueueStore;
  instances: PlanQueueInstanceManagerPort;
  worktreeCreator: PlanQueueWorktreeCreator;
  /** Tests only: skip dependency provisioning in new worktrees. */
  skipInstall?: boolean;
  selectVerifier?: (input: VerifierSelectInput) => Promise<VerifierSelection>;
  /** 1-, 5- and 15-minute load averages. */
  loadAverage?: () => number[];
  relaxation?: PlanQueueRelaxation | null;
  now?: () => number;
  newId?: () => string;
  /** Periodic re-check (load gate, missed events). `null` disables the timer. */
  pumpIntervalMs?: number | null;
}

export interface StartRunInput {
  parentInstanceId: string;
  kind: PlanQueueKind;
  workspaceCwd?: string;
  glob?: string;
  config?: Partial<PlanQueueRunConfig>;
}

export interface StartRunResult {
  run: PlanQueueRunDto;
  /** Documents already owned by another active run. */
  excluded: string[];
}

interface ResolvedDeps {
  store: PlanQueueStore;
  instances: PlanQueueInstanceManagerPort;
  selectVerifier: (input: VerifierSelectInput) => Promise<VerifierSelection>;
  loadAverage: () => number[];
  relaxation: PlanQueueRelaxation | null;
  now: () => number;
  newId: () => string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PlanQueueCoordinator extends EventEmitter implements PlanQueueFlowHost {
  private static instance: PlanQueueCoordinator | null = null;

  private deps: ResolvedDeps | null = null;
  private flow: PlanQueueItemFlow | null = null;
  private trackerInstance: PlanQueueInstanceTracker | null = null;
  private worktreeService: PlanQueueWorktreeService | null = null;
  private readonly roles = new Map<string, PlanQueueRoleRecord>();
  /** runId → triage instance id, or 'starting' while it spawns. */
  private readonly triageByRun = new Map<string, string>();
  private readonly triageAttempts = new Map<string, number>();
  private alerts: PlanQueueAlert[] = [];
  private pumping = false;
  private pumpAgain = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  static getInstance(): PlanQueueCoordinator {
    if (!PlanQueueCoordinator.instance) PlanQueueCoordinator.instance = new PlanQueueCoordinator();
    return PlanQueueCoordinator.instance;
  }

  static _resetForTesting(): void {
    PlanQueueCoordinator.instance?.shutdown();
    PlanQueueCoordinator.instance = null;
  }

  initialize(deps: PlanQueueCoordinatorDeps): void {
    if (this.deps) return;
    this.deps = {
      store: deps.store,
      instances: deps.instances,
      selectVerifier: deps.selectVerifier ?? ((input) => selectPlanQueueVerifier(input)),
      loadAverage: deps.loadAverage ?? (() => os.loadavg()),
      relaxation: deps.relaxation ?? null,
      now: deps.now ?? Date.now,
      newId: deps.newId ?? randomUUID,
    };
    this.worktreeService = new PlanQueueWorktreeService({
      creator: deps.worktreeCreator,
      saveItem: (item) => { this.save(item); },
      skipInstall: deps.skipInstall,
    });
    this.trackerInstance = new PlanQueueInstanceTracker(
      deps.instances as unknown as PlanQueueInstanceEventSource,
      (instanceId, outcome) => { void this.routeOutcome(instanceId, outcome); },
    );
    this.trackerInstance.attach();
    this.flow = new PlanQueueItemFlow(this);
    const interval = deps.pumpIntervalMs === undefined ? DEFAULT_PUMP_INTERVAL_MS : deps.pumpIntervalMs;
    if (interval !== null) {
      this.timer = setInterval(() => this.requestPump(), interval);
      this.timer.unref?.();
    }
    logger.info('PlanQueueCoordinator initialized');
  }

  isInitialized(): boolean {
    return this.deps !== null;
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Tests only: wait for in-flight item operations, landings and scheduler passes. */
  async _whenSettledForTesting(): Promise<void> {
    for (let pass = 0; pass < 20; pass += 1) {
      await this.flow?.whenSettled();
      await new Promise((resolve) => setImmediate(resolve));
      if (!this.pumping) return;
    }
  }

  // ---------------------------------------------------------------------------
  // PlanQueueFlowHost
  // ---------------------------------------------------------------------------

  get instances(): PlanQueueInstancePort { return this.requireDeps().instances; }
  get worktrees(): PlanQueueWorktreeService { return this.require(this.worktreeService); }
  get tracker(): PlanQueueInstanceTracker { return this.require(this.trackerInstance); }
  get store(): PlanQueueStore { return this.requireDeps().store; }

  selectVerifier(input: VerifierSelectInput): Promise<VerifierSelection> {
    return this.requireDeps().selectVerifier(input);
  }

  getRun(runId: string): PlanQueueRun {
    const run = this.requireDeps().store.getRun(runId);
    if (!run) throw new Error(`Plan queue run not found: ${runId}`);
    return run;
  }

  getItem(itemId: string): PlanQueueItem {
    const item = this.requireDeps().store.getItem(itemId);
    if (!item) throw new Error(`Plan queue item not found: ${itemId}`);
    return item;
  }

  save(item: PlanQueueItem): PlanQueueItem {
    const saved = { ...item, updatedAt: this.requireDeps().now() };
    this.requireDeps().store.upsertItem(saved);
    this.announce({ runId: saved.runId, itemId: saved.id });
    return saved;
  }

  transition(item: PlanQueueItem, to: PlanQueueItemState, patch: Partial<PlanQueueItem> = {}): PlanQueueItem {
    assertItemTransition(item.state, to);
    return this.save({ ...item, ...patch, state: to });
  }

  registerRole(instanceId: string, record: PlanQueueRoleRecord): void { this.roles.set(instanceId, record); }
  unregisterRole(instanceId: string): void { this.roles.delete(instanceId); }
  roleOf(instanceId: string): PlanQueueRoleRecord | undefined { return this.roles.get(instanceId); }

  notifyParent(run: PlanQueueRun, message: string): void {
    const parent = this.instances.getInstance(run.parentInstanceId);
    if (!parent || AUTOMATION_FAILURE_STATUSES.has(parent.status)) return;
    const options = { automatedInput: true, internalSource: 'plan-queue' as const };
    void this.instances.sendInput(run.parentInstanceId, message, undefined, options).catch((error: unknown) => {
      logger.warn('Plan queue: could not message the parent session', { runId: run.id, error: errorMessage(error) });
    });
  }

  requestPump(): void {
    if (!this.deps) return;
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    void this.pump()
      .catch((error: unknown) => logger.error('Plan queue scheduler pass failed', error instanceof Error ? error : undefined))
      .finally(() => {
        this.pumping = false;
        if (this.pumpAgain) {
          this.pumpAgain = false;
          this.requestPump();
        }
      });
  }

  // ---------------------------------------------------------------------------
  // Public API (MCP tools and IPC)
  // ---------------------------------------------------------------------------

  async startRun(input: StartRunInput): Promise<StartRunResult> {
    const deps = this.requireDeps();
    const parent = deps.instances.getInstance(input.parentInstanceId);
    if (!parent) throw new Error(`Parent session not found: ${input.parentInstanceId}`);
    if (this.isQueueInstance(input.parentInstanceId)) {
      throw new Error('A Plan Queue worker, verifier or triage session cannot start another queue run');
    }
    const repoRoot = await repositoryRoot(input.workspaceCwd ?? parent.workingDirectory ?? process.cwd());
    const baseBranch = await currentBranch(repoRoot);
    if (!baseBranch) throw new Error(`${repoRoot} is not on a branch; the queue lands work on the checked-out branch`);

    const config: PlanQueueRunConfig = { ...DEFAULT_PLAN_QUEUE_CONFIG[input.kind], ...input.config, baseBranch };
    const documents = await discoverPlanQueueDocuments(repoRoot, input.kind, input.glob);
    // No await from here until the items are written: reading the owned set and
    // claiming documents is atomic on the main thread, so two concurrent starts
    // cannot both claim one document.
    const owned = this.documentsOwnedByActiveRuns();
    const excluded = documents.filter((doc) => owned.has(doc.path)).map((doc) => doc.path);

    const now = deps.now();
    const run: PlanQueueRun = {
      id: deps.newId(),
      parentInstanceId: input.parentInstanceId,
      kind: input.kind,
      workspaceCwd: repoRoot,
      status: 'running',
      config,
      relaxation: null,
      workerProvider: parent.provider && parent.provider !== 'auto' ? parent.provider : null,
      workerModel: parent.currentModel ?? null,
      startedAt: now,
      endedAt: null,
    };
    deps.store.upsertRun(run);
    if (config.relaxSettings) this.applyRelaxation(run);

    documents.filter((doc) => !owned.has(doc.path)).forEach((doc, index) => {
      // createdAt carries discovery order: items list in the order they were found.
      deps.store.upsertItem(newPlanQueueItem(deps.newId(), run.id, doc.path, now + index, doc.readiness === 'candidate'
        ? { state: 'discovered' }
        : { state: 'needs-answer', question: notReadyQuestion(doc.path, doc.reason ?? 'not ready') }));
    });
    const items = deps.store.listItems(run.id);
    const questions = items.filter((item) => item.state === 'needs-answer');
    if (questions.length) this.notifyParent(run, buildQuestionsMessage(questions));
    logger.info('Plan queue run started', { runId: run.id, kind: run.kind, items: items.length, excluded: excluded.length });
    this.announce({ runId: run.id });
    this.requestPump();
    return { run: runToDto(this.getRun(run.id), items), excluded };
  }

  getRunDto(runId: string): PlanQueueRunDto | null {
    const run = this.requireDeps().store.getRun(runId);
    return run ? runToDto(run, this.requireDeps().store.listItems(run.id)) : null;
  }

  listRunDtos(limit = 20): PlanQueueRunDto[] {
    const store = this.requireDeps().store;
    return store.listRuns(limit).map((run) => runToDto(run, store.listItems(run.id)));
  }

  getAlerts(): PlanQueueAlert[] {
    return [...this.alerts];
  }

  async refreshAlerts(): Promise<PlanQueueAlert[]> {
    const store = this.requireDeps().store;
    this.alerts = await reconcilePlanQueueWorktrees(store.listWorkspaceRoots(), store.listItemsWithGitOwnership());
    return this.getAlerts();
  }

  /** `git diff --shortstat` of an item's branch against its run's base branch. */
  async diffstat(itemId: string): Promise<string> {
    const item = this.getItem(itemId);
    const run = this.getRun(item.runId);
    if (!item.branchName || !run.config.baseBranch) return '';
    return diffStat(run.workspaceCwd, run.config.baseBranch, item.branchName);
  }

  /** True for any instance the queue spawned (by role, or by provenance after a restart). */
  isQueueInstance(instanceId: string): boolean {
    if (this.roles.has(instanceId)) return true;
    return typeof this.deps?.instances.getInstance(instanceId)?.metadata?.['planQueueRole'] === 'string';
  }

  /** @param callerInstanceId set for MCP callers, who must be the run's parent session. */
  async answer(itemId: string, optionId: string, callerInstanceId?: string): Promise<void> {
    const item = this.getItem(itemId);
    const run = this.getRun(item.runId);
    this.assertParent(run, callerInstanceId);
    const option = item.question?.options.find((candidate) => candidate.id === optionId);
    if (!item.question || !option) throw new Error(`Item ${itemId} has no open question with option "${optionId}"`);

    if (item.state === 'needs-answer') {
      const answer = `${item.question.question} → ${option.label}`;
      if (optionId === 'skip') {
        this.transition(item, 'skipped', { question: null, answer, detail: 'James chose to leave this document for now.' });
      } else {
        this.transition(item, 'queued', { question: null, answer });
      }
      this.requestPump();
      return;
    }
    if (item.state === 'working' || item.state === 'fixing') {
      await this.requireFlow().answerWorker(item.id, optionId);
      return;
    }
    throw new Error(`Item ${itemId} is ${item.state}; there is nothing to answer`);
  }

  async control(payload: PlanQueueControlPayload, callerInstanceId?: string): Promise<void> {
    const flow = this.requireFlow();
    if ('runId' in payload) {
      const run = this.getRun(payload.runId);
      this.assertParent(run, callerInstanceId);
      if (payload.action === 'pause' && run.status === 'running') this.saveRun({ ...run, status: 'paused' });
      else if (payload.action === 'resume' && run.status === 'paused') this.saveRun({ ...run, status: 'running' });
      else if (payload.action === 'cancel') await this.cancelRun(run);
      this.requestPump();
      return;
    }

    const item = this.getItem(payload.itemId);
    const run = this.getRun(item.runId);
    this.assertParent(run, callerInstanceId);
    switch (payload.action) {
      case 'skip-item':
        if (!PRE_START_STATES.has(item.state)) throw new Error(`Item is ${item.state}; only an item that has not started can be skipped`);
        this.transition(item, 'skipped', { question: null, detail: 'Skipped by James.' });
        break;
      case 'resume-item':
        this.transition(item, 'queued', { parkReason: null, detail: null, round: 0, erroredRounds: 0, landingRefusals: 0, question: null });
        this.reopen(run);
        break;
      case 'land-anyway':
        // Landing can send the item back to a worker (a conflict or a failed
        // gate), which only the scheduler of an open run picks up.
        this.reopen(run);
        await flow.landAnyway(item.id);
        break;
      case 'discard-item':
        await flow.discard(item.id);
        break;
    }
    this.requestPump();
  }

  reportVerdict(callerInstanceId: string, args: PlanQueueReportVerdictArgs): { accepted: true; message: string } {
    const item = this.getItem(args.item_id);
    if (item.state !== 'verifying' || item.verifierInstanceId !== callerInstanceId) {
      throw new Error('Only the verifier currently assigned to this item may report its verdict');
    }
    this.requireFlow().recordVerdict(item, callerInstanceId, {
      verdict: args.verdict,
      findings: args.findings,
      gatesRun: args.gates_run,
      documentComplete: args.document_complete,
      needJames: args.need_james,
    });
    return { accepted: true, message: 'Verdict recorded. End your turn now; the coordinator acts on it when you stop.' };
  }

  reportTriage(callerInstanceId: string, args: PlanQueueReportTriageArgs): { applied: number; unmatched: string[] } {
    const run = this.getRun(args.run_id);
    if (this.triageByRun.get(run.id) !== callerInstanceId) {
      throw new Error('Only the triage agent for this run may report triage');
    }
    const byPath = new Map(this.requireDeps().store.listItems(run.id).map((item) => [path.resolve(item.documentPath), item]));
    const unmatched: string[] = [];
    let applied = 0;
    for (const record of args.records) {
      const item = byPath.get(path.resolve(run.workspaceCwd, record.documentPath));
      if (!item || item.state !== 'discovered') {
        unmatched.push(record.documentPath);
        continue;
      }
      if (record.disposition === 'ready') this.transition(item, 'queued');
      else if (record.disposition === 'skip') this.transition(item, 'skipped', { detail: record.reason });
      else this.transition(item, 'needs-answer', { question: withSkipOption(record.question) });
      applied += 1;
    }
    const questions = this.requireDeps().store.listItems(run.id).filter((item) => item.state === 'needs-answer' && item.question);
    if (args.records.some((record) => record.disposition === 'needs-answer') && questions.length) {
      this.notifyParent(run, buildQuestionsMessage(questions));
    }
    this.requestPump();
    return { applied, unmatched };
  }

  // ---------------------------------------------------------------------------
  // Boot recovery
  // ---------------------------------------------------------------------------

  /** Boot recovery; see plan-queue-recovery.ts. */
  async recover(): Promise<void> {
    await recoverPlanQueue(this, this.requireFlow());
    this.requestPump();
  }

  // ---------------------------------------------------------------------------
  // Scheduler
  // ---------------------------------------------------------------------------

  private async pump(): Promise<void> {
    const deps = this.requireDeps();
    const flow = this.requireFlow();
    const runs = deps.store.listActiveRuns();
    const [oneMinute = 0, fiveMinute = 0] = deps.loadAverage();
    // Verification slots are shared by every run (the full gate list is the
    // expensive part): the total is bounded by the largest cap among active
    // runs, and each run is also held to its own cap. Comparing the shared
    // count with one run's smaller cap would starve that run.
    const sharedCap = Math.max(0, ...runs.map((run) => run.config.verificationSlots));
    let verifying = runs.flatMap((run) => deps.store.listItems(run.id)).filter((item) => item.state === 'verifying').length;

    for (const run of runs) {
      const items = deps.store.listItems(run.id);
      if (run.status === 'running') {
        this.maybeStartTriage(run, items);
        const overloaded = oneMinute > run.config.maxLoadAverage || fiveMinute > run.config.maxLoadAverage;
        if (!overloaded) {
          let inFlight = items.filter((item) => itemHoldsWorktree(item.state)).length;
          for (const item of items.filter((candidate) => candidate.state === 'queued')) {
            if (inFlight >= run.config.workerSlots) break;
            inFlight += 1;
            void flow.startItem(item).catch((error: unknown) => this.logItemError(item, error));
          }
          let runVerifying = items.filter((item) => item.state === 'verifying').length;
          for (const item of items.filter((candidate) => candidate.state === 'awaiting-slot')) {
            if (verifying >= sharedCap || runVerifying >= run.config.verificationSlots) break;
            verifying += 1;
            runVerifying += 1;
            void flow.startVerification(item).catch((error: unknown) => this.logItemError(item, error));
          }
        }
      }
      // A run with no items at all is also finished.
      if (deps.store.listItems(run.id).every((item) => isTerminalItemState(item.state))) {
        this.finishRun(this.getRun(run.id), 'completed');
      }
    }
  }

  private maybeStartTriage(run: PlanQueueRun, items: readonly PlanQueueItem[]): void {
    const undecided = items.filter((item) => item.state === 'discovered');
    if (undecided.length === 0 || this.triageByRun.has(run.id)) return;
    const attempts = this.triageAttempts.get(run.id) ?? 0;
    if (attempts >= MAX_TRIAGE_ATTEMPTS) {
      for (const item of undecided) this.transition(item, 'needs-answer', { question: untriagedQuestion(item.documentPath) });
      this.notifyParent(run, buildQuestionsMessage(this.requireDeps().store.listItems(run.id).filter((i) => i.state === 'needs-answer')));
      return;
    }
    this.triageAttempts.set(run.id, attempts + 1);
    this.triageByRun.set(run.id, 'starting');
    void this.instances.createInstance({
      displayName: 'Queue triage',
      isRenamed: true,
      parentId: this.requireFlow().liveParentId(run),
      workingDirectory: run.workspaceCwd,
      initialPrompt: buildTriagePrompt(run.id, undecided.map((item) => item.documentPath)),
      ...(run.workerProvider ? { provider: run.workerProvider as InstanceProvider } : {}),
      ...(run.workerModel ? { modelOverride: run.workerModel } : {}),
      yoloMode: true,
      metadata: { planQueueRunId: run.id, planQueueRole: 'triage' },
    }).then((instance) => {
      this.triageByRun.set(run.id, instance.id);
      this.registerRole(instance.id, { role: 'triage', runId: run.id });
      this.tracker.track(instance.id);
    }).catch((error: unknown) => {
      logger.warn('Plan queue: triage failed to start', { runId: run.id, error: errorMessage(error) });
      this.triageByRun.delete(run.id);
      this.requestPump();
    });
  }

  private async routeOutcome(instanceId: string, outcome: PlanQueueTurnOutcome): Promise<void> {
    const role = this.roles.get(instanceId);
    if (!role) return;
    try {
      if (role.role === 'worker') await this.requireFlow().onWorkerOutcome(instanceId, outcome);
      else if (role.role === 'verifier') await this.requireFlow().onVerifierOutcome(instanceId, outcome);
      else this.onTriageOutcome(instanceId, role.runId);
    } catch (error) {
      logger.error('Plan queue: handling an instance outcome failed', error instanceof Error ? error : undefined, {
        instanceId,
        role: role.role,
        outcome: outcome.kind,
      });
    }
  }

  /** Whatever the triage agent did or did not report, its turn is over. */
  private onTriageOutcome(instanceId: string, runId: string): void {
    this.requireFlow().retireInstance(instanceId);
    if (this.triageByRun.get(runId) === instanceId) this.triageByRun.delete(runId);
    this.requestPump();
  }

  // ---------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------

  private async cancelRun(run: PlanQueueRun): Promise<void> {
    const flow = this.requireFlow();
    // Stop the scheduler first: parking below awaits, and a pump in between
    // must not start the next queued item.
    if (run.status === 'running') this.saveRun({ ...run, status: 'paused' });
    for (const { id } of this.requireDeps().store.listItems(run.id)) {
      const item = this.getItem(id);
      if (PRE_START_STATES.has(item.state)) {
        this.transition(item, 'skipped', { question: null, detail: 'Run cancelled by James.' });
      } else if (!isTerminalItemState(item.state)) {
        await flow.park(item.id, 'cancelled', 'Run cancelled by James.');
      }
    }
    this.finishRun(this.getRun(run.id), 'cancelled');
  }

  private finishRun(run: PlanQueueRun, status: 'completed' | 'cancelled'): void {
    if (run.status === 'completed' || run.status === 'cancelled') return;
    const triage = this.triageByRun.get(run.id);
    if (triage && triage !== 'starting') this.requireFlow().retireInstance(triage);
    this.triageByRun.delete(run.id);
    this.triageAttempts.delete(run.id);
    const ended = this.releaseRelaxation({ ...run, status, endedAt: this.requireDeps().now() });
    this.saveRun(ended);
    this.notifyParent(ended, buildRunSummaryMessage(ended, this.requireDeps().store.listItems(run.id)));
    logger.info('Plan queue run ended', { runId: run.id, status });
  }

  /** A resumed item re-opens a finished run so the scheduler picks it up. */
  private reopen(run: PlanQueueRun): void {
    if (run.status === 'completed' || run.status === 'cancelled') {
      const reopened = this.saveRun({ ...run, status: 'running', endedAt: null });
      if (reopened.config.relaxSettings) this.applyRelaxation(reopened);
    }
  }

  private saveRun(run: PlanQueueRun): PlanQueueRun {
    this.requireDeps().store.upsertRun(run);
    this.announce({ runId: run.id });
    return run;
  }

  /**
   * Snapshot, persist, then apply this run's relaxed settings.
   *
   * Exactly one active run holds the snapshot of the true originals. A run that
   * starts while another relaxed run is active shares the settings already in
   * force rather than snapshotting them (its snapshot would record the relaxed
   * values as "originals"); `releaseRelaxation` hands the snapshot over when
   * the holder ends first.
   */
  applyRelaxation(run: PlanQueueRun): void {
    const relaxation = this.requireDeps().relaxation;
    if (!relaxation || run.relaxation) return;
    if (this.relaxationHolder(run.id)) return;
    const snapshot = relaxation.plan();
    // Persist the snapshot BEFORE writing any setting, so a crash in between
    // still leaves the originals recoverable on the next boot.
    this.saveRun({ ...run, relaxation: snapshot });
    relaxation.apply(snapshot);
  }

  /**
   * A run with relaxed settings is ending: if another active run still wants
   * them, hand it the snapshot and leave the settings in force; otherwise
   * restore them.
   */
  private releaseRelaxation(run: PlanQueueRun): PlanQueueRun {
    if (!run.relaxation) return run;
    const heir = this.requireDeps().store.listActiveRuns()
      .find((other) => other.id !== run.id && other.config.relaxSettings);
    if (!heir) return this.restoreRelaxation(run);
    this.saveRun({ ...heir, relaxation: run.relaxation });
    return this.saveRun({ ...run, relaxation: null });
  }

  private relaxationHolder(exceptRunId: string): PlanQueueRun | undefined {
    return this.requireDeps().store.listActiveRuns()
      .find((other) => other.id !== exceptRunId && other.relaxation !== null);
  }

  /** Put back this run's relaxed settings and clear its snapshot (run end, and every boot). */
  restoreRelaxation(run: PlanQueueRun): PlanQueueRun {
    const relaxation = this.requireDeps().relaxation;
    if (!run.relaxation) return run;
    if (relaxation) relaxation.restore(run.relaxation);
    return this.saveRun({ ...run, relaxation: null });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private documentsOwnedByActiveRuns(): Set<string> {
    const store = this.requireDeps().store;
    return new Set(
      store.listActiveRuns()
        .flatMap((run) => store.listItems(run.id))
        .filter((item) => !isTerminalItemState(item.state) || (item.worktreePath !== null && existsSync(item.worktreePath)))
        .map((item) => item.documentPath),
    );
  }

  private assertParent(run: PlanQueueRun, callerInstanceId: string | undefined): void {
    if (callerInstanceId !== undefined && callerInstanceId !== run.parentInstanceId) {
      throw new Error('Only the session that started this Plan Queue run may do that');
    }
  }

  private logItemError(item: PlanQueueItem, error: unknown): void {
    logger.error('Plan queue item step failed', error instanceof Error ? error : undefined, { itemId: item.id });
  }

  private announce(event: PlanQueueStateChangedEvent): void {
    this.emit('state-changed', event);
  }

  private requireDeps(): ResolvedDeps {
    if (!this.deps) throw new Error('PlanQueueCoordinator has not been initialized');
    return this.deps;
  }

  private requireFlow(): PlanQueueItemFlow {
    return this.require(this.flow);
  }

  private require<T>(value: T | null): T {
    if (value === null) throw new Error('PlanQueueCoordinator has not been initialized');
    return value;
  }
}

export function getPlanQueueCoordinator(): PlanQueueCoordinator {
  return PlanQueueCoordinator.getInstance();
}
