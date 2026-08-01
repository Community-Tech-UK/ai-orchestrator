import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { LoopStore } from '../../core/state/loop.store';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { basename, relativeTime } from './workboard-projection';
import { WorkboardStore } from './workboard.store';
import type { WorkboardItem, WorkboardPendingActionRequest, WorkboardSourceKind } from './workboard.types';

const SOURCE_LABELS: Record<WorkboardSourceKind, string> = {
  'repo-job': 'Repo job',
  'automation-run': 'Automation',
  'loop-run': 'Loop',
  instance: 'Session',
};

/** Friendly source label for a badge, e.g. `loop-run` → `Loop`. */
export function sourceLabel(kind: WorkboardSourceKind): string {
  return SOURCE_LABELS[kind];
}

/** requestTypes a compact card can safely turn into a plain Approve/Reject
 *  pair — `select_option` / `ask_questions` / `switch_mode` need a chosen
 *  option or free-text answer the card can't default, so those stay out. */
const CARD_ACTIONABLE_REQUEST_TYPES = new Set(['approve_action', 'confirm']);

/**
 * One Workboard card. A real `<button>` root for the main clickable surface
 * so keyboard activation and the `aria-pressed` selected relationship come
 * for free — no custom key handlers. The action row (approve/reject/resume/
 * snooze) lives in a sibling element so no button is ever nested inside
 * another.
 *
 * WS-C2 act-from-the-card: mirrors `WorkboardDecisionTimelineComponent`'s
 * pattern of injecting the domain stores it needs directly (`LoopStore`,
 * `InstanceIpcService`) rather than routing commands through `WorkboardStore`
 * — that store is documented as view-state-only. `WorkboardStore` is used
 * here only for its snooze view state.
 */
