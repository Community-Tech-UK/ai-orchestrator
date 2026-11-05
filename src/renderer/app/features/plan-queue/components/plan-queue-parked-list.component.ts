import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { PLAN_QUEUE_SET_ASIDE_RESTART_LIMIT, type PlanQueueItemDto, type PlanQueueParkReason, type PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { AioTooltipDirective } from '../../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../../shared/tooltip/tooltip-copy';
import { PlanQueueStore } from '../../../core/state/plan-queue.store';
import { planQueueDocumentBasename } from './plan-queue-item-list.component';

import { planQueueDisplayParkReason, planQueueParkReasonLabel } from '../plan-queue-park-reason-help';
import { foldDetail, pluralise } from '../plan-queue-item-display';
import { planQueueBulkResumePreview } from '../plan-queue-bulk-preview';

type ParkedAction = 'land-anyway' | 'discard-item';

/**
 * Parked items across every run, with their document, branch and a lazily-fetched
 * `git diff --shortstat`. Resume is reversible so it fires immediately; Land
 * anyway and Discard are one-way, so both require an explicit confirm click.
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
  private readonly pendingFetch = new Set<string>();

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
    return [...jobs].map(([folder, count]) => ({ folder, name: folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder, count }))
      .sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder));
  });
  protected readonly pluralise = pluralise;
  protected readonly reasonLabel = planQueueParkReasonLabel;
  protected readonly detailFor = foldDetail;
  protected readonly displayFor = (item: PlanQueueItemDto) => planQueueDisplayParkReason(item,
    { maxRounds: this.runs().find(run => run.id === item.runId)?.config.maxRounds });
  protected readonly groups = computed(() => {
    const byDocument = new Map<string, PlanQueueItemDto[]>();
    for (const item of this.items()) {
      const attempts = byDocument.get(item.documentPath) ?? [];
      attempts.push(item); byDocument.set(item.documentPath, attempts);
    }
    return [...byDocument.entries()].map(([path, attempts]) => {
      attempts.sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
      return { path, latest: attempts[0], older: attempts.slice(1), ready: this.canRetryLanding(attempts[0]) };
    }).sort((a, b) => Number(b.ready) - Number(a.ready) || b.latest.updatedAt - a.latest.updatedAt);
  });
  protected readonly findingsOpen = signal<ReadonlySet<string>>(new Set());
  protected readonly bulkReason = signal<PlanQueueParkReason | null>(null);
  protected readonly bulkReasons = computed(() => [...new Set(this.items().map(item => item.parkReason))]
    .filter((reason): reason is PlanQueueParkReason => reason !== null));
  protected readonly bulkPreview = computed(() => {
    const reason = this.bulkReason();
    return reason ? planQueueBulkResumePreview(this.items(), reason, this.busyDocuments()) : null;
  });

  showFindings(itemId: string): void {
    this.findingsOpen.update(old => new Set([...old, itemId]));
  }

  confirmBulk(): void {
    const preview = this.bulkPreview();
    this.bulkReason.set(null);
    for (const item of preview?.willChange ?? []) this.resumeItem.emit(item.id);
  }


  resumeItem = output<string>();
  retryLanding = output<string>();
  protected readonly copyFor = copyFor;
  landAnyway = output<string>();
  discardItem = output<string>();

  protected readonly documentBasename = planQueueDocumentBasename;

  protected readonly diffstats = signal<Record<string, string>>({});
  protected readonly confirming = signal<{ itemId: string; action: ParkedAction } | null>(null);

  constructor() {
    effect(() => {
      for (const item of this.items()) {
        if (!item.branchName) continue;
        if (this.diffstats()[item.id] !== undefined || this.pendingFetch.has(item.id)) continue;
        this.pendingFetch.add(item.id);
        void this.store.diffstat(item.id).then((diffstat) => {
          this.pendingFetch.delete(item.id);
          this.diffstats.update((map) => ({ ...map, [item.id]: diffstat }));
        });
      }
    });
  }

  diffstatFor(itemId: string): string {
    const cached = this.diffstats()[itemId];
    if (cached === undefined) return 'Loading diff…';
    return cached || 'No changes';
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
