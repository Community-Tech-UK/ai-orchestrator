/** Provider conversation recording and one fresh-start retry for a failed reopen. */
import { getLogger } from '../logging/logger';
import type { PlanQueueFlowHost, PlanQueueInstancePort } from './plan-queue-host';
import { hasCheckout } from './plan-queue-orphan-checkout';
import { unresolvedMergeFiles } from './plan-queue-git';
import { buildConflictPrompt } from './plan-queue-prompts';
import type { PlanQueueRun, PlanQueueItem } from './plan-queue.types';
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
  promptContext(run: PlanQueueRun, item: PlanQueueItem) {
    return {
      item,
      kind: run.kind,
      repoRoot: run.workspaceCwd,
      worktreePath: item.worktreePath ?? '',
      answer: item.answer,
    };
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
