/**
 * A Plan Queue job's turns on another computer (plan items 3.2 to 3.5). The item flow calls this at five moments:
 * a turn starts (`arrange`), the session starts (`spawnConfig`), the turn ends (`storeReport`), the work is saved
 * (`saveRound`), and the job leaves the computer (`remove`). Nothing here moves the job between states: the flow
 * does that. Spec: docs/specs/2026-11-08-plan-queue-jobs-on-other-computers_spec_planned.md.
 *
 * Round order: arrange (send, prepare) -> session -> storeReport -> [session closed] -> saveRound (collect,
 * checkpoint unchanged, send, prepare, deleteLeftOut).
 */
import { randomUUID } from 'node:crypto';
import type { InstanceCreateConfig } from '../../../shared/types/instance.types';
import { PlanQueueReportReadyArgsSchema } from '@contracts/schemas/plan-queue';
import { getLogger } from '../../logging/logger';
import { gitText } from './queue-job-git';
import { unresolvedMergeFiles } from '../plan-queue-git';
import { QueueJobLinkError } from './queue-job-link';
import type { RemoteComputer, RemoteQueueJobs } from './queue-job-remote';
import type { RemoteJobPrompt } from '../plan-queue-report-prompts';
import type { PlanQueueFlowHost } from '../plan-queue-host';
import { TIMING_REASONS, recordTiming } from '../plan-queue-timings';
import { recordWorkerReport } from '../plan-queue-worker-report';
import type { PlanQueueItem, PlanQueueRemoteJob, PlanQueueRun } from '../plan-queue.types';
import { placeJob, type Placement, type QueueJobNodeView } from './plan-queue-remote-placement';
import { AWAY_CHECK_MS, AWAY_LIMIT_MS, AwayWatch, PendingRemovals } from './plan-queue-remote-away';
import type { QueueJobComputerSource } from '../../../shared/types/plan-queue-computers.types';

const logger = getLogger('PlanQueueRemoteTurns');

export const ACTIVE_JOB_STATES: ReadonlySet<string> = new Set(['queued', 'preparing', 'working', 'fixing', 'awaiting-slot', 'verifying', 'landing']);

export interface PlanQueueRemoteDeps {
  jobs: Pick<RemoteQueueJobs, 'projectKey' | 'send' | 'prepare' | 'collect' | 'readReport' | 'deleteLeftOut' | 'remove' | 'forget'>;
  computers: () => QueueJobComputerSource;
  nodes: QueueJobNodeView;
  newTurnId?: () => string;
  /** Where jobs still to be removed from a computer are kept, so a restart doesn't forget them. Memory only when absent. */
  removalsFile?: string;
  now?: () => number;
  awayLimitMs?: number;
  awayCheckMs?: number;
}

/** A collect the computer refused, or that this Mac refused to apply. The job parks with this text; its work stays there. */
export class RemoteCollectRefused extends Error {
  /** The worker's reason, or `folder-moved` / `nothing-sent` for this Mac's own refusals. */
  constructor(message: string, readonly reason: string) { super(message); this.name = 'RemoteCollectRefused'; }
}

/** The computer has no copy of the job (it was reinstalled or cleaned): the job carries on here, which is not a fault. */
export const hasNoCopy = (error: unknown): boolean => error instanceof RemoteCollectRefused && (error.reason === 'no-copy' || error.reason === 'not-prepared');

/** Where a job's folders are on its computer for the turn now running. */
export type RemoteTurnPaths = Omit<RemoteJobPrompt, 'repoRoot'>;

export interface SavedRound { item: PlanQueueItem; hold: string | null }

export class PlanQueueRemoteTurns {
  private readonly paths = new Map<string, RemoteTurnPaths>();
  private readonly removals: PendingRemovals;
  /** Placement decisions go one at a time, so two jobs started together cannot both take a computer's last place. */
  private placing: Promise<unknown> = Promise.resolve();
  private readonly watch: AwayWatch;
  constructor(private readonly host: Pick<PlanQueueFlowHost, 'getItem' | 'save' | 'getRun' | 'store' | 'history'>, private readonly deps: PlanQueueRemoteDeps) {
    this.removals = new PendingRemovals(deps.removalsFile);
    this.watch = new AwayWatch(deps.awayCheckMs ?? AWAY_CHECK_MS);
  }

