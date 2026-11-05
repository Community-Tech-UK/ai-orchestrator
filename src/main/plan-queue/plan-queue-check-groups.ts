/** A check slot may cover compatible waiting jobs; each still gets its own checker. */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { gitExec } from '../workspace/git/git-exec';
import { WorktreeCapacityError } from '../workspace/git/worktree-manager';
import { getGitWriteQueue } from '../workspace/git/git-write-queue';
import { pathCompareKey } from '../util/path-helpers';
import { blockingGateReceipts, type GateInput, type PlanQueueGateReceipt, type PlanQueueGateRunner } from './plan-queue-gate-receipts';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { machineGroupCoversMovedBase, groupRoundStillIntact } from './plan-queue-group-landing';
import { readDocumentReview, type DocumentReview } from './plan-queue-document-review';
import { readProvisionedPaths } from './plan-queue-worktree';
import { syncItemWithBase } from './plan-queue-landing';
import { hasCheckout } from './plan-queue-orphan-checkout';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

export interface CheckGroupFlow {
  lock<T>(itemId: string, action: () => Promise<T>): Promise<T>;
  waiting(itemId: string): boolean;
}
interface Reservation { id: string; members: Set<string>; controller: AbortController }
interface Member { itemId: string; head: string; documentReview: DocumentReview }
interface PendingMember {
  input: GateInput; round: number; documentPath: string; documentReview: DocumentReview;
  workspaceCwd: string; baseBranch: PlanQueueRun['config']['baseBranch']; memberItemIds: readonly string[];
}
const FALLBACK = 'The combined check failed; checking each job on its own.';
const capacityRefusal = (error: unknown) => error instanceof WorktreeCapacityError
  || error instanceof Error && error.cause instanceof WorktreeCapacityError;

export class PlanQueueCheckGroups {
  private readonly groups = new Map<string, Reservation>();
  private readonly pending = new Map<string, PendingMember>();
  private readonly claims = new Map<string, string>();
  constructor(private readonly host: PlanQueueFlowHost, private readonly gates: PlanQueueGateRunner,
    private readonly flow: CheckGroupFlow) {}

  /** Synchronous reservation stops the pump admitting members into other slots. */
  reserve(leader: PlanQueueItem, run: PlanQueueRun): void {
    if ((run.config.checkBatchSize ?? 1) <= 1 || !run.config.verifierGates.length || run.status !== 'running') return;
    const candidates = this.host.store.listActiveRuns().filter(other => this.compatible(run, other))
      .flatMap(other => this.host.store.listItems(other.id)).filter(item => item.id !== leader.id && this.eligible(item))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(0, run.config.checkBatchSize! - 1);
    if (!candidates.length) return;
    const group: Reservation = { id: randomUUID(), members: new Set(), controller: new AbortController() };
    this.groups.set(leader.id, group);
    try {
      for (const item of candidates) {
        group.members.add(item.id); this.claims.set(item.id, leader.id);
        this.host.save({ ...item, detail: `Waiting to be checked together with ${basename(leader.documentPath)}` });
      }
    } catch (error) { this.release(leader.id); throw error; }
  }

  isClaimed(itemId: string): boolean { return this.claims.has(itemId); }
  controllerFor(leaderId: string): AbortController | undefined { return this.groups.get(leaderId)?.controller; }
  cancel(itemId: string): void { this.forgetPendingGroup(itemId); this.groups.get(this.claims.get(itemId) ?? itemId)?.controller.abort(); }
  cancelAll(): void { for (const id of this.pending.keys()) this.forgetPendingGroup(id); for (const group of this.groups.values()) group.controller.abort(); }

  pendingStillIntact(itemId: string): boolean {
    const pending = this.pending.get(itemId);
    if (!pending) return false;
    const group = this.gates.cached(pending.input)?.[0]?.checkGroup;
    return !!group && groupRoundStillIntact(group, this.host) && group.memberItemIds.every(id => {
      const member = this.host.getItem(id);
      const run = this.host.getRun(member.runId);
      const own = this.pending.get(id);
      return (run.status === 'running' || run.status === 'completed' && member.state === 'landed')
        && !member.heldAt && !this.flow.waiting(id)
        && pathCompareKey(run.workspaceCwd) === pathCompareKey(pending.workspaceCwd)
        && run.config.baseBranch === pending.baseBranch
        && JSON.stringify(run.config.verifierGates) === JSON.stringify(pending.input.commands)
        && (!own || member.round === own.round && member.documentPath === own.documentPath
          && member.worktreePath === own.input.cwd && member.checkpointCommit === own.input.head);
    });
  }

  forget(itemId: string): void {
    const pending = this.pending.get(itemId);
    if (pending) this.gates.forget(pending.input);
    this.pending.delete(itemId);
  }

  private forgetPendingGroup(itemId: string): void {
    for (const [id, pending] of this.pending) {
      if (id === itemId || pending.memberItemIds.includes(itemId)) this.forget(id);
    }
  }

