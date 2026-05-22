/**
 * General Settings Tab Component - General application preferences
 */

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingRowComponent } from './setting-row.component';
import type { AppSettings } from '../../../../shared/types/settings.types';

@Component({
  selector: 'app-general-settings-tab',
  standalone: true,
  imports: [SettingRowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (setting of store.generalSettings(); track setting.key) {
      <app-setting-row
        [setting]="setting"
        [value]="store.get(setting.key)"
        (valueChange)="onSettingChange($event)"
      />
    }
  `,
  styleUrl: './general-settings-tab.component.scss'
})
export class GeneralSettingsTabComponent {
  store = inject(SettingsStore);

  onSettingChange(event: { key: string; value: unknown }): void {
    this.store.set(event.key as keyof AppSettings, event.value as AppSettings[keyof AppSettings]);
  }
}
