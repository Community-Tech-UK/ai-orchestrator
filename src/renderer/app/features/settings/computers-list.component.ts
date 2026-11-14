/**
 * The Computers list: paired computers in the order Harness tries them, each test machine with the computer it's
 * part of or on its own, and this Mac last. In Settings it changes things; on the Control Center page (`readOnly`) it
 * only shows.
 */
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { RemoteNodeIpcService } from '../../core/services/ipc/remote-node-ipc.service';
import { ProviderAccountIpcService } from '../../core/services/ipc/provider-account-ipc.service';
import { AppIconButtonDirective } from '../../shared/tooltip/icon-button.directive';
import { presentError } from '../../../../shared/present-error';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';
import type { TestMachineView, WorkToday } from '../../../../shared/types/computers.types';
import type { QueueJobComputer } from '../../../../shared/types/plan-queue-computers.types';
import {
  MAX_QUEUE_JOBS_AT_ONCE,
  MIN_QUEUE_JOBS_AT_ONCE,
  type QueueJobProject,
  type QueueJobsChange,
  type QueueJobsPageView,
} from '../../../../shared/types/plan-queue-computers-page.types';
import type { ComputerChoice } from '../../../../shared/types/settings.types';
import type { PooledProvider } from '../../../../shared/types/provider-account.types';
import {
  buildComputerRows,
  changedChoices,
  describeFolders,
  describeNow,
  describeQueueProjects,
  describeQueueTakes,
  describeSetup,
  describeTakes,
  describeToday,
  describeTools,
  movedChoices,
  NEEDS_NEWER_HARNESS,
  offersSetup,
  providersWithAccounts,
  queueJobsSupported,
  workerSettingsFiles,
  type ComputerDetail,
  type ComputerRow,
  type DetailLine,
  type QueueProjectLine,
  type SetupStep,
} from './computers-list.model';

/** A paired computer's Plan Queue settings, whether it can take jobs, and its projects in words. */
interface QueueRowView {
  computer: QueueJobComputer;
  /** False when it reports no Plan Queue ability, null while it's away and can't be asked. */
  supported: boolean | null;
  projects: QueueProjectLine[];
}

/** Field by field, so the order keys were stored in can't make a kept change look lost. */
function sameChoices(a: readonly ComputerChoice[], b: readonly ComputerChoice[]): boolean {
  return a.length === b.length
    && a.every((choice, at) => choice.id === b[at]!.id && choice.paused === b[at]!.paused && choice.sessions === b[at]!.sessions);
}

const checkKey = (row: ComputerRow, project: QueueJobProject) => `${row.id}|${project.repoRoot}`;

function withoutKey<V>(map: ReadonlyMap<string, V>, key: string): Map<string, V> {
  const next = new Map(map);
  next.delete(key);
  return next;
}

/** How often the list reads the test machine and today's work again while it's open. */
const REFRESH_MS = 60_000;
const SLOT_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8];
const JOBS_AT_ONCE_CHOICES = Array.from({ length: MAX_QUEUE_JOBS_AT_ONCE - MIN_QUEUE_JOBS_AT_ONCE + 1 }, (_, index) => MIN_QUEUE_JOBS_AT_ONCE + index);