  /** Keep the cache's exact base key; ownership permits only a separately proven pre-sync lookup. */
  async pendingReceipts(item: PlanQueueItem): Promise<PlanQueueGateReceipt[] | undefined> {
    const pending = this.pending.get(item.id);
    if (!pending) return;
    const receipts = this.gates.cached(pending.input);
    const group = receipts?.[0]?.checkGroup;
    const run = this.host.getRun(item.runId);
    const intact = () => this.pendingStillIntact(item.id);
    let valid = !!receipts && !!group && intact() && item.worktreePath === pending.input.cwd
      && item.round === pending.round && item.documentPath === pending.documentPath
      && JSON.stringify(run.config.verifierGates) === JSON.stringify(pending.input.commands);
    const unchanged = async () => {
      for (const id of group!.memberItemIds) {
        const member = this.host.getItem(id);
        if (member.state === 'landed') continue;
        const own = this.pending.get(id);
        // A member already in review may have consumed its pending reference; its own PASS is authoritative.
        if (!own) { if (member.verdict?.verdict !== 'PASS') return false; continue; }
        if (member.round !== own.round || member.documentPath !== own.documentPath || member.worktreePath !== own.input.cwd
          || member.checkpointCommit !== own.input.head || await gitExec(['rev-parse', 'HEAD'], own.input.cwd) !== own.input.head
          || JSON.stringify(await readDocumentReview(member.documentPath)) !== JSON.stringify(own.documentReview)) return false;
        const provisioned = await readProvisionedPaths(own.input.cwd);
        if (await gitExec(['status', '--porcelain', '--untracked-files=all', '--', '.',
          ...provisioned.map(file => `:(exclude,literal)${file}`)], own.input.cwd)) return false;
      }
      return true;
    };
    if (valid) valid = await unchanged();
    if (valid) {
      const base = await gitExec(['rev-parse', `refs/heads/${run.config.baseBranch}`], run.workspaceCwd);
      valid = await machineGroupCoversMovedBase(item, run, base, receipts!, this.host) && await unchanged()
        && this.pending.get(item.id) === pending && intact();
    }
    if (!valid) { this.forgetPendingGroup(item.id); return; }
    return receipts;
  }

  release(leaderId: string, detail: string | null = null): void {
    const group = this.groups.get(leaderId);
    if (!group) return;
    // Remove ownership even if a durable detail write fails; no subsequent item is stranded.
    this.groups.delete(leaderId);
    let failure: unknown;
    for (const memberId of group.members) {
      this.claims.delete(memberId);
      try {
        const item = this.host.getItem(memberId);
        if (item.state === 'awaiting-slot' && (item.detail?.startsWith('Waiting to be checked together with ') || detail)) {
          this.host.save({ ...item, detail });
        }
      } catch (error) { failure ??= error; }
    }
    this.host.requestPump();
    if (failure) throw failure;
  }

