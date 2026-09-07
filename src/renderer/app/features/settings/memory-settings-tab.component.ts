/**
 * Memory Settings Tab Component - Memory and context-related settings
 */

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingsTieredRowListComponent } from './settings-tiered-row-list.component';
import type { AppSettings } from '../../../../shared/types/settings.types';

@Component({
  selector: 'app-memory-settings-tab',
  standalone: true,
  imports: [SettingsTieredRowListComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="settings-list-card" aria-label="Memory settings">
      <app-settings-tiered-row-list
        [settings]="store.memorySettings()"
        [valueFor]="readSetting"
        (valueChange)="onSettingChange($event)"
      />
    </section>
  `,
  styleUrl: './memory-settings-tab.component.scss'
})
export class MemorySettingsTabComponent {
  store = inject(SettingsStore);

  /** Read a value by key. A bound arrow so the template can pass it as a value. */
  protected readonly readSetting = (key: string): unknown =>
    this.store.get(key as keyof AppSettings);

  onSettingChange(event: { key: string; value: unknown }): void {
    this.store.set(event.key as keyof AppSettings, event.value as AppSettings[keyof AppSettings]);
  }
}
