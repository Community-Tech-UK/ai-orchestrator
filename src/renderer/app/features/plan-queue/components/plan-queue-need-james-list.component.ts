import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { PlanQueueNeedJamesRecord } from '../../../core/state/plan-queue.store';

export interface PlanQueueNeedJamesGroup {
  readonly runId: string;
  readonly records: readonly PlanQueueNeedJamesRecord[];
}

/**
 * Every "real" open check left by a livetest run, grouped per run. Policy-gated
 * checks (blocked by a setting or approval rule, relaxable) appear only as a
 * count; stale ones are omitted because they should simply be retried.
 */
@Component({
  selector: 'app-plan-queue-need-james-list',
  standalone: true,
  imports: [],
  templateUrl: './plan-queue-need-james-list.component.html',
  styleUrl: './plan-queue-need-james-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueNeedJamesListComponent {
  records = input<PlanQueueNeedJamesRecord[]>([]);
  policyGatedCount = input<number>(0);

  readonly groupedByRun = computed<PlanQueueNeedJamesGroup[]>(() => {
    const byRun = new Map<string, PlanQueueNeedJamesRecord[]>();
    for (const record of this.records()) {
      const bucket = byRun.get(record.runId);
      if (bucket) bucket.push(record);
      else byRun.set(record.runId, [record]);
    }
    return Array.from(byRun, ([runId, records]) => ({ runId, records }));
  });
}
