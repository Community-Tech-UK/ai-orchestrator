/**
 * S4.2 — the routing policy table.
 *
 * `orchestrationRoutingPolicyJson` had no UI: moving an expensive gate onto a
 * cheaper model meant hand-editing JSON through the settings CLI. This is the
 * table that makes it an ordinary setting.
 *
 * The shaping and fail-soft parsing live in `shared/types/routing-matrix.ts`;
 * this only renders rows and writes changes back.
 */
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { SettingsStore } from '../../core/state/settings.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import {
  routingMatrixRows,
  routingMatrixToJson,
  tierLabel,
  withRoutingValue,
  ROUTING_MATRIX_TIERS,
  type RoutingMatrixRow,
} from '../../../../shared/types/routing-matrix';
import type {
  OrchestrationRoutingPolicyKey,
  OrchestrationRoutingPolicyValue,
} from '../../../../shared/types/settings-primitives.types';

@Component({
  selector: 'app-routing-matrix',
  standalone: true,
  imports: [AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="routing-matrix" aria-labelledby="routing-matrix-title">
      <header class="rm-header">
        <h4 id="routing-matrix-title" class="subsection-title">Model tier per orchestration gate</h4>
        <p class="rm-desc">
          Which tier each background gate runs on. Lower tiers cost less and are
          less capable; <strong>Auto</strong> lets the router choose from the prompt.
          Changing these affects cost immediately.
        </p>
      </header>

      <table class="rm-table">
        <thead>
          <tr>
            <th scope="col">Gate</th>
            <th scope="col">Tier</th>
            <th scope="col"><span class="sr-only">Reset</span></th>
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track row.key) {
            <tr [class.is-overridden]="row.overridden">
              <th scope="row" class="rm-gate">
                <span class="rm-gate-label">{{ row.label }}</span>
                <span class="rm-gate-desc">{{ row.description }}</span>
              </th>
              <td>
                <select
                  [attr.aria-label]="'Model tier for ' + row.label"
                  [value]="row.value"
                  (change)="onTierChange(row.key, $event)"
                >
                  @for (tier of tiers; track tier) {
                    <option [value]="tier" [selected]="tier === row.value">{{ label(tier) }}</option>
                  }
                </select>
              </td>
              <td class="rm-reset">
                @if (row.overridden) {
                  <button
                    type="button"
                    class="rm-reset-btn"
                    [appTooltip]="'Reset to the default (' + label(row.defaultValue) + ')'"
                    [attr.aria-label]="'Reset ' + row.label + ' to its default'"
                    (click)="resetRow(row)"
                  >Reset</button>
                } @else {
                  <span class="rm-default-note">default</span>
                }
              </td>
            </tr>
          }
        </tbody>
      </table>

      @if (lastChange(); as note) {
        <p class="rm-note" role="status">{{ note }}</p>
      }
    </section>
  `,
  styleUrl: './routing-matrix.component.scss',
})
export class RoutingMatrixComponent {
  private readonly store = inject(SettingsStore);

  protected readonly tiers = ROUTING_MATRIX_TIERS;
  protected readonly label = tierLabel;
  protected readonly lastChange = signal<string | null>(null);

  protected readonly rows = computed(
    () => routingMatrixRows(this.store.settings().orchestrationRoutingPolicyJson),
  );

  protected onTierChange(key: OrchestrationRoutingPolicyKey, event: Event): void {
    const value = (event.target as HTMLSelectElement).value as OrchestrationRoutingPolicyValue;
    void this.write(key, value);
  }

  protected resetRow(row: RoutingMatrixRow): void {
    void this.write(row.key, row.defaultValue);
  }

  private async write(
    key: OrchestrationRoutingPolicyKey,
    value: OrchestrationRoutingPolicyValue,
  ): Promise<void> {
    const next = withRoutingValue(this.rows(), key, value);
    const row = next.find((r) => r.key === key);
    await this.store.update({ orchestrationRoutingPolicyJson: routingMatrixToJson(next) });
    // Say what changed: this setting moves money, so a silent write is wrong.
    this.lastChange.set(
      `${row?.label ?? key} now runs on ${tierLabel(value)}.`,
    );
  }
}
