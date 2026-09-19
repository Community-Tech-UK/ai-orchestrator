import { ChangeDetectionStrategy, Component, OnInit, computed, inject } from '@angular/core';
import { InstanceStore } from '../../core/state/instance.store';
import { PlanQueueStore } from '../../core/state/plan-queue.store';
import { PlanQueueAlertsListComponent } from './components/plan-queue-alerts-list.component';
import { PlanQueueNeedJamesListComponent } from './components/plan-queue-need-james-list.component';
import { PlanQueueParkedListComponent } from './components/plan-queue-parked-list.component';
import { PlanQueueRunListComponent } from './components/plan-queue-run-list.component';
import type { PlanQueueParentSessionOption, PlanQueueStartRequest } from './components/plan-queue-start-form.component';
import { PlanQueueStartFormComponent } from './components/plan-queue-start-form.component';

/**
 * The Plan Queue control surface: start a run against a chosen session,
 * answer triage/verifier questions, resolve parked work, watch reconciler
 * alerts, and see what a livetest run still genuinely needs James for.
 */
@Component({
  selector: 'app-plan-queue-page',
  standalone: true,
  imports: [
    PlanQueueAlertsListComponent,
    PlanQueueNeedJamesListComponent,
    PlanQueueParkedListComponent,
    PlanQueueRunListComponent,
    PlanQueueStartFormComponent,
  ],
  templateUrl: './plan-queue-page.component.html',
  styleUrl: './plan-queue-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueuePageComponent implements OnInit {
  protected readonly store = inject(PlanQueueStore);
  private readonly instanceStore = inject(InstanceStore);

  protected readonly parentSessions = computed<PlanQueueParentSessionOption[]>(() =>
    this.instanceStore.rootInstances().map((instance) => ({
      id: instance.id,
      label: `${instance.displayName} (${instance.provider})`,
      workingDirectory: instance.workingDirectory,
    })),
  );

  ngOnInit(): void {
    this.store.ensureWired();
    void this.store.load();
  }

  onStart(request: PlanQueueStartRequest): void {
    void this.store.startRun(request);
  }

  onRefreshAlerts(): void {
    void this.store.refreshAlerts();
  }

  onPauseRun(runId: string): void {
    void this.store.control({ action: 'pause', runId });
  }

  onResumeRun(runId: string): void {
    void this.store.control({ action: 'resume', runId });
  }

  onCancelRun(runId: string): void {
    void this.store.control({ action: 'cancel', runId });
  }

  onAnswer(event: { itemId: string; optionId: string }): void {
    void this.store.answer(event.itemId, event.optionId);
  }

  onSkipItem(itemId: string): void {
    void this.store.control({ action: 'skip-item', itemId });
  }

  onResumeItem(itemId: string): void {
    void this.store.control({ action: 'resume-item', itemId });
  }

  onLandAnyway(itemId: string): void {
    void this.store.control({ action: 'land-anyway', itemId });
  }

  onDiscardItem(itemId: string): void {
    void this.store.control({ action: 'discard-item', itemId });
  }
}
