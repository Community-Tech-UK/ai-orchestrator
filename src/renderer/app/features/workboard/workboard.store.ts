import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { InstanceStore } from '../../core/state/instance/instance.store';
import { AutomationStore } from '../../core/state/automation.store';
import { LoopStore } from '../../core/state/loop.store';
import { RepoJobStore } from '../../core/state/repo-job.store';
import {
  attentionLevelClearsSnooze,
  buildWorkboardLanes,
  deriveWorkspaceOptions,
  filterItemsByWorkspace,
  projectWorkboard,
} from './workboard-projection';
import type {
  WorkboardItem,
  WorkboardLanes,
  WorkboardWorkspaceOption,
} from './workboard.types';

/** Sentinel workspace filter value: show every workspace. */
export const ALL_WORKSPACES = 'all';

/** The synthetic "All workspaces" option, always first in the picker. */
const ALL_WORKSPACES_OPTION: WorkboardWorkspaceOption = {
  id: ALL_WORKSPACES,
  label: 'All workspaces',
  workingDirectory: '',
};

/**
 * Composes the four authoritative source stores into the Workboard view model.
 *
 * It owns ONLY view state and derivation — selected workspace, selected item,
 * the injected clock, refresh orchestration, and per-source error summaries. It
 * never owns source commands or persisted workflow state; those stay in the
 * domain stores. Page-provided (see `WorkboardPageComponent.providers`) because
 * no other surface consumes Workboard view state.
 */
@Injectable()
export class WorkboardStore {
  private readonly instanceStore = inject(InstanceStore);
  private readonly automationStore = inject(AutomationStore);
  private readonly loopStore = inject(LoopStore);
  private readonly repoJobStore = inject(RepoJobStore);

  /** Injected clock. Advanced on each refresh tick so relative times and the
   *  24-hour terminal boundary update predictably (and deterministically in tests). */
  private readonly nowSignal = signal(Date.now());

  private readonly selectedWorkspace = signal<string>(ALL_WORKSPACES);
  private readonly selectedItem = signal<string | null>(null);

  private readonly refreshingSignal = signal(false);
  private readonly loopErrorSignal = signal<string | null>(null);
  private readonly automationErrorSignal = signal<string | null>(null);
  private readonly repoJobErrorSignal = signal<string | null>(null);

  /** WS-C2 snooze: session-only (no natural persistence layer exists yet for
   *  Workboard view state — everything else here is either derived or an
   *  injected clock). Losing snoozes on reload is acceptable: a reload
   *  always re-shows every genuinely live item, which is the safe default. */
  private readonly snoozedIdsSignal = signal<ReadonlySet<string>>(new Set());

  constructor() {
    // The Workboard is the only surface that needs the global recent-loop read
    // model live, so it wires the loop event listeners once on init.
    this.loopStore.ensureWired();

    // Clear the selection when the selected item leaves the projection (terminal
    // expiry or source removal). Guarded so it only fires the transition once.
    effect(() => {
      const id = this.selectedItem();
      if (!id) return;
      const stillPresent = this.items().some((item) => item.id === id);
      if (!stillPresent) {
        untracked(() => this.selectedItem.set(null));
      }
    });

    // WS-C2 snooze hand-raise: automatically drop a snooze once the item's
    // attention level rises (see `attentionLevelClearsSnooze`) or the item
    // leaves the projection entirely. Runs on every `items()` recompute so
    // the card reappears the moment it actually needs you, not on the next
    // manual refresh.
    effect(() => {
      const currentItems = this.items();
      const snoozed = untracked(() => this.snoozedIdsSignal());
      if (snoozed.size === 0) return;
      const stillSnoozed = new Set<string>();
      for (const item of currentItems) {
        if (snoozed.has(item.id) && !attentionLevelClearsSnooze(item.attentionLevel)) {
          stillSnoozed.add(item.id);
        }
      }
      if (stillSnoozed.size !== snoozed.size) {
        untracked(() => this.snoozedIdsSignal.set(stillSnoozed));
      }
    });
  }

  // ────── read model ──────

  /** All correlated, retention-filtered items (unfiltered by workspace). */
  readonly items = computed<WorkboardItem[]>(() =>
    projectWorkboard({
      instances: this.instanceStore.instances(),
      loopRuns: this.loopStore.recentRuns(),
      automationRuns: this.automationStore.runs(),
      automations: this.automationStore.automations(),
      repoJobs: this.repoJobStore.jobs(),
      now: this.nowSignal(),
    }),
  );

  /** Workspace options: "All workspaces" first, then derived choices. */
  readonly workspaceOptions = computed<WorkboardWorkspaceOption[]>(() => [
    ALL_WORKSPACES_OPTION,
    ...deriveWorkspaceOptions(this.items()),
  ]);

  /** Items after the workspace filter (feeds every lane). */
  readonly filteredItems = computed<WorkboardItem[]>(() =>
    filterItemsByWorkspace(this.items(), this.selectedWorkspace()),
  );

