import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { DEFAULT_PLAN_QUEUE_ROUTING } from '@contracts/schemas/plan-queue';
import { CopilotAccountIpcService } from '../../core/services/ipc/copilot-account-ipc.service';
import { ProviderAccountIpcService } from '../../core/services/ipc/provider-account-ipc.service';
import { InstanceStore } from '../../core/state/instance.store';
import { PlanQueueStore } from '../../core/state/plan-queue.store';
import { SettingsStore } from '../../core/state/settings.store';
import { PlanQueueAccountRulesPanelComponent } from './components/plan-queue-account-rules-panel.component';
import { PlanQueueAlertsListComponent } from './components/plan-queue-alerts-list.component';
import { PlanQueueNeedJamesListComponent } from './components/plan-queue-need-james-list.component';
import { PlanQueueParkedListComponent } from './components/plan-queue-parked-list.component';
import { PlanQueueQuestionListComponent } from './components/plan-queue-question-list.component';
import { PlanQueueRoutingPanelComponent } from './components/plan-queue-routing-panel.component';
import { upgradePlanQueueRouting } from '../../../../shared/utils/plan-queue-routing-upgrade';
import { PlanQueueRunListComponent, planQueueRoutingSummary, type PlanQueueAccountLabel } from './components/plan-queue-run-list.component';
import type { PlanQueueParentSessionOption, PlanQueueStartRequest } from './components/plan-queue-start-form.component';
import { PlanQueueStartFormComponent } from './components/plan-queue-start-form.component';

/**
 * The Plan Queue control surface, in operator order: the questions waiting on
 * James, then which providers and accounts new runs use (one line, opened with
 * Change, so a long run list never hides it), then the account rules (accounts
 * to avoid or use last), then the runs and their
 * Pause/Resume/Cancel controls, then starting a run, then history (livetest
 * checks only James can do, parked work and reconciler alerts). Each section
 * opens with one plain-English purpose line.
 */
@Component({
  selector: 'app-plan-queue-page',
  standalone: true,
  imports: [
    PlanQueueAccountRulesPanelComponent,
    PlanQueueAlertsListComponent,
    PlanQueueNeedJamesListComponent,
    PlanQueueParkedListComponent,
    PlanQueueQuestionListComponent,
    PlanQueueRoutingPanelComponent,
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
  private readonly settingsStore = inject(SettingsStore);
  private readonly providerAccountIpc = inject(ProviderAccountIpcService);
  private readonly copilotAccountIpc = inject(CopilotAccountIpcService);

  /** Account display names keyed `provider:id`, so summaries never show internal ids such as "legacy". */
  private readonly accountLabels = signal<ReadonlyMap<string, string>>(new Map());
  protected readonly accountLabel = computed<PlanQueueAccountLabel>(() => {
    const labels = this.accountLabels();
    return (provider, id) => labels.get(`${provider}:${id}`) ?? id;
  });

  protected readonly editingDefaults = signal(false);
  protected readonly defaultsSummary = computed(() => planQueueRoutingSummary(
    upgradePlanQueueRouting(this.settingsStore.settings().planQueueRouting ?? DEFAULT_PLAN_QUEUE_ROUTING),
    { noWorkers: 'same as the session that starts the run', accountLabel: this.accountLabel() },
  ));

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
    void this.loadAccountLabels();
  }

  /** Best effort: until (or unless) the lists load, summaries show account ids; the editor reports load failures. */
  private async loadAccountLabels(): Promise<void> {
    const [pooled, copilot] = await Promise.allSettled([this.providerAccountIpc.list(), this.copilotAccountIpc.list()]);
    const labels = new Map<string, string>();
    if (pooled.status === 'fulfilled') for (const profile of pooled.value?.profiles ?? []) labels.set(`${profile.provider}:${profile.id}`, profile.label);
    if (copilot.status === 'fulfilled') for (const profile of copilot.value ?? []) labels.set(`copilot:${profile.id}`, profile.label);
    this.accountLabels.set(labels);
  }

  onStart(request: PlanQueueStartRequest): void {
    void this.store.startRun(request);
  }

  onRefreshAlerts(): void {
    void this.store.refreshAlerts();
  }

  protected readonly runningCount = computed(() => this.store.allRuns().filter(run => run.status === 'running').length);
  protected readonly pausedCount = computed(() => this.store.allRuns().filter(run => run.status === 'paused').length);

  onPauseAll(): void { void this.store.control({ action: 'pause-all' }); }
  onResumeAll(): void { void this.store.control({ action: 'resume-all' }); }

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

  onRetryLanding(itemId: string): void {
    void this.store.control({ action: 'retry-landing', itemId });
  }

  onLandAnyway(itemId: string): void {
    void this.store.control({ action: 'land-anyway', itemId });
  }

  onDiscardItem(itemId: string): void {
    void this.store.control({ action: 'discard-item', itemId });
  }
}
