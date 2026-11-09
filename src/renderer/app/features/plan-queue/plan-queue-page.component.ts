import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';
import { DEFAULT_PLAN_QUEUE_ROUTING } from '@contracts/schemas/plan-queue';
import { CopilotAccountIpcService } from '../../core/services/ipc/copilot-account-ipc.service';
import { ProviderAccountIpcService } from '../../core/services/ipc/provider-account-ipc.service';
import { InstanceStore } from '../../core/state/instance.store';
import type { Instance } from '../../core/state/instance/instance.types';
import { PlanQueueStore } from '../../core/state/plan-queue.store';
import { SettingsStore } from '../../core/state/settings.store';
import { PlanQueueAccountRulesPanelComponent } from './components/plan-queue-account-rules-panel.component';
import { PlanQueueFolderChecklistsPanelComponent } from './components/plan-queue-folder-checklists-panel.component';
import { PlanQueueFolderListPanelComponent } from './components/plan-queue-folder-list-panel.component';
import { PlanQueueHealthComponent } from './components/plan-queue-health.component';
import { PlanQueueNeedJamesListComponent } from './components/plan-queue-need-james-list.component';
import { PlanQueueParkedListComponent, type PlanQueueSetAsideAgentView } from './components/plan-queue-parked-list.component';
import { PlanQueueQuestionListComponent } from './components/plan-queue-question-list.component';
import { PlanQueueRoutingPanelComponent } from './components/plan-queue-routing-panel.component';
import { upgradePlanQueueRouting } from '../../../../shared/utils/plan-queue-routing-upgrade';
import { machineSessionReasonOf } from '../../../../shared/utils/machine-session';
import { AUTOMATION_FAILURE_STATUSES } from '../../../../shared/types/instance-status-policy';
import type { PlanQueueSessionOption } from './components/plan-queue-run-owner.component';
import { PlanQueueRunListComponent, planQueueRoutingSummary, type PlanQueueAccountLabel } from './components/plan-queue-run-list.component';
import type { PlanQueueParentSessionOption, PlanQueueStartRequest } from './components/plan-queue-start-form.component';
import { PlanQueueStartFormComponent } from './components/plan-queue-start-form.component';
import { PlanQueueSkipPendingComponent } from './components/plan-queue-skip-pending.component';
import { planQueueKindLabel, pluralise } from '../../../../shared/utils/plan-queue-item-display';

/** Marks a Set aside agent; `SET_ASIDE_FOLDER_METADATA` in the main process's plan-queue-set-aside.ts. */
const SET_ASIDE_AGENT_METADATA = 'planQueueSetAsideFolder';

/** Current work, retained work, and provider setup, each in its own tab. */
@Component({
  selector: 'app-plan-queue-page',
  standalone: true,
  imports: [
    RouterLink,
    AioTooltipDirective,
    PlanQueueAccountRulesPanelComponent,
    PlanQueueFolderChecklistsPanelComponent,
    PlanQueueFolderListPanelComponent,
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
  private readonly router = inject(Router);
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
    .filter(item => item.state !== 'parked' && item.state !== 'landed' && item.state !== 'skipped').map(item => item.sourceRef));
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

  /**
   * Every session that may own a run, so a helper-session owner is still named. A new parent must be a root
   * session, as in the start form, and not a Queue, Set aside or failed session, which the main process refuses.
   */
  protected readonly runSessions = computed<PlanQueueSessionOption[]>(() =>
    this.instanceStore.instances()
      .filter(instance => machineSessionReasonOf(instance) !== 'plan-queue')
      .map(instance => ({
        id: instance.id,
        label: `${instance.displayName} (${instance.provider}) — ${instance.workingDirectory}`,
        canBeParent: !instance.parentId && !AUTOMATION_FAILURE_STATUSES.has(instance.status)
          && instance.metadata?.[SET_ASIDE_AGENT_METADATA] === undefined,
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

  onResumeItems(itemIds: string[]): void {
    void this.store.resumeItems(itemIds);
  }

  onRetryLandings(itemIds: string[]): void {
    void this.store.retryLandings(itemIds);
  }

  onRetryLanding(itemId: string): void {
    void this.store.control({ action: 'retry-landing', itemId });
  }

  onLandAnyway(itemId: string): void {
    void this.store.control({ action: 'land-anyway', itemId });
  }

  /** Folders whose Set aside agent has been asked for and has not appeared yet. */
  private readonly startingAgentFolders = signal<ReadonlySet<string>>(new Set());

  /** Each folder's newest Set aside agent, so the page shows its progress without opening it. */
  protected readonly setAsideAgents = computed(() => {
    const newest = new Map<string, Instance>();
    for (const instance of this.instanceStore.instances()) {
      const folder = instance.metadata?.[SET_ASIDE_AGENT_METADATA];
      if (typeof folder !== 'string') continue;
      const current = newest.get(folder);
      if (!current || instance.createdAt > current.createdAt) newest.set(folder, instance);
    }
    const agents = new Map<string, PlanQueueSetAsideAgentView>();
    for (const [folder, instance] of newest) {
      // Mirrors PlanQueueSetAsideAgents.isWorking in the main process.
      const state = AUTOMATION_FAILURE_STATUSES.has(instance.status) ? 'stopped'
        : instance.status === 'idle' || instance.status === 'ready' ? 'finished' : 'working';
      agents.set(folder, { state, instanceId: instance.id });
    }
    for (const folder of this.startingAgentFolders()) agents.set(folder, { state: 'starting', instanceId: null });
    return agents;
  });

  /** Starts the folder's agent and stays on this page; the list shows how it is getting on. */
  async onSortOut(folder: string): Promise<void> {
    this.startingAgentFolders.update(old => new Set(old).add(folder));
    try {
      await this.store.startSetAsideAgent(folder);
    } finally {
      this.startingAgentFolders.update(old => { const next = new Set(old); next.delete(folder); return next; });
    }
  }

  onSortOutAll(folders: string[]): void {
    for (const folder of folders) void this.onSortOut(folder);
  }

  onOpenAgent(instanceId: string): void {
    this.instanceStore.setSelectedInstance(instanceId);
    void this.router.navigate(['/']);
  }

  onDiscardItem(itemId: string): void {
    void this.store.control({ action: 'discard-item', itemId });
  }
}
