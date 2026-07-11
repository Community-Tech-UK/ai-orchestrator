/**
 * General Settings Tab Component - General application preferences
 */

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingRowComponent } from './setting-row.component';
import type { AppSettings } from '../../../../shared/types/settings.types';
import { AppUpdateSettingsComponent } from './app-update-settings.component';

@Component({
  selector: 'app-general-settings-tab',
  standalone: true,
  imports: [SettingRowComponent, AppUpdateSettingsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="settings-list-card" aria-label="General settings">
      @for (setting of store.generalSettings(); track setting.key) {
        <app-setting-row
          class="settings-list-item"
          [setting]="setting"
          [value]="store.get(setting.key)"
          (valueChange)="onSettingChange($event)"
        />
      }
    </section>
    <app-update-settings />
  `,
  styleUrl: './general-settings-tab.component.scss'
})
export class GeneralSettingsTabComponent {
  store = inject(SettingsStore);

  onSettingChange(event: { key: string; value: unknown }): void {
    this.store.set(event.key as keyof AppSettings, event.value as AppSettings[keyof AppSettings]);
  }
}