  /** WS-C2: workspace-filtered items with an active snooze hidden. The
   *  workspace filter and snooze are independent — snoozing never affects
   *  the workspace picker's counts (those come from the unfiltered `items()`). */
  readonly visibleItems = computed<WorkboardItem[]>(() => {
    const snoozed = this.snoozedIdsSignal();
    const filtered = this.filteredItems();
    if (snoozed.size === 0) return filtered;
    return filtered.filter((item) => !snoozed.has(item.id));
  });

  /** Lane arrays, always all four lanes, sorted per lane policy. Snoozed
   *  items are excluded until their attention rises (see `snoozeItem`). */
  readonly lanes = computed<WorkboardLanes>(() => buildWorkboardLanes(this.visibleItems()));

  /** Total visible cards after filtering and snoozing. */
  readonly visibleCount = computed(() => this.visibleItems().length);

  readonly selectedWorkspaceId = this.selectedWorkspace.asReadonly();
  readonly selectedItemId = this.selectedItem.asReadonly();

  /** The currently selected item, or null when none/expired. */
  readonly selectedWorkboardItem = computed<WorkboardItem | null>(() => {
    const id = this.selectedItem();
    if (!id) return null;
    return this.items().find((item) => item.id === id) ?? null;
  });

  readonly refreshing = this.refreshingSignal.asReadonly();
  readonly loopError = this.loopErrorSignal.asReadonly();
  readonly automationError = this.automationErrorSignal.asReadonly();
  readonly repoJobError = this.repoJobErrorSignal.asReadonly();

  // ────── commands (view state only) ──────

  /** Select a workspace to filter every lane by. */
  selectWorkspace(workspaceId: string): void {
    this.selectedWorkspace.set(workspaceId);
  }

  /**
   * Explicit user selection of a card. Updates only Workboard selection, plus
   * the global instance selection WHEN the item is backed by an instance — this
   * is the single path allowed to move `InstanceStore` selection. Passive source
   * updates never call `setSelectedInstance`.
   */
  selectItem(itemId: string): void {
    this.selectedItem.set(itemId);
    const item = this.items().find((candidate) => candidate.id === itemId);
    if (item?.instanceId) {
      this.instanceStore.setSelectedInstance(item.instanceId);
    }
  }

  /** Clear the Workboard selection (e.g. Back to Workboard). */
  clearSelection(): void {
    this.selectedItem.set(null);
  }

  /** Advance the injected clock. Called on the page's refresh tick; tests may
   *  pass an explicit `now` for determinism. */
  advanceClock(now: number = Date.now()): void {
    this.nowSignal.set(now);
  }

  /**
   * Refresh the loop, automation, and repository-job sources in parallel.
   * Instances are push-driven by `InstanceStore`, so they are not refreshed
   * here. Partial errors are surfaced per source without clearing the others;
   * existing cards stay visible throughout.
   */
  async refresh(): Promise<void> {
    this.refreshingSignal.set(true);
    this.advanceClock();
    try {
      const [loopResult] = await Promise.all([
        this.loopStore.refreshRecentRuns(100),
        this.automationStore.refresh().then(
          () => this.automationErrorSignal.set(this.automationStore.error()),
          (err: unknown) => this.automationErrorSignal.set(errorMessage(err)),
        ),
        this.repoJobStore.refresh(false).then(
          (ok) => this.repoJobErrorSignal.set(ok ? null : this.repoJobStore.error()),
          (err: unknown) => this.repoJobErrorSignal.set(errorMessage(err)),
        ),
      ]);
      this.loopErrorSignal.set(loopResult.ok ? null : loopResult.error);
    } finally {
      this.refreshingSignal.set(false);
    }
  }

  /** Retry only the loop source (source-specific Retry action). */
  async retryLoops(): Promise<void> {
    const result = await this.loopStore.refreshRecentRuns(100);
    this.loopErrorSignal.set(result.ok ? null : result.error);
  }

  /** Retry only the repository-job source. */
  async retryRepoJobs(): Promise<void> {
    const ok = await this.repoJobStore.refresh(true);
    this.repoJobErrorSignal.set(ok ? null : this.repoJobStore.error());
  }

  /** Retry only the automation source. */
  async retryAutomations(): Promise<void> {
    await this.automationStore.refresh();
    this.automationErrorSignal.set(this.automationStore.error());
  }

  // ────── WS-C2: snooze with hand-raise ──────

  /** Hide a card from its attention lane. Auto-clears the moment the item's
   *  attention rises again (see the hand-raise effect in the constructor) —
   *  callers never need to un-snooze a genuinely urgent item themselves. */
  snoozeItem(itemId: string): void {
    this.snoozedIdsSignal.update((ids) => (ids.has(itemId) ? ids : new Set(ids).add(itemId)));
  }

  /** Explicit user un-snooze (e.g. an "undo" affordance). */
  unsnoozeItem(itemId: string): void {
    this.snoozedIdsSignal.update((ids) => {
      if (!ids.has(itemId)) return ids;
      const next = new Set(ids);
      next.delete(itemId);
      return next;
    });
  }

  isSnoozed(itemId: string): boolean {
    return this.snoozedIdsSignal().has(itemId);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
