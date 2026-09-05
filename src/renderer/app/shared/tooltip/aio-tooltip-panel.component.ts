/**
 * UX1 — the tooltip surface itself.
 *
 * `role="tooltip"` with a stable id so the trigger's `aria-describedby` can
 * point at it. Pointer events are off: a tooltip that can be hovered stays open
 * over the control it describes, which is the single most common way a tooltip
 * becomes an obstacle.
 *
 * `prefers-reduced-motion` removes the scale, per the house rule — the tooltip
 * still appears, it just does not animate.
 */

import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-aio-tooltip-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="aio-tooltip" role="tooltip" [id]="tooltipId()">{{ text() }}</div>
  `,
  styles: [`
    .aio-tooltip {
      max-width: 320px;
      padding: 6px 9px;
      border-radius: 6px;
      background: var(--tooltip-bg, #1f2430);
      color: var(--tooltip-fg, #f2f4f8);
      border: 1px solid var(--tooltip-border, rgba(255, 255, 255, 0.12));
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.32);
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-line;
      /* Never take the pointer — see the component doc. */
      pointer-events: none;
      transform-origin: center;
      animation: aio-tooltip-in 90ms ease-out;
    }

    @keyframes aio-tooltip-in {
      from { opacity: 0; transform: scale(0.96); }
      to { opacity: 1; transform: scale(1); }
    }

    @media (prefers-reduced-motion: reduce) {
      .aio-tooltip { animation: none; }
    }
  `],
})
export class AioTooltipPanelComponent {
  readonly text = input('');
  readonly tooltipId = input('');
}
