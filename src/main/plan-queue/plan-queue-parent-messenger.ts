/** Parent recovery replays pending questions regardless of who resolves ownership first. */
import { AUTOMATION_FAILURE_STATUSES } from '../../shared/types/instance-status-policy';
import { getLogger } from '../logging/logger';
import type { PlanQueueInstancePort } from './plan-queue-host';
import { buildQuestionsMessage } from './plan-queue-messages';
import { resolveRunParent, type ParentDeps } from './plan-queue-run-parent';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

const logger = getLogger('PlanQueueParentMessenger');
interface Delivery { status: 'pending' | 'sending' | 'sent' }
interface Replay {
  parentId: string;
  questions: Map<string, Delivery>;
}
function identity(item: PlanQueueItem): string {
  return JSON.stringify([item.id, item.state, item.question]);
}

export class PlanQueueParentMessenger {
  // Only questions present at an ownership change are retained, until resolved or run end.
  private readonly replays = new Map<string, Replay>();
  private stopped = false;
  constructor(private readonly deps: ParentDeps & {
    instances: PlanQueueInstancePort;
    listItems: (runId: string) => PlanQueueItem[];
  }) {}

  clear(runId?: string): void {
    if (runId) this.replays.delete(runId);
    else this.replays.clear();
  }

  shutdown(): void {
    this.stopped = true;
    this.clear();
  }

  onParentChanged(run: PlanQueueRun, notifying: readonly PlanQueueItem[] = []): void {
    if (this.stopped) return;
    const questions = this.deps.listItems(run.id).filter((item) => item.question);
    this.replays.set(run.id, { parentId: run.parentInstanceId,
      questions: new Map(questions.map((item) => [identity(item), { status: 'pending' as const }])) });
    this.replay(run, notifying);
  }

  resolve(run: PlanQueueRun, notifying: readonly PlanQueueItem[] = []): string | undefined {
    const parentId = resolveRunParent(run, { ...this.deps,
      onParentChanged: (rebound) => this.onParentChanged(rebound, notifying) });
    if (parentId) this.replay(run, notifying);
    return parentId;
  }

  notify(run: PlanQueueRun, message: string, questions?: readonly PlanQueueItem[]): void {
    if (this.stopped) return;
    const parentId = this.resolve(run, questions);
    if (!parentId) return;
    const replay = this.replays.get(run.id);
    const unsent = questions?.filter((item) => {
      const status = replay?.questions.get(identity(item))?.status;
      return status !== 'sending' && status !== 'sent';
    });
    if (unsent?.length === 0) return;
    this.send(run, parentId, unsent && unsent.length !== questions?.length ? buildQuestionsMessage(unsent) : message, unsent ?? []);
  }

  private replay(run: PlanQueueRun, notifying: readonly PlanQueueItem[]): void {
    const replay = this.replays.get(run.id);
    if (!replay || replay.parentId !== run.parentInstanceId) return;
    const current = this.deps.listItems(run.id).filter((item) => item.question);
    const keys = new Set(current.map(identity));
    for (const key of replay.questions.keys()) if (!keys.has(key)) replay.questions.delete(key);
    if (!replay.questions.size) { this.clear(run.id); return; }
    const excluded = new Set(notifying.map(identity));
    const pending = current.filter((item) => replay.questions.get(identity(item))?.status === 'pending' && !excluded.has(identity(item)));
    if (pending.length) this.send(run, replay.parentId, buildQuestionsMessage(pending), pending);
  }

  private send(run: PlanQueueRun, parentId: string, message: string, questions: readonly PlanQueueItem[]): void {
    const parent = this.deps.instances.getInstance(parentId);
    if (!parent || AUTOMATION_FAILURE_STATUSES.has(parent.status)) return;
    const replay = this.replays.get(run.id);
    const deliveries = questions.flatMap((item) => {
      const delivery = replay?.questions.get(identity(item));
      if (!delivery) return [];
      delivery.status = 'sending';
      return [delivery];
    });
    // Settling an old-owner send only touches its captured entries, never a newer replay.
    void this.deps.instances.sendInput(parentId, message, undefined, { automatedInput: true, internalSource: 'plan-queue' })
      .then(() => { for (const delivery of deliveries) delivery.status = 'sent'; })
      .catch((error: unknown) => {
        for (const delivery of deliveries) delivery.status = 'pending';
        logger.warn('Plan queue: could not message the parent session', {
          runId: run.id, error: error instanceof Error ? error.message : String(error),
        });
      });
  }
}
