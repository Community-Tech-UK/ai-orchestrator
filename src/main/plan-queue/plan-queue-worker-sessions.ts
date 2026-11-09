/** Provider conversation recording and one fresh-start retry for a failed reopen. */
import { getLogger } from '../logging/logger';
import type { PlanQueueFlowHost, PlanQueueInstancePort } from './plan-queue-host';
import { hasCheckout } from './plan-queue-orphan-checkout';
import { unresolvedMergeFiles } from './plan-queue-git';
import { allocateLivetestPort } from './plan-queue-livetest-port';
import { buildConflictPrompt, buildParkedCarryOver } from './plan-queue-prompts';
import { readPlanBrief, type PlanBrief } from './plan-queue-plan-extract';
import { isLastStepJob } from './plan-queue-sections';
import type { PlanQueueRun, PlanQueueItem } from './plan-queue.types';
import { workSourceFor } from './plan-queue-work-sources';
const logger = getLogger('PlanQueueWorkerSessions');
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

interface WorkerSessionDeps {
  host: PlanQueueFlowHost;
  lock(id: string, action: () => Promise<void>): Promise<void>;
  stop(id: string): Promise<void>;
  spawn(item: PlanQueueItem, prompt: string): Promise<void>;
  failed(id: string, reason: string): Promise<void>;
}

export class PlanQueueWorkerSessions {
  private readonly reopeningWorkers = new Set<string>();
  private readonly startupFailures = new Map<string, string>();
  constructor(private readonly deps: WorkerSessionDeps) {}
  isReopening(id: string): boolean { return this.reopeningWorkers.has(id); }
  rememberFailure(id: string, reason: string): void { this.startupFailures.set(id, reason); }
  forget(id: string): void { this.reopeningWorkers.delete(id); this.startupFailures.delete(id); }
  /**
   * A livetest item's dev-app port, checked free and recorded before its worker is prompted.
   * Any other kind of item is returned untouched. `keepRecorded` leaves a port already recorded alone, for a
   * restart: the worker that died may still hold it, so checking it free would wrongly pick another.
   */
  async withLivetestPort(item: PlanQueueItem, run: PlanQueueRun, keepRecorded = false): Promise<PlanQueueItem> {
    if (run.kind !== 'livetests' || (keepRecorded && item.livetestPort)) return item;
    const { host } = this.deps;
    let saved = item;
    await allocateLivetestPort(item.id, item.livetestPort, {
      portsInUse: (except) => host.livetestPortsInUse(except),
      persist: (port) => { saved = host.save({ ...host.getItem(item.id), livetestPort: port }); },
    });
    return saved;
  }

  /** The short continue nudge goes into a session that already has its first prompt, so it carries no plan brief. */
  continueContext(run: PlanQueueRun, item: PlanQueueItem) {
    return {
      item,
      kind: run.kind,
      repoRoot: run.workspaceCwd,
      worktreePath: item.worktreePath ?? '',
      answer: this.answerFor(run, item),
    };
  }

  /** A step job has no readiness question of its own: it carries the answer given for the plan, which sits on the plan's first step. */
  private answerFor(run: PlanQueueRun, item: PlanQueueItem): string | null {
    if (item.answer || item.section == null) return item.answer;
    const first = this.deps.host.store.listItems(run.id)
      .filter(other => other.sourceRef === item.sourceRef && other.section != null)
      .sort((a, b) => a.section! - b.section!)[0];
    return first?.answer ?? null;
  }

  /** What a worker, resume or step-up prompt is built from; a plan's Status and open work are read fresh from the root checkout. */
  async promptContext(run: PlanQueueRun, item: PlanQueueItem) {
    return {
      ...this.continueContext(run, item),
      ...(run.kind === 'plans' ? { brief: this.lastStepOfRun(run, item, await readPlanBrief(item.sourceRef, item.section)) } : {}),
    };
  }

  /** The step that writes the as-built summary is the run's last job, which is not the plan's last heading when that step is already ticked off. */
  private lastStepOfRun(run: PlanQueueRun, item: PlanQueueItem, brief: PlanBrief): PlanBrief {
    return brief.step ? { ...brief, step: { ...brief.step, last: isLastStepJob(this.deps.host.store.listItems(run.id), item) } } : brief;
  }

  /**
   * Resume clears a parked item's verdict and park note, which its next worker still needs:
   * keep them as the pending instruction (one that is already pending wins).
   */
  carryOverForResume(id: string): string | null {
    const item = this.deps.host.getItem(id);
    return item.pendingInstruction ?? (item.state === 'parked' ? buildParkedCarryOver(item) : null);
  }