  /** How many jobs hold a place on this computer, across every run. */
  jobsOn(nodeId: string): number {
    return this.host.store.listActiveRuns().flatMap(run => this.host.store.listItems(run.id))
      .filter(item => item.remote?.nodeId === nodeId && ACTIVE_JOB_STATES.has(item.state)).length;
  }

  /** The prompt's view of the current turn's folders, or undefined for a job that runs here. */
  promptFor(item: Pick<PlanQueueItem, 'id'>, repoRoot: string): RemoteJobPrompt | undefined {
    const paths = this.paths.get(item.id);
    return paths ? { ...paths, repoRoot } : undefined;
  }

  /** Session settings for a job on another computer: the node, and the folder there. */
  spawnConfig(item: Pick<PlanQueueItem, 'id'>, provider: string | undefined): Partial<InstanceCreateConfig> | undefined {
    const remote = this.host.getItem(item.id).remote;
    const paths = this.paths.get(item.id);
    if (!remote || !paths) return undefined;
    return {
      forceNodeId: remote.nodeId, workingDirectory: paths.jobFolder,
      ...(provider === 'opencode' ? { additionalDirectories: [paths.planningFolder, paths.reportFile.replace(/[\\/][^\\/]*$/, '')] } : {}),
    };
  }

  /** The Mac-side id the worker's session on the computer has, so a restart or a return from away can stop it there. */
  noteSession(item: Pick<PlanQueueItem, 'id'>, instanceId: string): void {
    const current = this.host.getItem(item.id);
    if (current.remote) this.host.save({ ...current, remote: { ...current.remote, instanceId } });
  }

  private computerOf(remote: PlanQueueRemoteJob): RemoteComputer { return { nodeId: remote.nodeId, label: remote.label }; }

  private placementFor(item: PlanQueueItem, run: PlanQueueRun): Placement {
    try {
      return placeJob({ run, item, computers: this.deps.computers().list(), nodes: this.deps.nodes,
        jobsOn: nodeId => this.jobsOn(nodeId), projectKey: this.deps.jobs.projectKey(run.workspaceCwd) });
    } catch (error) {
      // The saved Computers settings could not be read: run here rather than guess.
      return { kind: 'here', reason: `This job runs on this Mac because the Computers settings could not be read (${error instanceof Error ? error.message : String(error)}).` };
    }
  }

  /** True when this job's next turn would go to another computer (the scheduler then counts it apart from this Mac's own limits). */
  runsElsewhere(item: PlanQueueItem, run: PlanQueueRun): boolean {
    if (item.remote) return !this.isAway(item);
    return this.placementFor(item, run).kind === 'there';
  }

