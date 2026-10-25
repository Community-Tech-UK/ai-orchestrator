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
import { getLogger } from '../logging/logger';
import { getWorkAdmission } from '../work-admission/work-admission';
import { pumpPlanQueue } from './plan-queue-pump';
import { assertPlanQueueParent, authorizePlanQueueControl } from './plan-queue-control-authority';
import { adoptRunParent } from './plan-queue-run-parent';
import { PlanQueueParentMessenger } from './plan-queue-parent-messenger';
import { discoverPlanQueueDocuments } from './plan-queue-discovery';
import { currentBranch, diffStat, repositoryRoot } from './plan-queue-git';
import {
  PlanQueueInstanceTracker,
  type PlanQueueInstanceEventSource,
  type PlanQueueTurnOutcome,
} from './plan-queue-instance-tracker';
import type { PlanQueueFlowHost, PlanQueueInstancePort, PlanQueueRoleRecord, PlanQueueSessionTreePort } from './plan-queue-host';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import { hasPendingLandingCleanup } from './plan-queue-item-landing';
import { spawnQueueInstance } from './plan-queue-spawn';
import { PlanQueueRunControl } from './plan-queue-run-control';
import { buildRunSummaryMessage, runToDto } from './plan-queue-messages';
import { PlanQueueParentTracker } from './plan-queue-parent';
import { PlanQueueTriage } from './plan-queue-triage';
import { PlanQueueUserClose } from './plan-queue-user-close';
import { reconcilePlanQueueWorktrees } from './plan-queue-reconciler';
import { recoverInterruptedDocumentMerges, recoverPlanQueue } from './plan-queue-recovery';
import { applyTriageRecords, PRE_START_STATES, reconcileWaitingDocuments } from './plan-queue-readiness';
import type { PlanQueueRelaxation } from './plan-queue-relaxation';
import { resolveRunRouting, type PlanQueueRoutingDeps, type PlanQueueRoutingOverride } from './plan-queue-routing';
import { assertItemTransition, isTerminalItemState, itemHoldsWorktree, newPlanQueueItem } from './plan-queue-state';
import type { PlanQueueStore } from './plan-queue-store';
import { PlanQueueWorktreeService, type PlanQueueWorktreeCreator } from './plan-queue-worktree';
import { selectPlanQueueVerifier, type VerifierSelectInput, type VerifierSelection } from './plan-queue-verifier-select';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
const logger = getLogger('PlanQueueCoordinator');
const DEFAULT_PUMP_INTERVAL_MS = 30_000;
export type PlanQueueInstanceManagerPort = PlanQueueInstancePort & PlanQueueSessionTreePort & Pick<PlanQueueInstanceEventSource, 'on'>;
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
  /** Saved routing and account lists; defaults to the settings manager. */
  routing?: PlanQueueRoutingDeps;
  now?: () => number;
  newId?: () => string;
  /** Periodic re-check (load gate, missed events). `null` disables the timer. */
  pumpIntervalMs?: number | null;
  /** Wait until orchestrator-tools is listening before queue spawns (LT-700). */
  whenOrchestratorToolsListening?: () => Promise<void>;
  /** The live session restored from a gone parent's conversation; see plan-queue-parent.ts. */
  findRestoredSession?: (instanceId: string) => string | undefined;
}
export interface StartRunInput {
  parentInstanceId: string;
  kind: PlanQueueKind;
  workspaceCwd?: string;
  glob?: string;
  config?: Partial<PlanQueueRunConfig>;
  /** Per-run provider/account choices (`plan_queue_start`); else the saved choice. */
  routing?: PlanQueueRoutingOverride;
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
  routing: PlanQueueRoutingDeps | undefined;
  now: () => number;
  newId: () => string;
}


