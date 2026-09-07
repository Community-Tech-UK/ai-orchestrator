/**
 * S3.2 — Common rows up front, Advanced behind a disclosure.
 *
 * A drop-in replacement for the block every category-driven tab duplicated:
 *
 *     for (setting of store.xSettings()) { <app-setting-row ... /> }
 *
 * Same rows, same instant-save behaviour, same `settings-list-item` styling —
 * the only change is that numeric tuning knobs collapse behind a toggle that
 * says how many it is hiding.
 *
 * The toggle carries a stable class (`settings-tiered-row-list__advanced-toggle`)
 * because settings search needs to click it: landing on a row that is collapsed
 * inside this component would scroll to nothing, so UX4.2 opens the disclosure
 * before scrolling. That is why the class is part of the contract and not an
 * incidental styling hook.
 */
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import { SettingRowComponent } from './setting-row.component';
import { advancedToggleLabel, splitByTier } from '../../../../shared/types/settings-tiering';
import type { SettingMetadata } from '../../../../shared/types/settings-metadata.types';

@Component({
  selector: 'app-settings-tiered-row-list',
  standalone: true,
  imports: [SettingRowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (setting of tiers().common; track setting.key) {
      <app-setting-row
        class="settings-list-item"
        [setting]="setting"
        [value]="valueFor()(setting.key)"
        (valueChange)="valueChange.emit($event)"
      />
    }

    @if (tiers().advanced.length > 0) {
      <button
        type="button"
        class="settings-tiered-row-list__advanced-toggle"
        [attr.aria-expanded]="showAdvanced()"
        (click)="toggleAdvanced()"
      >{{ toggleLabel() }}</button>

      @if (showAdvanced()) {
        @for (setting of tiers().advanced; track setting.key) {
          <app-setting-row
            class="settings-list-item"
            [setting]="setting"
            [value]="valueFor()(setting.key)"
            (valueChange)="valueChange.emit($event)"
          />
        }
      }
    }
  `,
  styleUrl: './settings-tiered-row-list.component.scss',
})
export class SettingsTieredRowListComponent {
  readonly settings = input.required<readonly SettingMetadata[]>();
  /**
   * How to read a value. A function rather than a map so the caller keeps using
   * its own store getter — threading a pre-built record through would snapshot
   * the values and break instant-save updates.
   */
  readonly valueFor = input.required<(key: string) => unknown>();
  readonly valueChange = output<{ key: string; value: unknown }>();

  protected readonly showAdvanced = signal(false);
  protected readonly tiers = computed(() => splitByTier(this.settings()));
  protected readonly toggleLabel = computed(
    () => advancedToggleLabel(this.tiers().advanced.length, this.showAdvanced()),
  );

  protected toggleAdvanced(): void {
    this.showAdvanced.update((open) => !open);
  }
}
