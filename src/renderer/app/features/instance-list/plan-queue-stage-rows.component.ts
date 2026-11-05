import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import type { PlanQueueStageLine } from '../plan-queue/plan-queue-stage-text';
import { PlanQueueStageService, type PlanQueueStageRun } from '../plan-queue/plan-queue-stage.service';

/**
 * Session-list rows for Plan Queue steps that have no session: Harness running a job's checks, landing it, or the
 * job waiting for either. One job shows as one row; several collapse into one summary that expands to each job.
 * Renders nothing when no such step is running.
 */
@Component({
  selector: 'app-plan-queue-stage-rows',
  standalone: true,
  imports: [AioTooltipDirective],
  templateUrl: './plan-queue-stage-rows.component.html',
  styleUrl: './plan-queue-stage-rows.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueStageRowsComponent {
  private readonly stages = inject(PlanQueueStageService);
  private readonly router = inject(Router);

  /** Show the runs started from this session. */
  readonly parentInstanceId = input<string | null>(null);
  /** Or: show this project's runs whose starting session is gone. */
  readonly projectKey = input<string | null>(null);
  /** The parent row's depth; these rows sit one level in, where its child sessions do. */
  readonly depth = input(0);

  private readonly expandedRuns = signal<ReadonlySet<string>>(new Set<string>());

  protected readonly runs = computed<readonly PlanQueueStageRun[]>(() => {
    const parent = this.parentInstanceId();
    if (parent) return this.stages.forParent(parent);
    const project = this.projectKey();
    return project ? this.stages.forProject(project) : [];
  });

  protected readonly indent = computed(() => 6 + (this.depth() + 1) * 18);

  protected isExpanded(runId: string): boolean { return this.expandedRuns().has(runId); }

  protected hasLong(run: PlanQueueStageRun): boolean { return run.lines.some(line => line.long); }

  protected lineTooltip(line: PlanQueueStageLine): string { return `${line.hint} Opens Plan Queue.`; }

  protected toggle(runId: string): void {
    this.expandedRuns.update(current => {
      const next = new Set(current);
      if (!next.delete(runId)) next.add(runId);
      return next;
    });
  }

  protected open(): void { void this.router.navigate(['/plan-queue']); }
}
