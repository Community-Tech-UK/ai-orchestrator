/**
 * What the item flow does differently for a job on another computer (plan items 3.4 and 3.5): save a turn's work by
 * collecting it first, hold a job whose computer went away, and take it off the computer when the job leaves.
 * The flow keeps every state change; this class decides what the remote side does at each of them.
 */
import { getLogger } from '../../logging/logger';
import { QueueJobLinkError } from './queue-job-link';
import type { PlanQueueFlowHost } from '../plan-queue-host';
import type { PlanQueueItem, PlanQueueRun } from '../plan-queue.types';
import { hasNoCopy, RemoteCollectRefused, type PlanQueueRemoteTurns } from './plan-queue-remote-turns';

const logger = getLogger('PlanQueueRemoteFlow');
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export interface PlanQueueRemoteFlowDeps {
  host: PlanQueueFlowHost;
  turns: PlanQueueRemoteTurns;
  /** The item's lock, for work that starts outside any operation (the away check). */
  lock<T>(itemId: string, action: () => Promise<T>): Promise<T>;
  /** Hold the job with this note; the lock is held. */
  hold(item: PlanQueueItem, reason: string): Promise<void>;
  /** Park the job with the reason and detail; the lock is held. */
  park(item: PlanQueueItem, detail: string): Promise<void>;
  /** Stop a session that may still run on the computer, best effort; its id is the one the job's row kept. */
  terminateRemoteSession?: (nodeId: string, instanceId: string) => Promise<void>;
}

/** What a save came to. `done` has the saved item; the others mean the job was held or parked here already. */
export type SaveOutcome = { kind: 'done'; item: PlanQueueItem; hold: string | null } | { kind: 'held' } | { kind: 'parked' };

export class PlanQueueRemoteFlow {
  constructor(private readonly deps: PlanQueueRemoteFlowDeps) {}

  private get host(): PlanQueueFlowHost { return this.deps.host; }
  private checkpointer = (item: PlanQueueItem, label: string): Promise<PlanQueueItem> => this.host.worktrees.checkpoint(item, label);

  /**
   * A turn starts: place the job or send it again. See `PlanQueueRemoteTurns.arrange`. A job that still has an
   * uncollected turn on its computer (a pause or park that could not collect it, kept there on purpose) has that work
   * taken back and saved first, because sending again resets the far folder and would overwrite it. Returns null when
   * that left the job held or parked, and the caller must stop.
   */
  async arrange(item: PlanQueueItem, run: PlanQueueRun): Promise<PlanQueueItem | null> {
    let current = item;
    if (item.remote?.turnId && item.worktreePath) {
      const saved = await this.saveTurn(item, run, `recovered work from ${item.remote.label}`);
      if (saved.kind !== 'done') return null;
      if (saved.hold) { await this.deps.hold(saved.item, saved.hold); return null; }
      current = saved.item;
    }
    return this.deps.turns.arrange(current, run);
  }

  /**
   * Save one turn's work on a remote job (lock held; the session is already closed). Replaces the plain checkpoint.
   * A computer that is away holds the job; one that refuses parks it with the reason; one with no copy lets the job
   * carry on here from the last checkpoint.
   */
  async saveTurn(item: PlanQueueItem, run: PlanQueueRun, label: string): Promise<SaveOutcome> {
    try {
      const saved = await this.deps.turns.saveRound(item, run, label, this.checkpointer);
      return { kind: 'done', ...saved };
    } catch (error) {
      return this.handleSaveError(item, run, label, error);
    }
  }

  private async handleSaveError(item: PlanQueueItem, run: PlanQueueRun, label: string, error: unknown): Promise<SaveOutcome> {
    const label_ = item.remote?.label ?? 'the other computer';
    if (error instanceof QueueJobLinkError && error.kind === 'away') { await this.goAway(item); return { kind: 'held' }; }
    // The computer answered but could not hand the work over: its work is the only copy, so keep it there and tell James.
    if (error instanceof QueueJobLinkError && error.kind === 'failed') {
      await this.deps.park(this.host.getItem(item.id), `${label_} could not hand this turn's work over (${error.message}). Its work is kept on ${label_}.`);
      return { kind: 'parked' };
    }
    if (hasNoCopy(error) || error instanceof QueueJobLinkError) {
      const carried = await this.deps.turns.fallBackHere(this.host.getItem(item.id), error instanceof QueueJobLinkError
        ? `${label_} cannot take Plan Queue jobs now (${error.message})` : `${label_} no longer has this job's copy`);
      return { kind: 'done', item: await this.checkpointer(carried, label), hold: null };
    }
    if (error instanceof RemoteCollectRefused) { await this.deps.park(this.host.getItem(item.id), error.message); return { kind: 'parked' }; }
    void run;
    throw error;
  }

  /** The job's computer went away: hold the job, say so, and keep checking for ten minutes. */
  async goAway(item: PlanQueueItem): Promise<void> {
    const label = item.remote?.label ?? 'the other computer';
    const marked = this.deps.turns.markAway(this.host.getItem(item.id), () => this.awayTick(item.id));
    await this.deps.hold(marked, `${label} went away; waiting for it`);
  }