export class PlanQueueCoordinator extends EventEmitter implements PlanQueueFlowHost {
  private static instance: PlanQueueCoordinator | null = null;
  private deps: ResolvedDeps | null = null;
  private flow: PlanQueueItemFlow | null = null;
  private parentMessenger: PlanQueueParentMessenger | null = null;
  private trackerInstance: PlanQueueInstanceTracker | null = null;
  private worktreeService: PlanQueueWorktreeService | null = null;
  private parents: PlanQueueParentTracker | null = null;
  private readonly roles = new Map<string, PlanQueueRoleRecord>();
  private triage: PlanQueueTriage | null = null;
  private alerts: PlanQueueAlert[] = [];
  private pumping = false;
  private pumpAgain = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private whenOrchestratorToolsListening: () => Promise<void> = () => Promise.resolve();
  private toolsReady: Promise<void> | null = null;
  private userCloseEpoch = 0;
  private admissionCleanup: (() => void)[] = [];
  private readonly runControl = new PlanQueueRunControl();
  private readonly userClose = new PlanQueueUserClose(() => this.requireDeps().now());
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
      routing: deps.routing,
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
    this.whenOrchestratorToolsListening = deps.whenOrchestratorToolsListening ?? (() => Promise.resolve());
    this.parentMessenger = new PlanQueueParentMessenger({
      instances: this.instances, isQueueInstance: (id) => this.isQueueInstance(id),
      getRun: (id) => this.getRun(id),
      setParent: (runId, parentInstanceId, parentHistoryThreadId) => {
        this.requireDeps().store.setRunParent(runId, parentInstanceId, parentHistoryThreadId);
        this.announce({ runId });
      },
      listItems: (id) => this.store.listItems(id),
    });
    this.flow = new PlanQueueItemFlow(this);
    this.parents = new PlanQueueParentTracker({
      instances: deps.instances,
      findRestoredSession: deps.findRestoredSession,
      // Ownership writes also tell the messenger, so questions waiting at a
      // takeover are replayed to the restored parent however it was found.
      store: {
        getRun: (id) => deps.store.getRun(id),
        listActiveRuns: () => deps.store.listActiveRuns(),
        setRunParent: (runId, parentInstanceId, parentHistoryThreadId) => {
          const changed = deps.store.getRun(runId)?.parentInstanceId !== parentInstanceId;
          deps.store.setRunParent(runId, parentInstanceId, parentHistoryThreadId);
          const run = changed ? deps.store.getRun(runId) : null;
          if (run) this.parentMessenger?.onParentChanged(run);
        },
      },
      announce: (runId) => this.announce({ runId }),
    });
    deps.instances.on('instance:event', ({ event }) => { if (event.kind === 'created' || (event.kind === 'status_changed' && event.status === 'superseded')) this.parents?.followActiveRuns(); });
    this.triage = new PlanQueueTriage({
      instances: this.instances, tracker: this.tracker,
      getItem: (id) => this.getItem(id), getRun: (id) => this.getRun(id),
      selectVerifier: (input) => this.selectVerifier(input), now: () => this.requireDeps().now(),
      transition: (item, to, patch) => this.transition(item, to, patch),
      registerRole: (id, role) => this.registerRole(id, role),
      requestPump: () => this.requestPump(),
      consumeUserClose: (id) => this.consumeUserClose(id),
      liveParentId: (run) => this.requireFlow().liveParentId(run),
      retireInstance: (id) => this.requireFlow().stopInstance(id),
    });
    const interval = deps.pumpIntervalMs === undefined ? DEFAULT_PUMP_INTERVAL_MS : deps.pumpIntervalMs;
    if (interval !== null) {
      this.timer = setInterval(() => this.requestPump(), interval);
      this.timer.unref?.();
    }
    const admission = getWorkAdmission();
    const repump = (): void => this.requestPump();
    admission.on('admission-changed', repump);
    this.admissionCleanup.push(() => admission.off('admission-changed', repump));
    for (const [kind, state] of [['queue-job', 'working'], ['queue-check', 'verifying']] as const) {
      this.admissionCleanup.push(admission.registerCounter(kind, () => deps.store.listActiveRuns().flatMap(run => deps.store.listItems(run.id)).filter(item => state === 'working' ? itemHoldsWorktree(item.state) : item.state === state).length));
    }
    logger.info('PlanQueueCoordinator initialized');
  }
  isInitialized(): boolean {
    return this.deps !== null;
  }
  noteUserClosing(ids: readonly string[], scope: 'one' | 'all'): number {
    this.userClose.note(ids);
    if (scope === 'all') this.userCloseEpoch += 1;
    const running = scope === 'all' ? this.store.listActiveRuns().filter(run => run.status === 'running') : [];
    for (const run of running) this.saveRun({ ...run, status: 'paused' });
    return running.length;
  }
  consumeUserClose(id: string): boolean { return this.userClose.consume(id); }
  shutdown(): void {
    this.admissionCleanup.splice(0).forEach(cleanup => cleanup());
    this.trackerInstance?.noteAppShutdown();
    this.parentMessenger?.shutdown();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  /** Tests only: wait for in-flight item operations, landings and scheduler passes. */
  async _whenSettledForTesting(): Promise<void> {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await this.flow?.whenSettled();
      if (!this.pumping) return;
    }
  }
  // ---------------------------------------------------------------------------
  // PlanQueueFlowHost
  // ---------------------------------------------------------------------------
  get instances(): PlanQueueInstancePort {
    const inner = this.requireDeps().instances;
    const ready = (this.toolsReady ??= this.whenOrchestratorToolsListening());
    return {
      createInstance: (config) => spawnQueueInstance(config, {
        ready, instances: inner, getRun: (id) => this.store.getRun(id),
        isShuttingDown: () => this.tracker.isShuttingDown(), userCloseEpoch: () => this.userCloseEpoch,
        isProviderExcluded: this.requireDeps().routing?.isProviderExcluded,
      }),
      sendInput: (instanceId, message, attachments, options) => inner.sendInput(instanceId, message, attachments, options),
      terminateInstance: (instanceId, graceful) => inner.terminateInstance(instanceId, graceful),
      getInstance: (instanceId) => inner.getInstance(instanceId),
      getAllInstances: () => inner.getAllInstances(),
    };
  }
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
  notifyParent(run: PlanQueueRun, message: string, questions?: readonly PlanQueueItem[]): void {
    this.require(this.parentMessenger).notify(run, message, questions);
  }
  /** The run's parent session, followed across a restart; undefined while it is gone. */
  liveParentId(run: PlanQueueRun): string | undefined { return this.require(this.parents).liveParentId(run); }
  resolveRunParent(run: PlanQueueRun): string | undefined {
    return this.require(this.parentMessenger).resolve(run);
  }
  requestPump(): void {
    if (!this.deps || this.trackerInstance?.isShuttingDown()) return;
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

    // Fixed now, validated now: a choice the queue cannot honour refuses the run.
    const routing = resolveRunRouting(parent, { ...input.routing, relaxExclusions: input.config?.relaxSettings === true, workspaceCwd: repoRoot }, deps.routing);
    const config: PlanQueueRunConfig = { ...DEFAULT_PLAN_QUEUE_CONFIG[input.kind], ...input.config, baseBranch, routing, startingSessionRoute: { provider: parent.provider, currentModel: parent.currentModel, accountProfileId: parent.accountProfileId, copilotAccountProfileId: parent.copilotAccountProfileId } };
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
      parentHistoryThreadId: parent.historyThreadId?.trim() || null,
      kind: input.kind,
      workspaceCwd: repoRoot,
      status: 'running',
      config,
      relaxation: null,
      workerProvider: routing.worker?.provider ?? null,
      workerModel: routing.worker?.model ?? null,
      startedAt: now,
      endedAt: null,
    };
    deps.store.upsertRun(run);
    if (config.relaxSettings) this.applyRelaxation(run);
    documents.filter((doc) => !owned.has(doc.path)).forEach((doc, index) => {
      // createdAt carries discovery order: items list in the order they were found.
      // An unplanned spec must stay open: its required planning rename would
      // invalidate this item's path. Implementation belongs to its linked plan.
      const needsPlan = doc.readiness === 'not-ready' && doc.path.toLowerCase().endsWith('_spec.md');
      deps.store.upsertItem(newPlanQueueItem(deps.newId(), run.id, doc.path, now + index, {
        state: needsPlan ? 'skipped' : 'discovered',
        detail: needsPlan ? 'No implementation plan exists. The spec remains open; create and link a plan in a planning task, then queue that plan.' : doc.reason ?? null,
      }));
    });
    const items = deps.store.listItems(run.id);
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
    return store.listRunSnapshots(limit).map(({ run, items }) => runToDto(run, items));
  }

  getAlerts(): PlanQueueAlert[] { return [...this.alerts]; }

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
    const run = this.require(this.parents).follow(this.getRun(item.runId));
    this.resolveRunParent(run);
    assertPlanQueueParent(run, callerInstanceId);
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
  async pauseRunsForGlobalPause(): Promise<string[]> {
    const ids = this.store.listActiveRuns().filter(run => run.status === 'running').map(run => run.id);
    for (const runId of ids) await this.control({ action: 'pause', runId });
    return ids;
  }
  async control(payload: PlanQueueControlPayload, callerInstanceId?: string): Promise<void> {
    const flow = this.requireFlow();
    if (payload.action === 'pause-all' || payload.action === 'resume-all') {
      if (callerInstanceId) throw new Error('Only James in the Plan Queue page can control all runs');
      const status = payload.action === 'pause-all' ? 'running' : 'paused';
      await Promise.all(this.store.listActiveRuns().filter(run => run.status === status)
        .map(run => this.control({ action: status === 'running' ? 'pause' : 'resume', runId: run.id })));
      return;
    }
    if ('runId' in payload) {
      await this.runControl.control(payload, callerInstanceId, {
        getRun: (id) => this.require(this.parents).follow(this.getRun(id)),
        hasParkedWork: (run) => this.store.listItems(run.id).some(item => item.state === 'parked'),
        authorize: (run, action, caller) => this.authorizeControl(run, action, caller),
        upsertRun: (run) => { this.saveRun(run); },
        holdRun: async (run) => {
          const moving = run.status === 'running';
          if (moving) this.saveRun({ ...this.getRun(run.id), status: 'paused' });
          await Promise.all([this.triage?.pause(run.id), ...this.store.listItems(run.id).map(item => flow.hold(item.id))]);
          if (moving) this.saveRun({ ...this.getRun(run.id), status: 'running' });
        },
        parentRoute: (run) => {
          const parent = run.config.startingSessionRoute ?? this.instances.getInstance(run.parentInstanceId);
          if (!parent && payload.action === 'set-routing' && !payload.routing.worker) throw new Error('The starting session is unavailable; choose a worker provider explicitly.');
          return parent ?? {};
        },
        notifyParent: (run, message) => this.notifyParent(run, message), requestPump: () => this.requestPump(),
        cancel: (run, actor) => this.cancelRun(run, actor), routing: this.requireDeps().routing,
        adopt: (run, callerInstanceId) => { adoptRunParent(run, callerInstanceId, {
          instances: this.instances, isQueueInstance: (id) => this.isQueueInstance(id),
        getRun: (id) => this.getRun(id),
        setParent: (runId, parentInstanceId, parentHistoryThreadId) => {
          this.requireDeps().store.setRunParent(runId, parentInstanceId, parentHistoryThreadId);
          this.announce({ runId });
        }, items: this.store.listItems(run.id),
        notifyParent: (adopted, message) => this.notifyParent(adopted, message),
        onParentChanged: (adopted) => this.require(this.parentMessenger).onParentChanged(adopted),
        }); },
      });
      return;
    }
    const item = this.getItem(payload.itemId);
    const run = this.require(this.parents).follow(this.getRun(item.runId));
    const actor = this.authorizeControl(run, payload.action, callerInstanceId);
    switch (payload.action) {
      case 'skip-item':
        if (!PRE_START_STATES.has(item.state) || item.branchName || item.worktreePath) throw new Error(`Item is ${item.state}; only an item that has not started can be skipped`);
        this.transition(item, 'skipped', { question: null, detail: 'Skipped by James.' });
        break;
      case 'resume-item':
        await flow.resume(item.id);
        this.reopen(this.getRun(run.id));
        break;
      case 'land-anyway':
        // Landing can send the item back to a worker (a conflict or a failed
        // gate), which only the scheduler of an open run picks up.
        this.reopen(run);
        await flow.landAnyway(item.id);
        break;
      case 'discard-item':
        await flow.discard(item.id, actor);
        break;
      case 'retry-landing':
        await flow.retryLanding(item.id);
        this.reopen(run);
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
    if (!this.triage?.isTriageFor(run.id, callerInstanceId)) {
      throw new Error('Only the triage agent for this run may report triage');
    }
    if (args.records.some((record) => !this.triage?.includesDocument(run.id, path.resolve(run.workspaceCwd, record.documentPath)))) {
      throw new Error('Triage may report only documents in its current batch');
    }
    const result = applyTriageRecords(this, run, args);
    this.requestPump();
    return result;
  }
  // ---------------------------------------------------------------------------
  // Boot recovery
  // ---------------------------------------------------------------------------
  /** Boot recovery; see plan-queue-recovery.ts. */
  async recover(): Promise<void> {
    await recoverInterruptedDocumentMerges(this.store);
    for (const run of this.store.listActiveRuns()) await reconcileWaitingDocuments(this, run);
    await recoverPlanQueue(this, this.requireFlow());
    this.requestPump();
  }
  // ---------------------------------------------------------------------------
  // Scheduler
  // ---------------------------------------------------------------------------
  private async pump(): Promise<void> {
    await pumpPlanQueue({
      store: this.store, flow: this.requireFlow(), triage: this.triage,
      getRun: id => this.getRun(id), getItem: id => this.getItem(id),
      transition: (item, to, patch) => this.transition(item, to, patch),
      notifyParent: (run, message, questions) => this.notifyParent(run, message, questions),
      resolveRunParent: run => this.resolveRunParent(run),
      loadAverage: () => this.requireDeps().loadAverage(), followParent: run => this.require(this.parents).follow(run),
      isShuttingDown: () => this.tracker.isShuttingDown(), isControlling: id => this.runControl.isControlling(id),
      finishRun: (run, status) => this.finishRun(run, status), logItemError: (item, error) => this.logItemError(item, error),
    });
  }
  private async routeOutcome(instanceId: string, outcome: PlanQueueTurnOutcome): Promise<void> {
    const role = this.roles.get(instanceId);
    if (!role) return;
    try {
      if (role.role === 'worker') await this.requireFlow().onWorkerOutcome(instanceId, outcome);
      else if (role.role === 'verifier') await this.requireFlow().onVerifierOutcome(instanceId, outcome);
      else this.triage?.onOutcome(instanceId, role.runId, outcome);
    } catch (error) {
      logger.error('Plan queue: handling an instance outcome failed', error instanceof Error ? error : undefined, {
        instanceId,
        role: role.role,
        outcome: outcome.kind,
      });
    }
  }
  // ---------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------
  private async cancelRun(run: PlanQueueRun, actor: string): Promise<void> {
    const flow = this.requireFlow();
    const detail = `Run cancelled by ${actor}.`;
    // Stop the scheduler first: parking below awaits, and a pump in between
    // must not start the next queued item.
    if (run.status === 'running') this.saveRun({ ...run, status: 'paused' });
    await this.triage?.pause(run.id);
    for (const { id } of this.requireDeps().store.listItems(run.id)) {
      const item = this.getItem(id);
      if (hasPendingLandingCleanup(item)) await flow.hold(item.id);
      if (PRE_START_STATES.has(item.state) && !item.branchName && !item.worktreePath) {
        this.transition(item, 'skipped', { question: null, heldAt: null, detail });
      } else if (!isTerminalItemState(item.state)) {
        await flow.park(item.id, 'cancelled', detail);
      }
    }
    this.finishRun(this.getRun(run.id), 'cancelled');
  }
  private finishRun(run: PlanQueueRun, status: 'completed' | 'cancelled'): void {
    if (run.status === 'completed' || run.status === 'cancelled') return;
    if (this.triage && !this.triage.finish(run.id)) return;
    const ended = this.releaseRelaxation({ ...run, status, endedAt: this.requireDeps().now() });
    this.saveRun(ended);
    this.notifyParent(ended, buildRunSummaryMessage(ended, this.requireDeps().store.listItems(run.id)));
    this.parentMessenger?.clear(run.id);
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
  private authorizeControl(run: PlanQueueRun, action: PlanQueueControlPayload['action'], caller: string | undefined): string {
    this.resolveRunParent(run);
    return authorizePlanQueueControl(run, action, caller, {
      instanceExists: (id) => this.instances.getInstance(id) !== undefined,
      isQueueInstance: (id) => this.isQueueInstance(id),
    });
  }
  private logItemError(item: PlanQueueItem, error: unknown): void {
    logger.error('Plan queue item step failed', error instanceof Error ? error : undefined, { itemId: item.id });
  }

  private announce(event: PlanQueueStateChangedEvent): void { this.emit('state-changed', event); }

  private requireDeps(): ResolvedDeps { return this.require(this.deps); }

  private requireFlow(): PlanQueueItemFlow { return this.require(this.flow); }

  private require<T>(value: T | null): T {
    if (value === null) throw new Error('PlanQueueCoordinator has not been initialized');
    return value;
  }
}
export function getPlanQueueCoordinator(): PlanQueueCoordinator {
  return PlanQueueCoordinator.getInstance();
}
