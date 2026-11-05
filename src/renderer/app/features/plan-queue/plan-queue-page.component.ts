import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';
import { DEFAULT_PLAN_QUEUE_ROUTING } from '@contracts/schemas/plan-queue';
import { CopilotAccountIpcService } from '../../core/services/ipc/copilot-account-ipc.service';
import { ProviderAccountIpcService } from '../../core/services/ipc/provider-account-ipc.service';
import { InstanceStore } from '../../core/state/instance.store';
import { PlanQueueStore } from '../../core/state/plan-queue.store';
import { SettingsStore } from '../../core/state/settings.store';
import { PlanQueueAccountRulesPanelComponent } from './components/plan-queue-account-rules-panel.component';
import { PlanQueueHealthComponent } from './components/plan-queue-health.component';
import { PlanQueueNeedJamesListComponent } from './components/plan-queue-need-james-list.component';
import { PlanQueueParkedListComponent } from './components/plan-queue-parked-list.component';
import { PlanQueueQuestionListComponent } from './components/plan-queue-question-list.component';
import { PlanQueueRoutingPanelComponent } from './components/plan-queue-routing-panel.component';
import { upgradePlanQueueRouting } from '../../../../shared/utils/plan-queue-routing-upgrade';
import { PlanQueueRunListComponent, planQueueRoutingSummary, type PlanQueueAccountLabel } from './components/plan-queue-run-list.component';
import type { PlanQueueParentSessionOption, PlanQueueStartRequest } from './components/plan-queue-start-form.component';
import { PlanQueueStartFormComponent } from './components/plan-queue-start-form.component';
import { PlanQueueSkipPendingComponent } from './components/plan-queue-skip-pending.component';
import { planQueueKindLabel, pluralise } from './plan-queue-item-display';

/** Current work, retained work, and provider setup, each in its own tab. */
@Component({
  selector: 'app-plan-queue-page',
  standalone: true,
  imports: [
    RouterLink,
    AioTooltipDirective,
    PlanQueueAccountRulesPanelComponent,
    PlanQueueHealthComponent,
    PlanQueueNeedJamesListComponent,
    PlanQueueParkedListComponent,
    PlanQueueQuestionListComponent,
    PlanQueueRoutingPanelComponent,
    PlanQueueRunListComponent,
    PlanQueueStartFormComponent,
    PlanQueueSkipPendingComponent,
  ],
  templateUrl: './plan-queue-page.component.html',
  styleUrl: './plan-queue-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueuePageComponent implements OnInit {
  protected readonly copy = copyFor;
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

  protected readonly tabs = [
    { id: 'now', label: 'Now' }, { id: 'aside', label: 'Set aside' }, { id: 'setup', label: 'Setup' },
  ] as const;
  protected readonly activeTab = signal<'now' | 'aside' | 'setup'>('now');
  protected readonly activeRuns = computed(() => this.store.allRuns().filter(run => run.status === 'running' || run.status === 'paused'));
  protected readonly activeItems = computed(() => this.activeRuns().flatMap(run => run.items));
  protected readonly historyRuns = computed(() => this.store.allRuns().filter(run => run.status === 'completed' || run.status === 'cancelled'));
  protected readonly busyDocuments = computed(() => this.activeRuns().flatMap(run => run.items)
    .filter(item => item.state !== 'parked' && item.state !== 'landed' && item.state !== 'skipped').map(item => item.documentPath));
  protected readonly checkerRunId = signal<string | null>(null);
  protected readonly checkerRuns = computed(() => this.store.allRuns().filter(run => run.id === this.checkerRunId()));
  protected readonly kindLabel = planQueueKindLabel;
  protected readonly pluralise = pluralise;
  protected readonly historyDate = (at: number) => new Date(at).toLocaleString();
  protected readonly openHistory = signal<ReadonlySet<string>>(new Set());

  onHistoryToggle(runId: string, event: Event): void {
    const open = (event.target as HTMLDetailsElement).open;
    this.openHistory.update(previous => {
      const next = new Set(previous);
      if (open) next.add(runId); else next.delete(runId);
      return next;
    });
  }

  onTabKey(event: KeyboardEvent, index: number): void {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2
      : event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : null;
    if (next === null) return;
    event.preventDefault();
    this.activeTab.set(this.tabs[next].id);
    const list = (event.target as HTMLElement).closest('[role="tablist"]');
    (list?.querySelectorAll<HTMLElement>('[role="tab"]')[next])?.focus();
  }

  onChooseChecker(runId: string): void { this.checkerRunId.set(runId); this.activeTab.set('setup'); }

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

  onRefreshHealth(): void {
    void this.store.load();
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