@Component({
  standalone: true,
  selector: 'app-computers-list',
  imports: [AppIconButtonDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './computers-list.component.html',
  styleUrl: './computers-list.component.scss',
})
export class ComputersListComponent {
  private readonly store = inject(SettingsStore);
  private readonly ipc = inject(RemoteNodeIpcService);
  private readonly accounts = inject(ProviderAccountIpcService);

  /** Paired computers, connected or not, as the roster has them. */
  readonly nodes = input<readonly RemoteNodeRosterEntry[]>([]);
  /** Show only; the Control Center page links to Settings for changes. */
  readonly readOnly = input(false);

  private readonly testMachines = signal<TestMachineView[]>([]);
  /** Whether this Mac takes work when the test machines are busy or away. */
  protected readonly useThisMac = signal(true);
  protected readonly hasTestMachines = computed(() => this.testMachines().length > 0);
  private readonly today = signal<WorkToday | null>(null);
  /** Raw detail of the last failure, for Details. The visible sentence is fixed. */
  protected readonly loadFailure = signal<string | null>(null);
  protected readonly saveFailure = signal<string | null>(null);
  protected readonly saving = signal(false);
  private readonly now = signal(Date.now());
  /** This Mac's names for its Claude and Codex accounts, keyed `provider:profileId`, to name them on other computers. */
  private readonly accountLabels = signal(new Map<string, string>());
  /** Tools whose names have been asked for: reading them runs this Mac's own sign-in checks, so once each. */
  private readonly labelsRequested = new Set<string>();
  /** Counts saved test-machine changes, so a refresh that started before one can't put the old values back. */
  private testMachineChanges = 0;
  /** The same for Plan Queue changes and project checks. */
  private queueJobChanges = 0;
  private readonly queueView = signal<QueueJobsPageView>({ computers: [], projects: [] });
  protected readonly queueLoadFailure = signal<string | null>(null);
  /** Projects being checked now, as `computer id|repository`. A check can take minutes. */
  private readonly checking = signal<ReadonlySet<string>>(new Set());
  /** Raw detail of each project's last failed check, by the same key. The visible sentence is fixed. */
  private readonly checkFailures = signal<ReadonlyMap<string, string>>(new Map());

  protected readonly slotChoices = SLOT_CHOICES;
  protected readonly jobsAtOnceChoices = JOBS_AT_ONCE_CHOICES;
  protected readonly needsNewerHarness = NEEDS_NEWER_HARNESS;
  protected readonly rows = computed(() => buildComputerRows(this.nodes(), this.store.computers(), this.testMachines(), {
    browser: this.store.remoteNodesAutoOffloadBrowser(),
    android: this.store.remoteNodesAutoOffloadAndroid(),
  }));
  protected readonly pairedCount = computed(() => this.rows().filter(row => row.kind === 'paired').length);
  protected readonly todayLines = computed(() => {
    const today = this.today();
    const machines = this.testMachines();
    if (!today || !machines.length) return [];
    return describeToday(today, machines.length === 1 ? machines[0]!.label : 'your test machines');
  });

  constructor() {
    void this.load();
    effect(() => {
      for (const provider of providersWithAccounts(this.rows())) void this.loadAccountLabels(provider);
    });
    const timer = setInterval(() => {
      this.now.set(Date.now());
      void this.load();
    }, REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected describeNow(row: ComputerRow): string | null {
    return describeNow(row, this.now());
  }

  protected describeTakes(row: ComputerRow): string {
    return describeTakes(row, this.useThisMac());
  }

  /** "Plan Queue jobs, 2 at once" for a paired computer that takes them, for the read-only list. */
  protected describeQueueTakes(row: ComputerRow): string | null {
    return describeQueueTakes(this.queueView().computers.find(computer => computer.nodeId === row.id));
  }

  /** Null for this Mac and test machines on their own, and until the settings have been read. */
  protected queue(row: ComputerRow): QueueRowView | null {
    if (row.kind !== 'paired') return null;
    const view = this.queueView();
    const computer = view.computers.find(entry => entry.nodeId === row.id);
    if (!computer) return null;
    const supported = queueJobsSupported(this.nodes().find(node => node.id === row.id));
    return { computer, supported, projects: describeQueueProjects(view.projects, computer.projects, this.now()) };
  }

  protected isChecking(row: ComputerRow, project: QueueJobProject): boolean {
    return this.checking().has(checkKey(row, project));
  }

  protected checkFailure(row: ComputerRow, project: QueueJobProject): string | undefined {
    return this.checkFailures().get(checkKey(row, project));
  }

  protected offersSetup(row: ComputerRow): boolean {
    return offersSetup(row);
  }

  protected describeSetup(row: ComputerRow): SetupStep[] {
    return describeSetup(row);
  }

  protected describeTools(detail: ComputerDetail): DetailLine[] {
    const labels = this.accountLabels();
    return describeTools(detail, (provider, profileId) => labels.get(`${provider}:${profileId}`));
  }

  protected describeFolders(detail: ComputerDetail): string {
    return describeFolders(detail);
  }

  protected settingsFiles(detail: ComputerDetail): { home: string; service: string } {
    return workerSettingsFiles(detail.platform);
  }

  /**
   * Only for a tool another computer reports extra accounts for: the default account needs no name, and the read
   * checks each of this Mac's accounts for that tool. Without the names an account is shown by its ID, which is
   * still right, so a failed read changes nothing else.
   */
  private async loadAccountLabels(provider: PooledProvider): Promise<void> {
    if (this.labelsRequested.has(provider)) return;
    this.labelsRequested.add(provider);
    try {
      const { profiles } = await this.accounts.list(provider);
      this.accountLabels.update(labels => new Map([
        ...labels, ...profiles.map(profile => [`${profile.provider}:${profile.id}`, profile.label] as const),
      ]));
    } catch {
      // Named by ID instead.
    }
  }

  private async load(): Promise<void> {
    if (this.saving()) return;
    const changesBefore = this.testMachineChanges;
    const queueChangesBefore = this.queueJobChanges;
    const [result, queue] = await Promise.all([this.ipc.getTestMachines(), this.ipc.getQueueJobs()]);
    if (queueChangesBefore === this.queueJobChanges) {
      if (queue.ok) {
        this.queueView.set(queue.view);
        this.queueLoadFailure.set(null);
      } else {
        this.queueLoadFailure.set(presentError(queue.error).rawDetail);
      }
    }
    if (changesBefore !== this.testMachineChanges) return;
    if (!result.ok) {
      this.loadFailure.set(presentError(result.error).rawDetail);
      return;
    }
    this.testMachines.set(result.testMachines);
    this.useThisMac.set(result.useThisMac);
    this.today.set(result.today);
    this.loadFailure.set(null);
  }

  protected move(row: ComputerRow, by: -1 | 1): Promise<void> {
    return this.whileSaving(() => this.saveChoices(movedChoices(this.rows(), row.id, by)));
  }

  protected setSessions(row: ComputerRow, event: Event): Promise<void> {
    const sessions = (event.target as HTMLInputElement).checked;
    return this.whileSaving(
      () => this.saveChoices(changedChoices(this.rows(), row.id, { sessions })),
      event,
      () => this.row(row.id)?.choice?.sessions,
    );
  }

  /**
   * Pausing a computer pauses its test machine too, so one switch stops all new work going there. If the first half
   * fails, the second isn't tried, so the two never disagree because of this switch.
   */
  protected setPaused(row: ComputerRow, event: Event): Promise<void> {
    const paused = (event.target as HTMLInputElement).checked;
    return this.whileSaving(async () => {
      if (row.kind === 'paired') await this.saveChoices(changedChoices(this.rows(), row.id, { paused }));
      if (row.testMachine) await this.saveTestMachine(row.testMachine.host, { paused });
    }, event, () => this.row(row.id)?.paused);
  }

  protected changeTestMachine(host: string, field: 'testRuns' | 'checks', event: Event): Promise<void> {
    const on = (event.target as HTMLInputElement).checked;
    return this.whileSaving(() => this.saveTestMachine(host, { [field]: on }), event, () => this.machine(host)?.[field]);
  }

  protected slotsChanged(host: string, event: Event): Promise<void> {
    const slots = Number((event.target as HTMLSelectElement).value);
    return this.whileSaving(() => this.saveTestMachine(host, { slots }), event, () => this.machine(host)?.slots);
  }

  protected setQueueJobs(row: ComputerRow, event: Event): Promise<void> {
    const takesJobs = (event.target as HTMLInputElement).checked;
    return this.whileSaving(() => this.saveQueueJobs(row.id, { takesJobs }), event, () => this.queueComputer(row.id)?.takesJobs);
  }

  protected jobsAtOnceChanged(row: ComputerRow, event: Event): Promise<void> {
    const jobsAtOnce = Number((event.target as HTMLSelectElement).value);
    return this.whileSaving(() => this.saveQueueJobs(row.id, { jobsAtOnce }), event, () => this.queueComputer(row.id)?.jobsAtOnce);
  }

  /** Sends the project there and runs its checks. One check of a project on a computer at a time. */
  protected async checkProject(row: ComputerRow, project: QueueJobProject): Promise<void> {
    const key = checkKey(row, project);
    if (this.checking().has(key)) return;
    this.checking.update(keys => new Set(keys).add(key));
    this.checkFailures.update(failures => withoutKey(failures, key));
    try {
      const result = await this.ipc.checkQueueProject(row.id, project.repoRoot);
      if (result.ok) {
        this.queueJobChanges += 1;
        this.queueView.update(view => ({ ...view, computers: result.computers }));
      } else {
        this.checkFailures.update(failures => new Map(failures).set(key, presentError(result.error).rawDetail));
      }
    } finally {
      this.checking.update(keys => new Set([...keys].filter(entry => entry !== key)));
    }
  }

  private queueComputer(id: string): QueueJobComputer | undefined {
    return this.queueView().computers.find(computer => computer.nodeId === id);
  }

  private async saveQueueJobs(nodeId: string, change: QueueJobsChange): Promise<void> {
    const result = await this.ipc.changeQueueJobs(nodeId, change);
    if (!result.ok) throw result.error;
    this.queueJobChanges += 1;
    this.queueView.update(view => ({ ...view, computers: result.computers }));
  }

  protected setUseThisMac(event: Event): Promise<void> {
    const on = (event.target as HTMLInputElement).checked;
    return this.whileSaving(async () => {
      const result = await this.ipc.setUseThisMac(on);
      if (!result.ok) throw result.error;
      this.testMachineChanges += 1;
      this.useThisMac.set(result.useThisMac);
    }, event, () => this.useThisMac());
  }

  private row(id: string): ComputerRow | undefined {
    return this.rows().find(row => row.id === id);
  }

  private machine(host: string): TestMachineView | undefined {
    return this.testMachines().find(machine => machine.host === host);
  }

  private async saveTestMachine(host: string, change: Partial<Pick<TestMachineView, 'paused' | 'testRuns' | 'checks' | 'slots'>>): Promise<void> {
    const result = await this.ipc.changeTestMachine(host, change);
    if (!result.ok) throw result.error;
    this.testMachineChanges += 1;
    this.testMachines.update(machines => machines.map(machine => (machine.host === host ? result.testMachine : machine)));
  }

  /**
   * The store keeps its own failures rather than throwing, and its reload after one can fail too, leaving the unsaved
   * value showing. So a save took only if the store reports no new error and holds exactly what was sent.
   */
  private async saveChoices(choices: ComputerChoice[]): Promise<void> {
    this.store.clearError();
    await this.store.set('computers', choices);
    const failure = this.store.error();
    if (failure) throw failure;
    if (!sameChoices(this.store.computers(), choices)) throw 'The settings store did not keep the change.';
  }

  /**
   * One change at a time, with the controls off meanwhile. On failure the control that started it shows `saved`, what
   * is now really saved, which after a half-done Pause may differ from where it began: Angular won't redraw a binding
   * whose value didn't change.
   */
  private async whileSaving(action: () => Promise<void>, event?: Event, saved?: () => boolean | number | undefined): Promise<void> {
    // The controls switch off on the next render; this covers anything that arrives before then.
    if (this.saving()) {
      this.restore(event, saved?.());
      return;
    }
    this.saving.set(true);
    try {
      await action();
      this.saveFailure.set(null);
    } catch (error) {
      this.saveFailure.set(presentError(error).rawDetail);
      this.restore(event, saved?.());
    } finally {
      this.saving.set(false);
    }
  }

  private restore(event: Event | undefined, saved: boolean | number | undefined): void {
    const target = event?.target;
    if (saved === undefined) return;
    if (target instanceof HTMLInputElement) target.checked = Boolean(saved);
    if (target instanceof HTMLSelectElement) target.value = String(saved);
  }
}
