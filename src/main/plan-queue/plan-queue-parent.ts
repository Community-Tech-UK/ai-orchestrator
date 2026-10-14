/**
 * The session that started a Plan Queue run, followed across app restarts.
 *
 * Session ids are not kept across restarts: shutdown archives the parent and
 * history restore reopens the same conversation (same history thread) under a
 * new id. A run that kept the old id treated its parent as gone, so every
 * session it spawned after the restart had no parent. Each worker and
 * verifier then sat at the top of the project rail, and because they run in
 * `.worktrees/queue/...`, each showed as a project of its own. The run's
 * messages and controls also stopped reaching the session that started it.
 *
 * The run records its parent's thread, so the restored session is found by
 * thread even after a crash or a quit that archived nothing. Runs recorded
 * before the thread was stored fall back to the history entries archived
 * from the old id, and record the thread once found.
 *
 * Following the parent repoints the run at the restored session and adopts
 * the run's parentless sessions (including workers that boot recovery
 * respawned before the parent was restored) under it. Runs are followed as
 * soon as any session appears, so a restored parent takes its sessions back
 * at once, before a quick second restart could archive the entry that links
 * its old id to its thread.
 */

import { AUTOMATION_FAILURE_STATUSES } from '../../shared/types/instance-status-policy';
import { getLogger } from '../logging/logger';
import type { PlanQueueInstancePort, PlanQueueInstanceRecord, PlanQueueSessionTreePort } from './plan-queue-host';
import type { PlanQueueStore } from './plan-queue-store';
import type { PlanQueueRun } from './plan-queue.types';

const logger = getLogger('PlanQueueParent');

export interface PlanQueueParentDeps {
  instances: PlanQueueInstancePort & PlanQueueSessionTreePort;
  /** Runs without a recorded thread: the live session continuing `instanceId`'s conversation. */
  findRestoredSession?: (instanceId: string) => string | undefined;
  /**
   * Only the parent columns are written: a caller may hold its run snapshot
   * across awaits, and re-saving it would undo a cancel or pause made meanwhile.
   */
  store: Pick<PlanQueueStore, 'getRun' | 'setRunParent' | 'listActiveRuns'>;
  announce: (runId: string) => void;
}

export class PlanQueueParentTracker {
  constructor(private readonly deps: PlanQueueParentDeps) {}

  /**
   * The stored run, repointed at its restored parent when the recorded one is
   * gone or was superseded by an edit-and-resend (the hidden source stays in
   * memory; its replacement carries the same thread).
   */
  follow(run: PlanQueueRun): PlanQueueRun {
    const stored = this.deps.store.getRun(run.id) ?? run;
    const recorded = this.deps.instances.getInstance(stored.parentInstanceId);
    const parent = recorded?.status === 'superseded' ? undefined : recorded;
    const restored = parent ? undefined : this.findRestoredParent(stored, recorded);
    const current = parent ?? restored;
    if (!current) return stored;
    const thread = current.historyThreadId?.trim() || null;
    if (restored) {
      logger.info('Plan queue run follows its restored parent session', {
        runId: run.id,
        previousParentId: stored.parentInstanceId,
        parentId: restored.id,
      });
    } else if (!thread || thread === stored.parentHistoryThreadId) {
      this.adoptOrphans(stored);
      return stored;
    }
    // A restored parent, or a live one on a thread the run has not recorded:
    // recorded before threads were, or moved by a fresh restart of the parent.
    this.deps.store.setRunParent(run.id, current.id, thread);
    if (restored) this.deps.announce(run.id);
    const followed = this.deps.store.getRun(run.id) ?? { ...stored, parentInstanceId: current.id };
    this.adoptOrphans(followed);
    return followed;
  }

  /**
   * Called when a session appears (a restored parent) or is superseded (an
   * edited parent). Runs inside the instance manager's event path, so a
   * failure here is logged rather than thrown into the edit or creation.
   */
  followActiveRuns(): void {
    try {
      for (const run of this.deps.store.listActiveRuns()) this.follow(run);
    } catch (error) {
      logger.warn('Plan queue: could not follow run parents after a session change', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The parent to give a new queue session, or undefined while it is gone: a
   * child of a missing parent could not be shown nested, so it is shown at
   * the top of the rail until the parent is restored and adopts it.
   */
  liveParentId(run: PlanQueueRun): string | undefined {
    const current = this.follow(run);
    return this.deps.instances.getInstance(current.parentInstanceId) ? current.parentInstanceId : undefined;
  }

  notify(run: PlanQueueRun, message: string): void {
    const { parentInstanceId } = this.follow(run);
    const parent = this.deps.instances.getInstance(parentInstanceId);
    if (!parent || AUTOMATION_FAILURE_STATUSES.has(parent.status)) return;
    const options = { automatedInput: true, internalSource: 'plan-queue' as const };
    void this.deps.instances.sendInput(parentInstanceId, message, undefined, options).catch((error: unknown) => {
      logger.warn('Plan queue: could not message the parent session', {
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private findRestoredParent(
    run: PlanQueueRun,
    superseded: PlanQueueInstanceRecord | undefined,
  ): PlanQueueInstanceRecord | undefined {
    // The superseded source's own thread covers one that moved since it was
    // recorded; the history archived from the old id covers a gone parent's.
    const threads = new Set(
      [run.parentHistoryThreadId?.trim(), superseded?.historyThreadId?.trim()]
        .filter((thread): thread is string => !!thread),
    );
    const restoredId = pickSessionOnThreads(threads, run.parentInstanceId, this.deps.instances.getAllInstances())
      ?? this.deps.findRestoredSession?.(run.parentInstanceId);
    return restoredId ? this.deps.instances.getInstance(restoredId) : undefined;
  }

  /** Nest the run's sessions that lost their parent; adoption leaves any with a working parent alone. */
  private adoptOrphans(run: PlanQueueRun): void {
    if (!this.deps.instances.getInstance(run.parentInstanceId)) return;
    for (const instance of this.deps.instances.getAllInstances()) {
      if (
        instance.metadata?.['planQueueRunId'] === run.id
        && instance.parentId !== run.parentInstanceId
        && instance.id !== run.parentInstanceId
      ) {
        this.deps.instances.adoptOrphanInstance(instance.id, run.parentInstanceId);
      }
    }
  }
}

/**
 * The live session that continues the conversation `instanceId` held: the
 * history entries archived from that id name its thread, and a restore keeps
 * the thread. Queue sessions, edit-superseded sources and failed or ended
 * sessions (a native-resume attempt that did not take) never qualify; the
 * newest match wins.
 */
export function findRestoredSessionId(
  instanceId: string,
  entries: readonly { originalInstanceId: string; historyThreadId?: string }[],
  instances: readonly PlanQueueInstanceRecord[],
): string | undefined {
  const threads = new Set(
    entries
      .filter((entry) => entry.originalInstanceId === instanceId)
      .map((entry) => entry.historyThreadId?.trim())
      .filter((thread): thread is string => !!thread),
  );
  return pickSessionOnThreads(threads, instanceId, instances);
}

function pickSessionOnThreads(
  threads: ReadonlySet<string>,
  previousId: string,
  instances: readonly PlanQueueInstanceRecord[],
): string | undefined {
  return instances
    .filter((instance) =>
      instance.id !== previousId
      && !!instance.historyThreadId && threads.has(instance.historyThreadId.trim())
      && !AUTOMATION_FAILURE_STATUSES.has(instance.status)
      && typeof instance.metadata?.['planQueueRole'] !== 'string')
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))[0]?.id;
}