  /**
   * A turn is about to start. A job with no computer yet is placed (or told to run here, with the reason on its
   * timeline); a job already on one has the current commit sent again and its folders prepared for a new report file.
   * A round with a merge to resolve stays on this Mac, because a conflicted merge's state lives in this folder's index.
   * Anything that goes wrong sending sends the job here instead, from the last checkpoint.
   */
  async arrange(item: PlanQueueItem, run: PlanQueueRun): Promise<PlanQueueItem> {
    if (!item.worktreePath || !item.branchName) return item;
    if ((await unresolvedMergeFiles(item.worktreePath))?.length) return this.keepRoundHere(item, run);
    let current = item;
    if (!current.remote) {
      const placed = await this.serially(async () => {
        const placement = this.placementFor(item, run);
        if (placement.kind === 'here') {
          if (placement.reason) recordTiming(this.host.history, item, TIMING_REASONS.placement, { where: 'here', note: placement.reason });
          return null;
        }
        // Saved before the next placement decides, so the next sees this place taken.
        const saved = this.host.save({ ...this.host.getItem(item.id), remote: { nodeId: placement.computer.nodeId, label: placement.computer.label, branch: item.branchName!,
          lastExchangedCommit: null, turnStartCommit: null, turnId: null, instanceId: null } });
        recordTiming(this.host.history, saved, TIMING_REASONS.placement, { where: 'computer', label: placement.computer.label,
          note: `This job runs on ${placement.computer.label}.` });
        // A removal queued when this job last left that computer must not delete what it is about to send.
        this.removals.delete(item.id, placement.computer.nodeId);
        return saved;
      });
      if (!placed) return item;
      current = placed;
    }
    try { return await this.send(current, run, true); }
    catch (error) {
      this.paths.delete(current.id);
      return this.fallBackHere(current, `could not send the job to ${current.remote!.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private serially<T>(work: () => Promise<T>): Promise<T> {
    const result = this.placing.then(work, work);
    this.placing = result.catch(() => undefined);
    return result;
  }

  /** The merge here must be resolved in this folder, so this round runs here; the next one can go out again once it is saved. */
  private async keepRoundHere(item: PlanQueueItem, run: PlanQueueRun): Promise<PlanQueueItem> {
    this.paths.delete(item.id);
    if (!item.remote) return item;
    recordTiming(this.host.history, item, TIMING_REASONS.placement, { where: 'here', label: item.remote.label,
      note: 'This round runs on this Mac because a merge has to be resolved in this job\'s folder here.' });
    return this.release(item, run);
  }

  /** Send the folder's commit and prepare the far folders. `newTurn` names a report file for the worker about to start. */
  private async send(item: PlanQueueItem, run: PlanQueueRun, newTurn: boolean): Promise<PlanQueueItem> {
    const remote = item.remote!;
    const computer = this.computerOf(remote);
    const commit = await gitText(['rev-parse', 'HEAD'], item.worktreePath!);
    const baseBranch = run.config.baseBranch;
    await this.deps.jobs.send({ computer, repoRoot: run.workspaceCwd, item, commit, baseBranch: baseBranch ?? 'HEAD',
      startCommit: item.baseCommit ?? commit, lastExchanged: remote.lastExchangedCommit });
    const turnId = (this.deps.newTurnId ?? randomUUID)();
    const prepared = await this.deps.jobs.prepare({ computer, repoRoot: run.workspaceCwd, item, commit, turnId });
    this.paths.set(item.id, { computerLabel: computer.label, jobFolder: prepared.jobFolder,
      planningFolder: prepared.planningFolder, reportFile: prepared.reportFile });
    // Between turns nothing runs there: no turn id, so a pause or park then has nothing to collect.
    return this.host.save({ ...this.host.getItem(item.id), remote: { ...remote, lastExchangedCommit: commit,
      turnStartCommit: commit, turnId: newTurn ? turnId : null, awaySince: null, ...(newTurn ? { instanceId: null } : {}) } });
  }

  /**
   * The turn ended: read its report file only (an earlier turn's is never read) and store it as the worker's report,
   * so the gate, the checker and the deferred-check rule see it as a tool report. A missing or malformed file is no
   * report; a malformed one is named in the job's note.
   */
  async storeReport(item: PlanQueueItem, instanceId: string, run: PlanQueueRun): Promise<PlanQueueItem> {
    const remote = item.remote;
    if (!remote?.turnId) return item;
    let text: string | null;
    try { text = await this.deps.jobs.readReport({ computer: this.computerOf(remote), item, turnId: remote.turnId }); }
    catch (error) {
      logger.warn('Plan queue: could not read the report file; the turn counts as having none', { itemId: item.id, error: error instanceof Error ? error.message : String(error) });
      return item;
    }
    if (text === null) return item;
    let parsed: ReturnType<typeof PlanQueueReportReadyArgsSchema.safeParse>;
    try { parsed = PlanQueueReportReadyArgsSchema.safeParse(JSON.parse(text)); }
    catch { parsed = PlanQueueReportReadyArgsSchema.safeParse(undefined); }
    if (!parsed.success || parsed.data.item_id !== item.id) {
      const named = parsed.success ? 'it names another job' : parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || 'the file'}: ${issue.message}`).join('; ');
      return this.host.save({ ...item, detail: `The report file from ${remote.label} could not be used (${named}), so this turn counts as having no report.` });
    }
    recordWorkerReport(this.host, instanceId, parsed.data);
    void run;
    return this.host.getItem(item.id);
  }