  /** One look at a job held because its computer was away. Runs under the item's lock. */
  awayTick(itemId: string): Promise<'again' | 'done'> {
    return this.deps.lock(itemId, async () => {
      const item = this.host.getItem(itemId);
      const remote = item.remote;
      if (!remote?.awaySince || !item.heldAt) return 'done';
      const run = this.host.getRun(item.runId);
      const label = remote.label;
      if (this.deps.turns.isAway(item)) {
        if (!this.deps.turns.awayExpired(item)) return 'again';
        await this.carryOnHere(item, `${label} was away for ten minutes`);
        return 'done';
      }
      // Back before the ten minutes: stop what may still run there, collect what it did, then carry on there as before.
      if (remote.instanceId) await this.deps.terminateRemoteSession?.(remote.nodeId, remote.instanceId)
        .catch((error: unknown) => logger.info('Plan queue: could not stop the old session on its computer', { itemId, error: errorMessage(error) }));
      try {
        const saved = await this.deps.turns.saveRound(item, run, `recovered work from ${label}`, this.checkpointer, { copyBack: true });
        // A plan changed here meanwhile keeps the job held for James, as at any other save.
        this.host.save({ ...saved.item, heldAt: saved.hold ? item.heldAt : null, detail: saved.hold ?? null, remote: { ...saved.item.remote!, awaySince: null } });
        if (!saved.hold) this.host.requestPump();
      } catch (error) {
        if ((error instanceof RemoteCollectRefused && !hasNoCopy(error)) || (error instanceof QueueJobLinkError && error.kind === 'failed')) {
          await this.deps.park(this.host.getItem(itemId), `${errorMessage(error)}${error instanceof RemoteCollectRefused ? '' : ` Its work is kept on ${label}.`}`);
        } else await this.carryOnHere(item, hasNoCopy(error) ? `${label} no longer has this job's copy` : `${label} came back but could not hand the work over (${errorMessage(error)})`);
      }
      return 'done';
    });
  }

  /** From the last checkpoint here; the far copy goes when the computer is back. */
  private async carryOnHere(item: PlanQueueItem, reason: string): Promise<void> {
    const carried = await this.deps.turns.fallBackHere(item, reason);
    this.host.save({ ...carried, heldAt: null });
    this.host.requestPump();
  }

  /**
   * Restart: the old session may still run on the computer, so stop it, then collect as at a checkpoint.
   * Returns the saved item, or null when the job was held or parked and the caller must stop.
   */
  async recoverAfterRestart(item: PlanQueueItem, run: PlanQueueRun): Promise<PlanQueueItem | null> {
    if (!item.remote) return item;
    if (this.deps.turns.isAway(item)) { await this.goAway(item); return null; }
    const sessionId = item.remote.instanceId ?? item.workerInstanceId;
    if (sessionId) await this.deps.terminateRemoteSession?.(item.remote.nodeId, sessionId)
      .catch((error: unknown) => logger.info('Plan queue: could not stop the old session on its computer', { itemId: item.id, error: errorMessage(error) }));
    const outcome = await this.saveTurn(item, run, 'before resume');
    return outcome.kind === 'done' ? outcome.item : null;
  }

  /**
   * Before a hold or park saves a remote job: collect what the computer has (the session is stopped). An away
   * computer is skipped and the job says that later work there is not included. A refusal keeps the far copy.
   */
  async copyBackForStop(item: PlanQueueItem, run: PlanQueueRun): Promise<{ item: PlanQueueItem; notes: string[]; keepThere: boolean }> {
    const remote = item.remote;
    if (!remote) return { item, notes: [], keepThere: false };
    const label = remote.label;
    // Between turns nothing ran there since the last save, so there is nothing to collect.
    if (!remote.turnId) return { item, notes: [], keepThere: false };
    // Work there that could not be collected is kept, not deleted when the computer comes back; Resume sends the job out again from the last save.
    if (this.deps.turns.isAway(item)) return { item, notes: [`${label} is away, so work done there since the last save isn't included yet; it is kept there until the job is resumed or discarded.`], keepThere: true };
    try {
      const collected = await this.deps.turns.collect(item, run);
      // Collected: the stop-time save that follows commits it here, so nothing is left to collect from that turn.
      const idle = this.host.save({ ...this.host.getItem(item.id), remote: { ...this.host.getItem(item.id).remote!, turnId: null } });
      return { item: idle, notes: [collected.summary], keepThere: false };
    } catch (error) {
      if (error instanceof RemoteCollectRefused) return { item, notes: [error.message], keepThere: !hasNoCopy(error) };
      if (error instanceof QueueJobLinkError) return { item, notes: [`${label} could not hand its work over (${error.message}), so work done there since the last save isn't included. It is kept there.`], keepThere: true };
      throw error;
    }
  }

  /** The job left its computer for good (landed, parked, discarded). */
  async release(item: PlanQueueItem): Promise<PlanQueueItem> {
    if (!item.remote) return item;
    return this.deps.turns.release(item, this.host.getRun(item.runId));
  }
}