  async run(leader: PlanQueueItem, run: PlanQueueRun, input: GateInput): Promise<PlanQueueGateReceipt[] | undefined> {
    const group = this.groups.get(leader.id);
    if (!group) return;
    const seeded: GateInput[] = [];
    let detail: string | null = null;
    try {
      group.controller.signal.throwIfAborted();
      if (this.gates.cached(input) || this.host.history.hasFailedCheckGroup(leader.id, input.head)
        || !this.compatible(run, this.host.getRun(run.id))) return;
      try { await gitExec(['merge-base', '--is-ancestor', input.baseSha!, input.head], run.workspaceCwd); }
      catch (error) { if ((error as { code?: unknown }).code === 1) return; throw error; }
      const members: Member[] = [{ itemId: leader.id, head: input.head, documentReview: await readDocumentReview(leader.documentPath) }];
      for (const id of group.members) {
        const member = await this.flow.lock(id, () => this.prepareMember(id, run, input));
        if (member) members.push(member);
      }
      if (members.length < 2) return;
      group.controller.signal.throwIfAborted();
      let covered: readonly Member[] = [];
      const raw = await this.host.worktrees.withCombinedCopy(run.workspaceCwd, input.baseSha!, members, async copy => {
        covered = copy.members.map(member => members.find(candidate => candidate.itemId === member.itemId)!);
        return this.gates.executeCommands({ ...input, cwd: copy.cwd, head: copy.head,
          onExecution: () => this.host.history.recordChecklistRun(leader, covered.map(member => member.itemId), group.id) });
      }, group.controller.signal).catch(error => { if (capacityRefusal(error)) return undefined; throw error; });
      if (!raw) return;
      // withCombinedCopy has already removed its checkout before a baseline needs one.
      const receipts = await this.gates.compareWithBase(input, raw).catch(error => {
        if (capacityRefusal(error)) return raw.map(receipt => ({ ...receipt, baseline: 'new' as const, failureKeyCounts: {} }));
        throw error;
      });
      group.controller.signal.throwIfAborted();
      if (blockingGateReceipts(receipts).length) {
        detail = FALLBACK;
        for (const member of covered) {
          const item = this.host.getItem(member.itemId);
          this.host.history.recordEvent({ itemId: item.id, runId: item.runId, fromState: item.state, toState: item.state,
            reason: 'check-group-failed', detailHead: JSON.stringify({ head: member.head }), round: item.round, tokens: 0 });
        }
        return;
      }
      const checkGroup = { id: group.id, baseTip: input.baseSha!, memberItemIds: covered.map(member => member.itemId) };
      let result: PlanQueueGateReceipt[] | undefined;
      for (const member of covered) {
        const seed = async () => {
          const item = this.host.getItem(member.itemId);
          group.controller.signal.throwIfAborted();
          if (!item.worktreePath || this.host.getRun(item.runId).status !== 'running'
            || (item.id !== leader.id && (item.state !== 'awaiting-slot' || this.flow.waiting(item.id)))
            || await gitExec(['rev-parse', 'HEAD'], item.worktreePath) !== member.head) return;
          group.controller.signal.throwIfAborted();
          const memberInput = { ...input, cwd: item.worktreePath, head: member.head };
          const ownReceipts = receipts.map(receipt => ({ ...receipt, head: member.head, checkGroup }));
          this.gates.seed(memberInput, ownReceipts); seeded.push(memberInput);
          if (this.pending.size >= 100) this.forget(this.pending.keys().next().value!);
          this.pending.set(item.id, { input: { cwd: memberInput.cwd, head: memberInput.head, baseSha: memberInput.baseSha, commands: [...memberInput.commands] }, round: item.round,
            documentPath: item.documentPath, documentReview: member.documentReview, workspaceCwd: run.workspaceCwd,
            baseBranch: run.config.baseBranch, memberItemIds: checkGroup.memberItemIds });
          if (item.id === leader.id) result = ownReceipts;
        };
        if (member.itemId === leader.id) await seed(); else await this.flow.lock(member.itemId, seed);
      }
      group.controller.signal.throwIfAborted();
      return result;
    } catch (error) {
      for (const memberInput of seeded) this.gates.forget(memberInput);
      for (const id of [...group.members, leader.id]) this.forget(id);
      throw error;
    } finally { this.release(leader.id, detail); }
  }

  private compatible(run: PlanQueueRun, other: PlanQueueRun): boolean {
    return other.status === 'running' && (other.config.checkBatchSize ?? 1) > 1
      && pathCompareKey(run.workspaceCwd) === pathCompareKey(other.workspaceCwd)
      && run.config.baseBranch === other.config.baseBranch
      && JSON.stringify(run.config.verifierGates) === JSON.stringify(other.config.verifierGates);
  }

  private eligible(item: PlanQueueItem): boolean {
    return item.state === 'awaiting-slot' && !!item.worktreePath && !item.heldAt
      && !this.flow.waiting(item.id) && !this.claims.has(item.id) && !this.groups.has(item.id);
  }

  private async prepareMember(id: string, run: PlanQueueRun, input: GateInput): Promise<Member | undefined> {
    let item = this.host.getItem(id);
    if (!this.eligibleClaimed(item) || !this.compatible(run, this.host.getRun(item.runId)) || !await hasCheckout(item.worktreePath!)) return;
    let head = await gitExec(['rev-parse', 'HEAD'], item.worktreePath!);
    if (this.gates.cached({ ...input, cwd: item.worktreePath!, head }) || this.host.history.hasFailedCheckGroup(id, head)) return;
    // Probe before sync, so an excluded member never acquires an unresolved merge.
    try { await getGitWriteQueue().enqueue('plan-queue-group-member-preflight', () =>
      gitExec(['merge-tree', '--write-tree', input.baseSha!, head], run.workspaceCwd)); }
    catch (error) { if ((error as { code?: unknown }).code === 1) return; throw error; }
    if (await gitExec(['rev-parse', `refs/heads/${run.config.baseBranch}`], run.workspaceCwd) !== input.baseSha) return;
    const sync = await syncItemWithBase(item, run.config.baseBranch!, run.workspaceCwd);
    if (sync.status === 'conflict') return;
    if (sync.status === 'merged') item = await this.host.worktrees.checkpoint(item, `merge ${run.config.baseBranch}`);
    if (await gitExec(['rev-parse', `refs/heads/${run.config.baseBranch}`], run.workspaceCwd) !== input.baseSha) return;
    head = await gitExec(['rev-parse', 'HEAD'], item.worktreePath!);
    if (this.gates.cached({ ...input, cwd: item.worktreePath!, head }) || this.host.history.hasFailedCheckGroup(id, head)) return;
    return { itemId: id, head, documentReview: await readDocumentReview(item.documentPath) };
  }

  private eligibleClaimed(item: PlanQueueItem): boolean {
    return item.state === 'awaiting-slot' && !!item.worktreePath && !item.heldAt && !this.flow.waiting(item.id);
  }
}
