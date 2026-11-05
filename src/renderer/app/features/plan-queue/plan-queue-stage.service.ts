import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { InstanceStore } from '../../core/state/instance.store';
import { PlanQueueStore } from '../../core/state/plan-queue.store';
import { isProjectRailHiddenSession } from '../../../../shared/utils/project-rail-hidden-session';
import { ProjectRailPathService } from '../instance-list/project-rail-path.service';
import { PLAN_QUEUE_STAGE_TICK_MS, planQueueStageLine, planQueueStageSummary, type PlanQueueStageLine } from './plan-queue-stage-text';

/** One running Plan Queue run's jobs that are in a step with no session (checks, landing, or waiting for either). */
export interface PlanQueueStageRun {
  readonly runId: string;
  readonly summary: string;
  readonly lines: readonly PlanQueueStageLine[];
}

const NONE: readonly PlanQueueStageRun[] = [];

function add(map: Map<string, PlanQueueStageRun[]>, key: string, run: PlanQueueStageRun): void {
  const list = map.get(key);
  if (list) list.push(run); else map.set(key, [run]);
}

/**
 * Where the session list shows Plan Queue steps that have no session. A run's rows sit under the session that
 * started it; when that session is gone they sit at the top of the run's project. Times come from the queue's
 * stored history and move on with a shared clock while any such step exists.
 */
@Injectable({ providedIn: 'root' })
export class PlanQueueStageService {
  private readonly queue = inject(PlanQueueStore);
  private readonly instances = inject(InstanceStore);
  private readonly paths = inject(ProjectRailPathService);
  private readonly tick = signal(0);

  private readonly runsWithStages = computed(() =>
    this.queue.allRuns().filter(run => run.status === 'running' && run.items.some(item => item.stage)));
  private readonly active = computed(() => this.runsWithStages().length > 0);

  /** Recomputed on each tick and on every queue or session change, measuring times to the current moment. */
  private readonly placed = computed(() => {
    const byParent = new Map<string, PlanQueueStageRun[]>();
    const byProject = new Map<string, PlanQueueStageRun[]>();
    // Nothing in such a step: skip reading the session list, which changes often.
    if (!this.active()) return { byParent, byProject };
    this.tick();
    const now = Date.now();
    const shown = new Set(this.instances.instances()
      .filter(instance => instance.status !== 'superseded' && !isProjectRailHiddenSession(instance.metadata))
      .map(instance => instance.id));
    for (const run of this.runsWithStages()) {
      const lines = run.items.flatMap(item => planQueueStageLine(item, now) ?? []);
      const entry = { runId: run.id, summary: planQueueStageSummary(lines), lines };
      if (shown.has(run.parentInstanceId)) add(byParent, run.parentInstanceId, entry);
      else add(byProject, this.paths.getProjectKey(run.workspaceCwd), entry);
    }
    return { byParent, byProject };
  });

  constructor() {
    this.queue.ensureLoaded();
    effect((onCleanup) => {
      if (!this.active()) return;
      const timer = setInterval(() => this.tick.update(count => count + 1), PLAN_QUEUE_STAGE_TICK_MS);
      onCleanup(() => clearInterval(timer));
    });
  }

  /** Runs started from this session. */
  forParent(instanceId: string): readonly PlanQueueStageRun[] { return this.placed().byParent.get(instanceId) ?? NONE; }

  /** Runs in this project whose starting session is no longer in the list. */
  forProject(projectKey: string): readonly PlanQueueStageRun[] { return this.placed().byProject.get(projectKey) ?? NONE; }
}
