import { Component, ChangeDetectionStrategy, computed, input } from '@angular/core';

/**
 * Skeleton placeholder component.
 *
 * Renders shimmer bars (lines) or a single shimmer block while content loads.
 * Uses `--skeleton-base` / `--skeleton-sheen` design tokens and respects
 * `prefers-reduced-motion`.
 *
 * Usage:
 *   <app-skeleton />                      — 3 shimmer lines (default)
 *   <app-skeleton [lines]="5" />          — 5 shimmer lines
 *   <app-skeleton variant="block" />      — full-height shimmer block
 */
@Component({
  selector: 'app-skeleton',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './skeleton.component.scss',
  template: `
    @if (variant() === 'block') {
      <div class="skeleton-block"></div>
    } @else {
      <div class="skeleton-lines">
        @for (i of lineArray(); track i) {
          <div class="skeleton-line"></div>
        }
      </div>
    }
  `,
})
export class SkeletonComponent {
  /** Number of shimmer lines to render (ignored when variant is 'block'). */
  readonly lines = input(3);

  /** 'lines' renders stacked shimmer bars; 'block' renders a single tall block. */
  readonly variant = input<'lines' | 'block'>('lines');

  protected readonly lineArray = computed(() =>
    Array.from({ length: this.lines() }, (_, i) => i)
  );
}
