import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { InstanceReviewPanelComponent } from './instance-review-panel.component';
import { ChildInstancesPanelComponent } from './child-instances-panel.component';
import { CheckpointTimelineComponent } from '../checkpoints/checkpoint-timeline.component';
import { HistoryIpcService } from '../../core/services/ipc/history-ipc.service';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import type { HudQuickAction } from '../../../../shared/types/orchestration-hud.types';
import {
  DOCK_CHIPS,
  DOCK_FOCUS_ANCHOR_CLASS,
  splitDockChips,
  type DockChipContext,
  type DockChipDef,
  type DockChipId,
  type DockChipPresentation,
} from './session-status-dock.rules';

interface DockChipView {
  def: DockChipDef;
  presentation: DockChipPresentation;
  open: boolean;
  entering: boolean;
}

@Component({
  selector: 'app-session-status-dock',
  standalone: true,
  imports: [
    InstanceReviewPanelComponent,
    ChildInstancesPanelComponent,
    CheckpointTimelineComponent,
    AioTooltipDirective,
  ],
  template: `
    <span class="dock-focus-anchor" tabindex="-1"></span>
    @if (hasContent()) {
      <div class="session-status-dock">
        @if (chipViews().length > 0) {
          <div class="inspector-toggles-shell">
            <div class="dock-chips" role="toolbar" aria-label="Session inspectors">
              @for (chip of visibleChips(); track chip.def.id) {
                <button
                  class="inspector-toggle"
                  [class.active]="chip.open"
                  [class.entering]="chip.entering"
                  [attr.data-chip-id]="chip.def.id"
                  [attr.aria-expanded]="chip.open"
                  [appTooltip]="chip.presentation.title"
                  [appTooltipShowWhenExpanded]="true"
                  (animationend)="onChipToggleAnimationEnd(chip.def.id)"
                  (click)="toggleChip(chip.def.id)"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    @for (path of chip.def.icon.paths ?? []; track path) {
                      <path [attr.d]="path" />
                    }
                    @for (circle of chip.def.icon.circles ?? []; track circle.cx + ':' + circle.cy) {
                      <circle [attr.cx]="circle.cx" [attr.cy]="circle.cy" [attr.r]="circle.r" />
                    }
                    @for (
                      line of chip.def.icon.lines ?? [];
                      track line.x1 + ':' + line.y1 + ':' + line.x2 + ':' + line.y2
                    ) {
                      <line
                        [attr.x1]="line.x1"
                        [attr.y1]="line.y1"
                        [attr.x2]="line.x2"
                        [attr.y2]="line.y2"
                      />
                    }
                  </svg>
                  {{ chip.presentation.label }}
                  @if (chip.presentation.badge; as badge) {
                    <span
                      class="inspector-badge"
                      [class.severity-error]="badge.variant === 'error'"
                      [class.running]="badge.variant === 'running'"
                      >{{ badge.text }}</span
                    >
                  }
                </button>
              }
              @if (overflowChips().length > 0) {
                <button
                  type="button"
                  class="inspector-toggle dock-overflow-toggle"
                  [attr.aria-expanded]="overflowOpen()"
                  (click)="overflowOpen.update((open) => !open)"
                >
                  +{{ overflowChips().length }} more
                </button>
              }
              <span class="sr-only" aria-live="polite">
                @for (chip of chipViews(); track chip.def.id) {
                  @if (chip.def.announce) {
                    {{ chip.def.announce }}
                  }
                }
              </span>
            </div>
            @if (overflowOpen() && overflowChips().length > 0) {
              <div class="dock-overflow-list">
                @for (chip of overflowChips(); track chip.def.id) {
                  <button
                    class="inspector-toggle"
                    [class.active]="chip.open"
                    [attr.data-chip-id]="chip.def.id"
                    [attr.aria-expanded]="chip.open"
                    [appTooltip]="chip.presentation.title"
                    [appTooltipShowWhenExpanded]="true"
                    (click)="onOverflowChipClick(chip.def.id)"
                  >
                    {{ chip.presentation.label }}
                    @if (chip.presentation.badge; as badge) {
                      <span
                        class="inspector-badge"
                        [class.severity-error]="badge.variant === 'error'"
                        [class.running]="badge.variant === 'running'"
                        >{{ badge.text }}</span
                      >
                    }
                  </button>
                }
              </div>
            }
          </div>
        }

        @if (hasOpenChipPanel()) {
          <div class="inspector-panels">
            @if (isChipOpen('review')) {
              <app-instance-review-panel
                [instanceId]="instanceId()"
                [workingDirectory]="workingDirectory()"
                (reviewStarted)="onReviewStarted()"
                (reviewCompleted)="onReviewCompleted($event)"
              />
            }
            @if (isChipOpen('agents')) {
              <app-child-instances-panel
                [childrenIds]="childrenIds()"
                (selectChild)="selectChild.emit($event)"
                (quickAction)="quickAction.emit($event)"
              />
            }
            @if (isChipOpen('checkpoints')) {
              <app-checkpoint-timeline [instanceId]="instanceId()" />
            }
          </div>
        }
      </div>
    }
  `,
  styleUrl: './session-status-dock.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionStatusDockComponent {
  private historyIpc = inject(HistoryIpcService);
  private host = inject(ElementRef<HTMLElement>);

  instanceId = input.required<string>();
  workingDirectory = input('');
  childrenIds = input<string[]>([]);
  chipDefs = input<readonly DockChipDef[]>(DOCK_CHIPS);

  selectChild = output<string>();
  quickAction = output<HudQuickAction>();

  openPanels = signal<Partial<Record<DockChipId, boolean>>>({});
  overflowOpen = signal(false);
  reviewHasContent = signal(false);
  reviewBadgeInfo = signal<{ issueCount: number; hasErrors: boolean } | null>(null);
  checkpointCount = signal(0);
  enteringChip = signal<DockChipId | null>(null);

  private chipsBarWasVisible = false;

  /** Element that held keyboard focus when the current dock surface opened. */
  private surfaceOpener: HTMLElement | null = null;

  readonly chipContext = computed<DockChipContext>(() => ({
    reviewHasContent: this.reviewHasContent(),
    reviewIssueCount: this.reviewBadgeInfo()?.issueCount ?? null,
    reviewHasErrors: this.reviewBadgeInfo()?.hasErrors ?? false,
    childCount: this.childrenIds().length,
    checkpointCount: this.checkpointCount(),
  }));

  readonly chipViews = computed<readonly DockChipView[]>(() => {
    const ctx = this.chipContext();
    const open = this.openPanels();
    const entering = this.enteringChip();
    return this.chipDefs().flatMap((def) => {
      const isOpen = open[def.id] === true;
      const presentation = def.describe(ctx, isOpen);
      return presentation
        ? [{ def, presentation, open: isOpen, entering: entering === def.id }]
        : [];
    });
  });

  readonly visibleChips = computed(() => {
    const views = this.chipViews();
    const visibleIds = new Set(splitDockChips(views.map((view) => view.def)).visible.map((d) => d.id));
    return views.filter((view) => visibleIds.has(view.def.id));
  });

  readonly overflowChips = computed(() => {
    const views = this.chipViews();
    const overflowIds = new Set(
      splitDockChips(views.map((view) => view.def)).overflow.map((d) => d.id),
    );
    return views.filter((view) => overflowIds.has(view.def.id));
  });

  /** Only chips that currently declare content can hold an open panel. */
  readonly hasOpenChipPanel = computed(() =>
    this.chipViews().some((view) => this.openPanels()[view.def.id] === true),
  );

  /** C13.12: the strip renders nothing when no chip has content. */
  readonly hasContent = computed(() => this.chipViews().length > 0);

  private chipEntranceEffect = effect(() => {
    const barVisible = this.chipViews().length > 0;
    if (!barVisible) {
      this.chipsBarWasVisible = false;
      this.enteringChip.set(null);
      return;
    }
    if (!this.chipsBarWasVisible) {
      this.enteringChip.set(this.chipViews()[0]?.def.id ?? null);
    }
    this.chipsBarWasVisible = true;
  });

  /**
   * A panel whose chip lost its content is closed: its surface is no longer
   * reachable from the strip, and it must not silently reopen if the chip
   * regains content later.
   */
  private stalePanelSync = effect(() => {
    const contentIds = new Set(this.chipViews().map((view) => view.def.id));
    const stale = Object.entries(this.openPanels())
      .filter(([id, open]) => open === true && !contentIds.has(id as DockChipId))
      .map(([id]) => id as DockChipId);
    if (stale.length > 0) {
      this.openPanels.update((panels) => {
        const next = { ...panels };
        for (const id of stale) {
          next[id] = false;
        }
        return next;
      });
    }
  });

  private instanceChangeSync = effect(() => {
    const instanceId = this.instanceId();

    this.openPanels.set({});
    this.overflowOpen.set(false);
    this.reviewHasContent.set(false);
    this.reviewBadgeInfo.set(null);
    this.enteringChip.set(null);
    this.chipsBarWasVisible = false;
    this.surfaceOpener = null;

    this.checkpointCount.set(0);
    if (instanceId) {
      void this.historyIpc
        .listSessionSnapshots(instanceId)
        .then((res) => {
          if (this.instanceId() !== instanceId) return;
          this.checkpointCount.set(res.success && Array.isArray(res.data) ? res.data.length : 0);
        })
        .catch(() => {
          /* best-effort; leave the count at 0 so the chip stays hidden */
        });
    }
  });

  toggleChip(id: DockChipId): void {
    if (this.openPanels()[id] !== true) {
      this.rememberSurfaceOpener();
    }
    this.openPanels.update((panels) => ({ ...panels, [id]: !panels[id] }));
  }

  /**
   * Chip activation from the overflow row leaves the row open: the activated
   * chip is the panel's trigger, so it stays mounted (and focusable) exactly
   * like a visible chip while its panel is open.
   */
  onOverflowChipClick(id: DockChipId): void {
    this.toggleChip(id);
  }

  isChipOpen(id: DockChipId): boolean {
    return this.openPanels()[id] === true && this.chipViews().some((view) => view.def.id === id);
  }

  openReviewPanel(): void {
    if (this.openPanels()['review'] !== true) {
      this.rememberSurfaceOpener();
    }
    this.openPanels.update((panels) => ({ ...panels, review: true }));
  }

  /**
   * Close the topmost open dock surface and return keyboard focus to an
   * element that survives the close: an open chip panel first — its chip
   * trigger while that chip keeps content, else the surface's original opener,
   * a remaining chip, the composer input, and the always-rendered focus anchor
   * as the last target that survives — else the expanded overflow row (focus
   * the "+N more" control). True when the dock consumed the Escape key, so a
   * stray Escape never interrupts an in-flight turn.
   */
  dismissOpenSurface(): boolean {
    const openChip = this.chipViews().find((view) => this.openPanels()[view.def.id] === true);
    if (openChip) {
      this.openPanels.set({});
      if (this.chipTriggerSurvivesClose(openChip)) {
        this.focusChipTrigger(openChip.def.id);
      } else {
        this.focusAfterTriggerGone(openChip.def.id);
      }
      return true;
    }
    if (this.overflowOpen()) {
      this.overflowOpen.set(false);
      if (!this.tryFocus(this.overflowToggleButton())) {
        this.tryFocus(this.focusAnchor());
      }
      return true;
    }
    return false;
  }

  /**
   * The closing chip's trigger stays mounted only while the chip still
   * describes content with every panel closed (the review workbench's cold
   * chip does not; content-list chips do not either once their list empties).
   */
  private chipTriggerSurvivesClose(view: DockChipView): boolean {
    return view.def.describe(this.chipContext(), false) !== null;
  }

  private focusChipTrigger(id: DockChipId): void {
    if (!this.tryFocus(this.chipTriggerElement(id)) && !this.tryFocus(this.overflowToggleButton())) {
      this.tryFocus(this.focusAnchor());
    }
  }

  /**
   * Focus ladder for a closing chip that takes its trigger with it. Each step
   * is verified: a candidate that cannot take focus (disconnected, disabled)
   * falls through to the next one, so keyboard focus never drops to <body>.
   * The last step is the always-rendered focus anchor, not the dock host: the
   * host is `display: contents` and a real browser cannot focus it (pinned by
   * `session-status-dock-focus.e2e.spec.ts`).
   */
  private focusAfterTriggerGone(closingId: DockChipId): void {
    const opener = this.surfaceOpener;
    const openerIsClosingTrigger = Boolean(opener?.closest(`[data-chip-id="${closingId}"]`));
    if (opener && !openerIsClosingTrigger && this.tryFocus(opener)) {
      return;
    }
    for (const view of this.chipViews()) {
      if (view.def.id === closingId) continue;
      if (this.tryFocus(this.chipTriggerElement(view.def.id))) {
        return;
      }
    }
    if (this.tryFocus(this.composerInput())) {
      return;
    }
    this.tryFocus(this.focusAnchor());
  }

  /**
   * The message box below the strip: where typing resumes when the dock
   * empties. Resolved from the dock's own region outward, so a composer
   * belonging to another feature sharing the document can never be picked.
   */
  private composerInput(): HTMLElement | null {
    let region: HTMLElement | null = this.host.nativeElement.parentElement;
    while (region) {
      const input = region.querySelector('app-input-panel textarea');
      if (input) {
        return input as HTMLElement;
      }
      if (region === document.body) {
        break;
      }
      region = region.parentElement;
    }
    return null;
  }

  private chipTriggerElement(id: DockChipId): HTMLElement | null {
    return this.host.nativeElement.querySelector(`[data-chip-id="${id}"]`) as HTMLElement | null;
  }

  /**
   * The strip's own always-rendered programmatic focus target: the one rung of
   * the ladder that survives even an empty strip, and the only rung inside the
   * dock that a real browser can focus (the host itself is `display: contents`).
   */
  private focusAnchor(): HTMLElement | null {
    return this.host.nativeElement.querySelector(
      `.${DOCK_FOCUS_ANCHOR_CLASS}`,
    ) as HTMLElement | null;
  }

  /** Focus and confirm the element actually holds focus; false lets the ladder continue. */
  private tryFocus(target: HTMLElement | null): boolean {
    if (!target) {
      return false;
    }
    target.focus();
    return document.activeElement === target;
  }

  private rememberSurfaceOpener(): void {
    const active = document.activeElement;
    this.surfaceOpener =
      active instanceof HTMLElement && active !== document.body && active !== document.documentElement
        ? active
        : null;
  }

  private overflowToggleButton(): HTMLElement | null {
    return this.host.nativeElement.querySelector('.dock-overflow-toggle') as HTMLElement | null;
  }

  @HostListener('window:keydown', ['$event'])
  handleEscapeKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented) {
      return;
    }
    if (this.dismissOpenSurface()) {
      event.preventDefault();
    }
  }

  onChipToggleAnimationEnd(id: DockChipId): void {
    if (this.enteringChip() === id) {
      this.enteringChip.set(null);
    }
  }

  onReviewStarted(): void {
    this.reviewHasContent.set(true);
    this.reviewBadgeInfo.set(null);
  }

  onReviewCompleted(result: { issueCount: number; hasErrors: boolean }): void {
    this.reviewHasContent.set(true);
    this.reviewBadgeInfo.set(result);
  }
}