  /**
   * Save a turn's work. Here: collect (code into the job's folder, planning documents into the main checkout), then
   * the existing `checkpoint` unchanged, then send the result back out and move the far folder to it. The caller has
   * already closed the session. A computer that is away saves nothing new and says so. `hold` is the text to hold the
   * job with when the plan changed here meanwhile.
   */
  async saveRound(item: PlanQueueItem, run: PlanQueueRun, label: string, checkpoint: (item: PlanQueueItem, label: string) => Promise<PlanQueueItem>,
    options: { copyBack?: boolean } = {}): Promise<SavedRound> {
    const remote = item.remote;
    if (!remote) return { item: await checkpoint(item, label), hold: null };
    let leftOut: string[] = [];
    let hold: string | null = null;
    let current = item;
    if (options.copyBack !== false) {
      const collected = await this.collect(current, run);
      leftOut = collected.leftOut;
      hold = collected.hold;
      current = this.host.getItem(item.id);
    }
    const saved = await checkpoint(current, label);
    const stored = this.host.save({ ...saved, remote: { ...(saved.remote ?? remote), lastExchangedCommit: saved.remote?.lastExchangedCommit ?? remote.lastExchangedCommit } });
    try {
      const sent = await this.send(stored, run, false);
      await this.deps.jobs.deleteLeftOut({ computer: this.computerOf(remote), repoRoot: run.workspaceCwd, item: sent, files: leftOut });
      return { item: this.host.getItem(item.id), hold };
    } catch (error) {
      logger.warn('Plan queue: could not send the saved work back out', { itemId: item.id, error: error instanceof Error ? error.message : String(error) });
      return { item: this.host.getItem(item.id), hold };
    }
  }

  /** Take the agent's changes back. Throws `RemoteCollectRefused` or `QueueJobLinkError`; the caller decides what each means. */
  async collect(item: PlanQueueItem, run: PlanQueueRun): Promise<{ leftOut: string[]; hold: string | null; summary: string }> {
    const remote = item.remote!;
    const expected = remote.lastExchangedCommit;
    if (!expected || !item.worktreePath) throw new RemoteCollectRefused(`Nothing was sent to ${remote.label} for this job yet, so there is nothing to take back.`, 'nothing-sent');
    const head = await gitText(['rev-parse', 'HEAD'], item.worktreePath);
    if (head !== (remote.turnStartCommit ?? expected)) {
      throw new RemoteCollectRefused(`This job's folder on this Mac moved while ${remote.label} was working on it, so its changes were not copied back, rather than undo what changed here. Its work is kept on ${remote.label}.`, 'folder-moved');
    }
    const result = await this.deps.jobs.collect({ computer: this.computerOf(remote), repoRoot: run.workspaceCwd, item, jobFolder: item.worktreePath, expectedParent: expected });
    if (result.outcome === 'refused') throw new RemoteCollectRefused(`${result.message} Its work is kept on ${remote.label}.`, result.reason);
    return { leftOut: result.leftOut, hold: result.documents.hold?.text ?? null, summary: result.summary };
  }

  /** The job leaves its computer (landed, set aside, discarded): remove the far copy, or queue its removal for when it is back. */
  async release(item: PlanQueueItem, run: Pick<PlanQueueRun, 'workspaceCwd'>): Promise<PlanQueueItem> {
    const remote = item.remote;
    if (!remote) return item;
    this.watch.stop(item.id);
    if (!await this.remove(item, run)) {
      this.removals.add({ nodeId: remote.nodeId, label: remote.label, repoRoot: run.workspaceCwd,
        item: { id: item.id, sourceRef: item.sourceRef, branchName: remote.branch } });
    }
    return this.host.save({ ...this.host.getItem(item.id), remote: null });
  }

