/**
 * The Computers list: paired computers in the order Harness tries them, the test machine with the computer it's
 * part of, and this Mac last. In Settings it changes things; on the Control Center page (`readOnly`) it only shows.
 */
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { RemoteNodeIpcService } from '../../core/services/ipc/remote-node-ipc.service';
import { AppIconButtonDirective } from '../../shared/tooltip/icon-button.directive';
import { presentError } from '../../../../shared/present-error';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';
import type { TestMachineView, WorkToday } from '../../../../shared/types/computers.types';
import type { ComputerChoice } from '../../../../shared/types/settings.types';
import {
  buildComputerRows,
  changedChoices,
  describeNow,
  describeTakes,
  describeToday,
  movedChoices,
  type ComputerRow,
} from './computers-list.model';

/** Field by field, so the order keys were stored in can't make a kept change look lost. */
function sameChoices(a: readonly ComputerChoice[], b: readonly ComputerChoice[]): boolean {
  return a.length === b.length
    && a.every((choice, at) => choice.id === b[at]!.id && choice.paused === b[at]!.paused && choice.sessions === b[at]!.sessions);
}

/** How often the list reads the test machine and today's work again while it's open. */
const REFRESH_MS = 60_000;
const SLOT_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8];

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

  /** Paired computers, connected or not, as the roster has them. */
  readonly nodes = input<readonly RemoteNodeRosterEntry[]>([]);
  /** Show only; the Control Center page links to Settings for changes. */
  readonly readOnly = input(false);

  private readonly testMachine = signal<TestMachineView | null>(null);
  private readonly today = signal<WorkToday | null>(null);
  /** Raw detail of the last failure, for Details. The visible sentence is fixed. */
  protected readonly loadFailure = signal<string | null>(null);
  protected readonly saveFailure = signal<string | null>(null);
  protected readonly saving = signal(false);
  private readonly now = signal(Date.now());
  /** Counts saved test-machine changes, so a refresh that started before one can't put the old values back. */
  private testMachineChanges = 0;

  protected readonly slotChoices = SLOT_CHOICES;
  protected readonly rows = computed(() => buildComputerRows(this.nodes(), this.store.computers(), this.testMachine(), {
    browser: this.store.remoteNodesAutoOffloadBrowser(),
    android: this.store.remoteNodesAutoOffloadAndroid(),
  }));
  protected readonly pairedCount = computed(() => this.rows().filter(row => row.kind === 'paired').length);
  protected readonly todayLines = computed(() => {
    const today = this.today();
    const machine = this.testMachine();
    return today && machine ? describeToday(today, machine.label) : [];
  });

  constructor() {
    void this.load();
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
    return describeTakes(row);
  }

  private async load(): Promise<void> {
    if (this.saving()) return;
    const changesBefore = this.testMachineChanges;
    const result = await this.ipc.getTestMachine();
    if (changesBefore !== this.testMachineChanges) return;
    if (!result.ok) {
      this.loadFailure.set(presentError(result.error).rawDetail);
      return;
    }
    this.testMachine.set(result.testMachine);
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
      if (row.testMachine) await this.saveTestMachine({ paused });
    }, event, () => this.row(row.id)?.paused);
  }

  protected changeTestMachine(field: 'testRuns' | 'checks', event: Event): Promise<void> {
    const on = (event.target as HTMLInputElement).checked;
    return this.whileSaving(() => this.saveTestMachine({ [field]: on }), event, () => this.testMachine()?.[field]);
  }

  protected slotsChanged(event: Event): Promise<void> {
    const slots = Number((event.target as HTMLSelectElement).value);
    return this.whileSaving(() => this.saveTestMachine({ slots }), event, () => this.testMachine()?.slots);
  }

  private row(id: string): ComputerRow | undefined {
    return this.rows().find(row => row.id === id);
  }

  private async saveTestMachine(change: Partial<Pick<TestMachineView, 'paused' | 'testRuns' | 'checks' | 'slots'>>): Promise<void> {
    const result = await this.ipc.changeTestMachine(change);
    if (!result.ok) throw result.error;
    this.testMachineChanges += 1;
    this.testMachine.set(result.testMachine);
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