@Component({
  selector: 'app-workboard-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wb-card-shell">
      <button
        type="button"
        class="wb-card"
        [class]="'wb-card-lane-' + item().lane"
        [class.wb-card-selected]="selected()"
        [attr.aria-pressed]="selected()"
        [attr.aria-label]="ariaLabel()"
        (click)="activate.emit(item().id)"
      >
        <span class="wb-card-top">
          <span class="wb-card-title" [title]="item().title">{{ item().title }}</span>
          <span class="wb-card-source" [attr.data-kind]="item().primary.kind">{{ sourceText() }}</span>
        </span>
        <span class="wb-card-mid">
          <span class="wb-card-status" [class]="'wb-status-' + item().lane">{{ item().statusLabel }}</span>
          @if (item().detail) {
            <span class="wb-card-detail">{{ item().detail }}</span>
          }
          @if (hasProgress()) {
            <span class="wb-card-progress">{{ item().progress }}%</span>
          }
        </span>
        <span class="wb-card-bottom">
          <span class="wb-card-dir" [title]="item().workingDirectory">{{ workspaceLabel() }}</span>
          <span class="wb-card-time">{{ relTime() }}</span>
        </span>
        @if (relatedBadges().length > 0) {
          <span class="wb-card-related">
            @for (kind of relatedBadges(); track kind) {
              <span class="wb-card-related-badge" [attr.data-kind]="kind">{{ label(kind) }}</span>
            }
          </span>
        }
      </button>
      <div class="wb-card-actions" role="group" [attr.aria-label]="item().title + ' actions'">
        @if (actionableRequest(); as request) {
          <button
            type="button"
            class="wb-card-action wb-card-action-approve"
            [disabled]="isActing()"
            [attr.aria-busy]="isActing()"
            (click)="onApprove($event, request)"
          >
            Approve
          </button>
          <button
            type="button"
            class="wb-card-action wb-card-action-reject"
            [disabled]="isActing()"
            [attr.aria-busy]="isActing()"
            (click)="onReject($event, request)"
          >
            Reject
          </button>
        }
        @if (showResume()) {
          <button
            type="button"
            class="wb-card-action wb-card-action-resume"
            [disabled]="isResuming()"
            [attr.aria-busy]="isResuming()"
            (click)="onResume($event)"
          >
            {{ isResuming() ? 'Resuming…' : 'Resume' }}
          </button>
        }
        <button
          type="button"
          class="wb-card-action wb-card-snooze"
          [attr.aria-pressed]="snoozed()"
          (click)="onSnoozeToggle($event)"
        >
          {{ snoozed() ? 'Un-snooze' : 'Snooze' }}
        </button>
      </div>
    </div>
  `,
  styleUrl: './workboard-card.component.scss',
})
export class WorkboardCardComponent {
  private readonly workboardStore = inject(WorkboardStore);
  private readonly loopStore = inject(LoopStore);
  private readonly instanceIpc = inject(InstanceIpcService);

  readonly item = input.required<WorkboardItem>();
  readonly selected = input(false);
  /** Injected clock from the page so relative time stays deterministic. */
  readonly now = input<number>(0);
  readonly activate = output<string>();

  protected readonly sourceText = computed(() => sourceLabel(this.item().primary.kind));
  protected readonly hasProgress = computed(() => typeof this.item().progress === 'number');
  protected readonly workspaceLabel = computed(() => basename(this.item().workingDirectory) || 'No workspace');
  protected readonly relTime = computed(() => relativeTime(this.item().updatedAt, this.now() || Date.now()));
  protected readonly snoozed = computed(() => this.workboardStore.isSnoozed(this.item().id));
  protected readonly isActing = signal(false);
  protected readonly isResuming = signal(false);

  /** Pending orchestration action request for the item's primary instance,
   *  fetched on demand only while the item is `blocked` (see the effect
   *  below). Null once resolved with nothing actionable, or after acting. */
  private readonly pendingRequest = signal<WorkboardPendingActionRequest | null>(null);
  protected readonly actionableRequest = computed(() =>
    this.item().attentionLevel === 'blocked' ? this.pendingRequest() : null,
  );

  /** Resume applies only to a loop-run primary at the `waiting` level that
   *  is either paused or an active (resumable) provider-limit park — the
   *  same gate `WorkboardDecisionTimelineComponent` uses for its own
   *  "Resume now" action. */
  protected readonly showResume = computed(() => {
    const it = this.item();
    return (
      it.primary.kind === 'loop-run' &&
      it.attentionLevel === 'waiting' &&
      (it.primary.rawStatus === 'paused' || it.primary.rawStatus === 'provider-limit')
    );
  });

  /** Distinct related source kinds (excludes the primary). */
  protected readonly relatedBadges = computed<WorkboardSourceKind[]>(() => {
    const item = this.item();
    const seen = new Set<WorkboardSourceKind>();
    for (const relation of item.relations) {
      if (relation.kind === item.primary.kind) continue;
      seen.add(relation.kind);
    }
    return [...seen];
  });

  /** Accessible label keeps the raw status readable even with a friendly pill. */
  protected readonly ariaLabel = computed(() => {
    const item = this.item();
    return `${item.title}, ${sourceLabel(item.primary.kind)}, ${item.primary.rawStatus}`;
  });

  constructor() {
    // WS-C2: load the actionable request only for a blocked, instance-linked
    // item — re-runs automatically whenever the item's instance or attention
    // level changes.
    effect(() => {
      const it = this.item();
      const instanceId = it.attentionLevel === 'blocked' ? it.instanceId : undefined;
      if (!instanceId) {
        this.pendingRequest.set(null);
        return;
      }
      void this.loadActionableRequest(instanceId);
    });
  }

  protected label(kind: WorkboardSourceKind): string {
    return sourceLabel(kind);
  }

  private async loadActionableRequest(instanceId: string): Promise<void> {
    const response = await this.instanceIpc.listUserActionRequestsForInstance(instanceId);
    // Stale-response guard: the item may have moved past `blocked`, or onto
    // a different instance, while this request was in flight.
    if (this.item().attentionLevel !== 'blocked' || this.item().instanceId !== instanceId) return;
    const requests = response.success
      ? ((response.data as WorkboardPendingActionRequest[] | undefined) ?? [])
      : [];
    const actionable = requests.find((r) => CARD_ACTIONABLE_REQUEST_TYPES.has(r.requestType)) ?? null;
    this.pendingRequest.set(actionable);
  }

  protected async onApprove(event: Event, request: WorkboardPendingActionRequest): Promise<void> {
    event.stopPropagation();
    await this.respond(request, true);
  }

  protected async onReject(event: Event, request: WorkboardPendingActionRequest): Promise<void> {
    event.stopPropagation();
    await this.respond(request, false);
  }

  /**
   * Approve or reject via the same `respondToUserAction` command the mobile
   * gateway and the thin-client runner already use for cross-surface
   * approval. The richer CLI permission-prompt flow (deferred permissions,
   * YOLO, modify input) intentionally stays out of card scope: it already
   * has a full decision UI in `instance-detail`, and guessing its metadata
   * from a compact card risks sending the wrong decision to a live session.
   */
  private async respond(request: WorkboardPendingActionRequest, approved: boolean): Promise<void> {
    if (this.isActing()) return;
    this.isActing.set(true);
    try {
      const result = await this.instanceIpc.respondToUserAction(request.id, approved);
      if (result.success) {
        this.pendingRequest.set(null);
      }
    } finally {
      this.isActing.set(false);
    }
  }

  /** Resume a paused or parked loop directly — the same `LoopStore.resume`
   *  command the decision timeline's "Resume now" action already uses. */
  protected async onResume(event: Event): Promise<void> {
    event.stopPropagation();
    if (this.isResuming()) return;
    const loopRunId = this.item().loopRunId;
    if (!loopRunId) return;
    this.isResuming.set(true);
    try {
      await this.loopStore.resume(loopRunId);
    } finally {
      this.isResuming.set(false);
    }
  }

  protected onSnoozeToggle(event: Event): void {
    event.stopPropagation();
    const id = this.item().id;
    if (this.workboardStore.isSnoozed(id)) {
      this.workboardStore.unsnoozeItem(id);
    } else {
      this.workboardStore.snoozeItem(id);
    }
  }
}