  /** The conflict prompt again, when the worktree holds a merge the worker never finished. */
  async conflictAddendum(item: PlanQueueItem, run: PlanQueueRun): Promise<string> {
    if (!item.worktreePath || !(await hasCheckout(item.worktreePath))) return '';
    const conflicted = await unresolvedMergeFiles(item.worktreePath);
    if (!conflicted?.length || !run.config.baseBranch) return '';
    return `\n\n${buildConflictPrompt(run.config.baseBranch, conflicted)}`;
  }

  record(itemId: string, instanceId: string): void {
    const item = this.deps.host.getItem(itemId);
    if (item.workerInstanceId !== instanceId || ['landed', 'skipped'].includes(item.state)) return;
    const instance = this.deps.host.instances.getInstance(instanceId);
    if (!instance?.providerSessionId?.trim() || !instance.provider || !instance.workingDirectory) return;
    this.deps.host.save({ ...item, workerSession: {
      provider: instance.provider, model: instance.currentModel ?? null,
      accountProfileId: instance.accountProfileId ?? instance.copilotAccountProfileId ?? null,
      providerSessionId: instance.providerSessionId, workingDirectory: instance.workingDirectory, recordedAt: Date.now(),
    } });
  }

  /**
   * Close a worker whose conversation is saved, so it does not sit idle while its
   * work waits for a check; a fix round reopens that conversation. One that could
   * not be reopened stays open. True when the worker was closed; null when closing
   * failed and the item was parked, since an untracked worker would leave it stuck.
   */
  async closeIfSaved(item: PlanQueueItem, instanceId: string): Promise<boolean | null> {
    const sessionId = this.deps.host.instances.getInstance(instanceId)?.providerSessionId?.trim();
    if (!sessionId || item.workerSession?.providerSessionId !== sessionId) return false;
    try { await this.deps.stop(instanceId); }
    catch (error) {
      this.deps.host.transition(this.deps.host.getItem(item.id), 'parked', {
        parkReason: 'worker-error',
        detail: `Could not close the worker while its work waits for a check: ${errorMessage(error)}. Its session is retained. Resume retries stopping it before starting another worker.`,
      });
      return null;
    }
    return true;
  }

  watch(instance: Awaited<ReturnType<PlanQueueInstancePort['createInstance']>>, item: PlanQueueItem, prompt: string): void {
    if (instance.queueResumed) this.reopeningWorkers.add(instance.id);
    this.deps.host.tracker.track(instance.id);
    void Promise.resolve(instance.readyPromise).then(() => {
      this.reopeningWorkers.delete(instance.id);
      this.record(item.id, instance.id);
      const failure = this.startupFailures.get(instance.id);
      this.startupFailures.delete(instance.id);
      if (failure) void this.deps.failed(instance.id, failure);
    }, (error: unknown) => {
      if (!instance.queueResumed) {
        void this.deps.failed(instance.id, `worker failed to start: ${errorMessage(error)}`);
        return;
      }
      void this.deps.lock(item.id, async () => {
        let current = this.deps.host.getItem(item.id);
        if (current.workerInstanceId !== instance.id || !['working', 'fixing'].includes(current.state)) return;
        logger.info('Plan queue: could not reopen the worker conversation; starting fresh', { itemId: item.id, provider: current.workerSession?.provider });
        try { await this.deps.stop(instance.id); }
        catch (stopError) {
          this.deps.host.transition(this.deps.host.getItem(item.id), 'parked', {
            parkReason: 'worker-error', pendingInstruction: item.pendingInstruction,
            detail: `Could not stop the worker after its conversation failed to reopen: ${errorMessage(stopError)}. Its session is retained. Resume retries stopping it before starting another worker.`,
          });
          return;
        }
        current = this.deps.host.save({ ...this.deps.host.getItem(item.id), workerSession: undefined, workerInstanceId: null,
          pendingInstruction: item.pendingInstruction });
        await this.deps.spawn(current, prompt);
      }).catch((failure: unknown) => logger.error('Plan queue resume fallback failed', failure instanceof Error ? failure : undefined));
    });
  }
}

/** The worker stopped to ask something: put it to James as a question on the item. */
export function askJamesForWorker(host: Pick<PlanQueueFlowHost, 'save' | 'notifyParent' | 'getRun'>, item: PlanQueueItem, lastAssistantOutput: string | null): void {
  const text = lastAssistantOutput?.trim() || 'The worker stopped and is waiting for input.';
  const saved = host.save({
    ...item,
    question: {
      question: text.slice(0, 2000),
      options: [
        { id: 'continue', label: 'Carry on using your best judgement' },
        { id: 'park', label: 'Stop and park this item' },
      ],
    },
  });
  host.notifyParent(
    host.getRun(saved.runId),
    `Plan Queue: the worker for ${workSourceFor(saved.sourceKind).displayName(saved)} is waiting for James.\n\n${text.slice(0, 1500)}\n\n`
      + `Ask James, then call plan_queue_answer with item_id "${saved.id}" and option_id "continue" or "park". James can also answer the worker directly in its own session.`,
    [saved],
  );
}
