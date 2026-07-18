import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { basename, relativeTime } from './workboard-projection';
import type { WorkboardItem, WorkboardSourceKind } from './workboard.types';

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

/**
 * One Workboard card. A real `<button>` root so keyboard activation and the
 * `aria-pressed` selected relationship come for free — no custom key handlers.
 * Purely presentational: it emits the item id on activation and lets the store
 * own selection.
 */
@Component({
  selector: 'app-workboard-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
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
  `,
  styleUrl: './workboard-card.component.scss',
})
export class WorkboardCardComponent {
  readonly item = input.required<WorkboardItem>();
  readonly selected = input(false);
  /** Injected clock from the page so relative time stays deterministic. */
  readonly now = input<number>(0);
  readonly activate = output<string>();

  protected readonly sourceText = computed(() => sourceLabel(this.item().primary.kind));
  protected readonly hasProgress = computed(() => typeof this.item().progress === 'number');
  protected readonly workspaceLabel = computed(() => basename(this.item().workingDirectory) || 'No workspace');
  protected readonly relTime = computed(() => relativeTime(this.item().updatedAt, this.now() || Date.now()));

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

  protected label(kind: WorkboardSourceKind): string {
    return sourceLabel(kind);
  }
}
