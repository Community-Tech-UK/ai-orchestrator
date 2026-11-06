import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, linkedSignal, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { PLAN_QUEUE_SET_ASIDE_RESTART_LIMIT, type PlanQueueItemDto, type PlanQueueParkReason, type PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { AioTooltipDirective } from '../../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../../shared/tooltip/tooltip-copy';
import { PlanQueueStore } from '../../../core/state/plan-queue.store';
import { planQueueDocumentBasename } from './plan-queue-item-list.component';

import { planQueueDisplayParkReason, planQueueParkReasonLabel, type PlanQueueParkReasonDisplay } from '../plan-queue-park-reason-help';
import { foldDetail, pluralise } from '../plan-queue-item-display';
import { planQueueBulkResumePreview, planQueueBulkRetryPreview, type PlanQueueBulkPreview } from '../plan-queue-bulk-preview';

type ParkedAction = 'land-anyway' | 'discard-item';

/** Documents shown per section before "Show more". */
const SECTION_PAGE_SIZE = 25;
/** Each diffstat starts a git process, so opening a long section must not start them all at once. */
const MAX_DIFFSTATS_IN_FLIGHT = 4;
const READY_SECTION = 'ready';

interface ParkedRow {
  item: PlanQueueItemDto;
  display: PlanQueueParkReasonDisplay | null;
  project: string;
  /** A newer attempt at this document merged after this one stopped. */
  mergedSince: boolean;
  /** The section this attempt would head if it were its document's newest. */
  sectionKey: string;
}

interface ParkedDocument {
  path: string;
  latest: ParkedRow;
  older: ParkedRow[];
}

interface ParkedSection {
  key: string;
  title: string;
  help: string;
  reason: PlanQueueParkReason | null;
  documents: ParkedDocument[];
}

/**
 * Parked items across every run, sectioned by why they stopped so each reason is explained once. Only open sections
 * render, a page at a time, and only rendered rows fetch their `git diff --shortstat`. Resume is reversible so it
 * fires immediately; Land anyway and Discard are one-way, so both require an explicit confirm click.
 */
@Component({
  selector: 'app-plan-queue-parked-list',
  standalone: true,
  imports: [AioTooltipDirective, NgTemplateOutlet],
  templateUrl: './plan-queue-parked-list.component.html',
  styleUrl: './plan-queue-parked-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueParkedListComponent {
  private readonly store = inject(PlanQueueStore);
  private readonly requestedDiffstats = new Set<string>();
  private readonly diffstatQueue: string[] = [];
  private diffstatsInFlight = 0;

  items = input<PlanQueueItemDto[]>([]);
  runs = input<readonly PlanQueueRunDto[]>([]);
  busyDocuments = input<readonly string[]>([]);
  chooseChecker = output<string>();
  sortOut = output<string>();
  protected readonly restartLimit = PLAN_QUEUE_SET_ASIDE_RESTART_LIMIT;
  /** One entry per project folder with set-aside jobs, biggest first. */
  protected readonly agentFolders = computed(() => {
    const folderOf = new Map(this.runs().map(run => [run.id, run.workspaceCwd]));
    const jobs = new Map<string, number>();
    for (const item of this.items()) {
      const folder = folderOf.get(item.runId);
      if (folder) jobs.set(folder, (jobs.get(folder) ?? 0) + 1);
    }
    return [...jobs].map(([folder, count]) => ({ folder, name: projectName(folder) || folder, count }))
      .sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder));
  });
  protected readonly pluralise = pluralise;
  protected readonly detailFor = foldDetail;
  protected readonly query = signal('');
  /** Sections the user has opened or closed themselves; the rest follow `isOpen`'s default. */
  private readonly sectionChoices = signal<ReadonlyMap<string, boolean>>(new Map());
  private readonly shownDocuments = signal<ReadonlyMap<string, number>>(new Map());
  protected readonly openAttempts = signal<ReadonlySet<string>>(new Set());

  private readonly documents = computed<ParkedDocument[]>(() => {
    const runs = new Map(this.runs().map(run => [run.id, run]));
    const newestMerged = this.newestMerged();
    const byDocument = new Map<string, ParkedRow[]>();
    for (const item of this.items()) {
      const run = runs.get(item.runId);
      const mergedSince = (newestMerged.get(item.documentPath) ?? 0) > item.createdAt;
      const display = planQueueDisplayParkReason(item, { maxRounds: run?.config.maxRounds, mergedSince });
      const row = { item, display, project: projectName(run?.workspaceCwd), mergedSince, sectionKey: this.sectionKeyFor(item, display) };
      const attempts = byDocument.get(item.documentPath) ?? [];
      attempts.push(row); byDocument.set(item.documentPath, attempts);
    }
    return [...byDocument.entries()].map(([path, attempts]) => {
      attempts.sort((a, b) => b.item.createdAt - a.item.createdAt || b.item.id.localeCompare(a.item.id));
      return { path, latest: attempts[0], older: attempts.slice(1) };
    }).sort((a, b) => b.latest.item.updatedAt - a.latest.item.updatedAt);
  });

  protected readonly sections = computed<ParkedSection[]>(() => {
    const needle = this.query().trim().toLowerCase();
    const sections = new Map<string, ParkedSection>();
    for (const document of this.documents()) {
      if (needle && ![document.latest, ...document.older].some(row => rowMatches(row, needle))) continue;
      const { sectionKey, display, item, mergedSince } = document.latest;
      const section = sections.get(sectionKey) ?? {
        key: sectionKey,
        title: sectionKey === READY_SECTION ? 'Ready to review and merge'
          : item.parkReason === 'round-limit' && !mergedSince ? planQueueParkReasonLabel(item.parkReason) : display?.label ?? '',
        help: display ? `${display.meaning} ${display.next}` : '',
        // Resume wipes a passed check, so work that is ready to merge is never resumed in bulk.
        reason: sectionKey === READY_SECTION || !display?.actions.includes('resume') ? null : item.parkReason,
        documents: [],
      };
      section.documents.push(document);
      sections.set(sectionKey, section);
    }
    return [...sections.values()].sort((a, b) => Number(b.key === READY_SECTION) - Number(a.key === READY_SECTION)
      || b.documents.length - a.documents.length || a.title.localeCompare(b.title));
  });

  /** Stays the same while its section exists, so a background re-sort never closes what is being read. */
  private readonly openByDefaultKey = linkedSignal<string[], string | null>({
    source: () => this.sections().map(section => section.key),
    computation: (keys, previous) => previous?.value && keys.includes(previous.value) ? previous.value : keys[0] ?? null,
  });

  protected readonly documentCount = computed(() => this.documents().length);
  protected readonly readyCount = computed(() => this.documents().filter(document => document.latest.sectionKey === READY_SECTION).length);

  /** The rows on screen; nothing else fetches a diffstat. */
  private readonly renderedItems = computed(() => this.sections().filter(section => this.isOpen(section.key))
    .flatMap(section => this.shownIn(section))
    .flatMap(document => [document.latest, ...(this.openAttempts().has(document.path) ? document.older : [])])
    .map(row => row.item));

  protected readonly findingsOpen = signal<ReadonlySet<string>>(new Set());
  /** Fixed when opened, so a refresh can never add a job to the list that was reviewed. */
  protected readonly bulkPreview = signal<{ sectionKey: string; reason: PlanQueueParkReason | null; preview: PlanQueueBulkPreview } | null>(null);

  private readonly pausedRuns = computed(() => new Set(this.runs().filter(run => run.status === 'paused').map(run => run.id)));

  /** When each document's newest merged attempt was created, across every loaded run. */
  private readonly newestMerged = computed(() => {
    const newestMerged = new Map<string, number>();
    for (const item of this.runs().flatMap(run => run.items)) {
      if (item.state === 'landed') newestMerged.set(item.documentPath, Math.max(item.createdAt, newestMerged.get(item.documentPath) ?? 0));
    }
    return newestMerged;
  });

  /** The preview as it stands now: a job that has since become busy, merged or left Set aside moves to Left alone. */
  protected readonly bulkView = computed<PlanQueueBulkPreview | null>(() => {
    const opened = this.bulkPreview();
    if (!opened) return null;
    const live = opened.reason ? planQueueBulkResumePreview(this.items(), opened.reason, this.busyDocuments(), this.newestMerged())
      : planQueueBulkRetryPreview(this.documents().filter(document => document.latest.sectionKey === READY_SECTION).map(document => document.latest.item), this.busyDocuments(), this.pausedRuns());
    const stillResumable = new Set(live.willChange.map(item => item.id));
    const { willChange, leftAlone, notApplicable } = opened.preview;
    return {
      willChange: willChange.filter(item => stillResumable.has(item.id)),
      leftAlone: [...leftAlone, ...willChange.filter(item => !stillResumable.has(item.id)).map(item => ({ item, reason: 'it changed after this preview opened' }))],
      notApplicable,
    };
  });

  onSearch(event: Event): void {
    const query = (event.target as HTMLInputElement).value;
    if (Boolean(query.trim()) !== Boolean(this.query().trim())) this.sectionChoices.set(new Map());
    this.query.set(query);
    this.bulkPreview.set(null);
  }

  /** The first section starts open; a search opens every section with a match. */
  isOpen(key: string): boolean {
    return this.sectionChoices().get(key) ?? (Boolean(this.query().trim()) || this.openByDefaultKey() === key);
  }

  toggleSection(key: string): void {
    const open = this.isOpen(key);
    if (open && this.bulkPreview()?.sectionKey === key) this.bulkPreview.set(null);
    this.sectionChoices.update(old => new Map(old).set(key, !open));
  }

  previewBulk(section: ParkedSection): void {
    if (!section.reason) return;
    if (!this.isOpen(section.key)) this.toggleSection(section.key);
    const items = section.documents.flatMap(document => [document.latest, ...document.older].map(row => row.item));
    this.bulkPreview.set({ sectionKey: section.key, reason: section.reason,
      preview: planQueueBulkResumePreview(items, section.reason, this.busyDocuments(), this.newestMerged()) });
  }

  previewRetry(section: ParkedSection): void {
    if (!this.isOpen(section.key)) this.toggleSection(section.key);
    this.bulkPreview.set({ sectionKey: section.key, reason: null,
      preview: planQueueBulkRetryPreview(section.documents.map(document => document.latest.item), this.busyDocuments(), this.pausedRuns()) });
  }

  isReady(section: ParkedSection): boolean {
    return section.key === READY_SECTION;
  }

  shownIn(section: ParkedSection): ParkedDocument[] {
    return section.documents.slice(0, this.shownDocuments().get(section.key) ?? SECTION_PAGE_SIZE);
  }

  showMore(section: ParkedSection): void {
    this.shownDocuments.update(old => new Map(old).set(section.key, this.shownIn(section).length + SECTION_PAGE_SIZE));
  }

  remainingIn(section: ParkedSection): number {
    return section.documents.length - this.shownIn(section).length;
  }

  onAttemptsToggle(path: string, event: Event): void {
    const open = (event.target as HTMLDetailsElement).open;
    this.openAttempts.update(old => {
      const next = new Set(old);
      if (open) next.add(path); else next.delete(path);
      return next;
    });
  }

  /** What this row adds to its section's heading: an older attempt's own reason, or the round count. */
  rowNote(row: ParkedRow, section: ParkedSection): string | null {
    if (!row.display) return null;
    if (row.sectionKey !== section.key) return row.mergedSince ? row.display.label : `${row.display.label}: ${row.display.meaning}`;
    return section.key !== READY_SECTION && row.display.label !== section.title ? row.display.label : null;
  }

  showFindings(itemId: string): void {
    this.findingsOpen.update(old => new Set([...old, itemId]));
  }

  confirmBulk(): void {
    const reviewed = (this.bulkView()?.willChange ?? []).map(item => item.id);
    const retry = !this.bulkPreview()?.reason;
    this.bulkPreview.set(null);
    (retry ? this.retryLandings : this.resumeItems).emit(reviewed);
  }

  resumeItem = output<string>();
  resumeItems = output<string[]>();
  retryLandings = output<string[]>();
  stopRetrying = output<void>();
  /** Where a "try merging all again" has got to. */
  retryProgress = input<{ done: number; total: number; stopping: boolean } | null>(null);
  retryLanding = output<string>();
  protected readonly copyFor = copyFor;
  landAnyway = output<string>();
  discardItem = output<string>();

  protected readonly documentBasename = planQueueDocumentBasename;

  protected readonly diffstats = signal<Record<string, string>>({});
  protected readonly confirming = signal<{ itemId: string; action: ParkedAction } | null>(null);

  constructor() {
    inject(DestroyRef).onDestroy(() => { this.diffstatQueue.length = 0; });
    // A preview whose section has gone must not come back unasked if the section returns.
    effect(() => {
      const opened = this.bulkPreview();
      if (opened && !this.sections().some(section => section.key === opened.sectionKey)) this.bulkPreview.set(null);
    });
    effect(() => {
      for (const item of this.renderedItems()) {
        if (!item.branchName || this.requestedDiffstats.has(item.id)) continue;
        this.requestedDiffstats.add(item.id);
        this.diffstatQueue.push(item.id);
      }
      this.fetchDiffstats();
    });
  }

  private fetchDiffstats(): void {
    while (this.diffstatsInFlight < MAX_DIFFSTATS_IN_FLIGHT && this.diffstatQueue.length > 0) {
      const itemId = this.diffstatQueue.shift()!;
      this.diffstatsInFlight++;
      void this.store.diffstat(itemId)
        .then((diffstat) => this.diffstats.update((map) => ({ ...map, [itemId]: diffstat })))
        .finally(() => {
          this.diffstatsInFlight--;
          this.fetchDiffstats();
        });
    }
  }

  diffstatFor(itemId: string): string {
    const cached = this.diffstats()[itemId];
    if (cached === undefined) return 'Loading diff…';
    return cached || 'No changes';
  }

  private sectionKeyFor(item: PlanQueueItemDto, display: PlanQueueParkReasonDisplay | null): string {
    return this.canRetryLanding(item) && display?.actions.includes('retry-landing') ? READY_SECTION : display?.meaning ?? 'none';
  }

  canRetryLanding(item: PlanQueueItemDto): boolean {
    return item.state === 'parked' && item.parkReason === 'land-blocked' && Boolean(item.branchName) && item.verdict?.verdict === 'PASS';
  }

  onRetryLanding(item: PlanQueueItemDto): void {
    if (this.canRetryLanding(item)) this.retryLanding.emit(item.id);
  }

  onResume(itemId: string): void {
    this.resumeItem.emit(itemId);
  }

  isConfirming(itemId: string, action: ParkedAction): boolean {
    const current = this.confirming();
    return current?.itemId === itemId && current.action === action;
  }

  requestConfirm(itemId: string, action: ParkedAction): void {
    this.confirming.set({ itemId, action });
  }

  cancelConfirm(): void {
    this.confirming.set(null);
  }

  confirmAction(itemId: string, action: ParkedAction): void {
    this.confirming.set(null);
    if (action === 'land-anyway') this.landAnyway.emit(itemId);
    else this.discardItem.emit(itemId);
  }
}

function projectName(folder: string | undefined): string {
  return folder?.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
}

function rowMatches(row: ParkedRow, needle: string): boolean {
  return `${row.item.documentPath} ${row.item.branchName ?? ''} ${row.project} ${row.display?.label ?? ''}`.toLowerCase().includes(needle);
}