  /** True when the job's computer cannot be reached now. */
  isAway(item: PlanQueueItem): boolean {
    const nodeId = item.remote?.nodeId;
    return nodeId !== undefined && !this.deps.nodes.isConnected(nodeId);
  }

  /** Ask the computer to remove its copy of the job; the bare repository stays. Failure is reported, not thrown. */
  async remove(item: PlanQueueItem, run: Pick<PlanQueueRun, 'workspaceCwd'>): Promise<boolean> {
    const remote = item.remote;
    this.paths.delete(item.id);
    if (!remote) return true;
    try {
      const removed = await this.deps.jobs.remove({ computer: this.computerOf(remote), repoRoot: run.workspaceCwd, item: { ...item, branchName: remote.branch } });
      if (removed) await this.deps.jobs.forget({ repoRoot: run.workspaceCwd, item });
      return removed;
    } catch (error) {
      logger.info('Plan queue: could not remove a job from its computer now', { itemId: item.id, error: error instanceof QueueJobLinkError ? error.kind : String(error) });
      return false;
    }
  }

  /** The job carries on here from its last checkpoint; the far copy is removed when the computer is back. Returns the item with no computer. */
  async fallBackHere(item: PlanQueueItem, reason: string): Promise<PlanQueueItem> {
    const remote = item.remote;
    this.paths.delete(item.id);
    this.watch.stop(item.id);
    if (!remote) return item;
    this.removals.add({ nodeId: remote.nodeId, label: remote.label, repoRoot: this.host.getRun(item.runId).workspaceCwd,
      item: { id: item.id, sourceRef: item.sourceRef, branchName: remote.branch } });
    recordTiming(this.host.history, item, TIMING_REASONS.placement, { where: 'here', label: remote.label, note: `Carrying on here: ${reason}.` });
    return this.host.save({ ...item, remote: null, detail: `Carrying on here from the last saved point: ${reason}.` });
  }

  /** Remove what computers still hold for jobs that carried on here. Called by the scheduler; an away computer waits. */
  async retryRemovals(): Promise<void> {
    for (const entry of [...this.removals.list()]) {
      if (!this.deps.nodes.isConnected(entry.nodeId)) continue;
      try {
        const removed = await this.deps.jobs.remove({ computer: { nodeId: entry.nodeId, label: entry.label }, repoRoot: entry.repoRoot,
          item: { id: entry.item.id, sourceRef: entry.item.sourceRef, branchName: entry.item.branchName } });
        if (removed) { await this.deps.jobs.forget({ repoRoot: entry.repoRoot, item: entry.item }); this.removals.delete(entry.item.id, entry.nodeId); }
      } catch (error) {
        logger.info('Plan queue: could not remove an old job from a computer yet', { itemId: entry.item.id, error: String(error) });
      }
    }
  }

  /** Record when the computer was found away (once) and start checking on it. `tick` is the flow's check. */
  markAway(item: PlanQueueItem, tick: () => Promise<'again' | 'done'>): PlanQueueItem {
    const saved = item.remote?.awaySince ? item : this.host.save({ ...item, remote: { ...item.remote!, awaySince: (this.deps.now ?? Date.now)() } });
    this.watch.start(item.id, tick);
    return saved;
  }

  /** Ten minutes away: the job carries on here. */
  awayExpired(item: PlanQueueItem): boolean {
    const since = item.remote?.awaySince;
    return since !== undefined && since !== null && (this.deps.now ?? Date.now)() - since >= (this.deps.awayLimitMs ?? AWAY_LIMIT_MS);
  }

  /** The job is back with its computer or has left it: stop checking. */
  stopWatching(itemId: string): void { this.watch.stop(itemId); }
  isWatching(itemId: string): boolean { return this.watch.isWatching(itemId); }
  shutdown(): void { this.watch.stopAll(); }
}
