/**
 * Helper fan-out cost chip for the session header (Oct-2 Phase D Step 4 item 4).
 * Shows how many helper sessions this session started and what they have cost so far.
 */

import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { InstanceStore } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { FANOUT_COST_TOOLTIP, summariseFanoutCost } from './fanout-cost';

@Component({
  selector: 'app-fanout-cost',
  standalone: true,
  imports: [DecimalPipe, AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (summary(); as fanout) {
      <span class="fanout-cost" tabindex="0" [appTooltip]="tooltip">{{ fanout.count }} helper{{ fanout.count === 1 ? '' : 's' }}@if (showCost() && fanout.pricedCount > 0) { ≈\${{ fanout.costUsd | number:'1.2-2' }}@if (fanout.unpricedCount > 0) {+}}</span>
    }
  `,
  styles: [`
    .fanout-cost {
      color: var(--text-secondary);
      font-size: 11px;
      font-family: var(--font-mono);
      margin-left: 8px;
      font-weight: 500;
    }
  `],
})
export class FanoutCostComponent {
  private readonly store = inject(InstanceStore);
  private readonly settings = inject(SettingsStore);
  readonly instanceId = input.required<string>();
  readonly tooltip = FANOUT_COST_TOOLTIP;
  readonly showCost = computed(() => this.settings.showCost());
  readonly summary = computed(() => summariseFanoutCost(this.instanceId(), this.store.instances()));
}
