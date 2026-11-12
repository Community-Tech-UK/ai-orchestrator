/** The one place a session's running cost shows outside the Costs page: `≈$12.34`, in the header. */

import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { ProviderQuotaStore } from '../../core/state/provider-quota.store';
import { SettingsStore } from '../../core/state/settings.store';
import type { Instance } from '../../core/state/instance.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { resolveBillingMode } from '../../../../shared/utils/billing-mode';
import { SESSION_COST_TOOLTIP } from '../../../../shared/types/session-cost-copy';
import { sessionQuotaSnapshot } from './session-quota-snapshot';

@Component({
  selector: 'app-session-cost-label',
  standalone: true,
  imports: [DecimalPipe, AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (cost(); as value) {
    <span class="cost" tabindex="0" [appTooltip]="tooltip">≈\${{ value | number:'1.2-2' }}{{ billing() === 'plan' ? ' API-equivalent' : '' }}</span>
  }`,
  styles: [`
    :host { display: inline-flex; min-width: 0; }
    .cost { color: var(--warning-color); font-family: var(--font-mono); font-size: 11px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `],
})
export class SessionCostLabelComponent {
  protected readonly tooltip = SESSION_COST_TOOLTIP;
  private readonly settings = inject(SettingsStore);
  private readonly quota = inject(ProviderQuotaStore);

  readonly instance = input.required<Pick<Instance, 'provider' | 'accountProfileId' | 'copilotAccountProfileId' | 'contextUsage'>>();

  /** The estimate, or `null` when the cost setting is off, the provider is billed in credits (Copilot), or nothing is spent yet. */
  readonly cost = computed(() => {
    const instance = this.instance();
    if (!this.settings.showCost() || instance.provider === 'copilot') return null;
    const cost = instance.contextUsage?.costEstimate;
    return cost !== undefined && cost > 0 ? cost : null;
  });
  protected readonly billing = computed(() =>
    resolveBillingMode(this.instance().provider, sessionQuotaSnapshot(this.instance(), this.quota.snapshots(), this.quota.accountSnapshots())));
}
