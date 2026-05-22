/**
 * Orchestration Settings Tab Component - Orchestration-related settings
 */

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingRowComponent } from './setting-row.component';
import type { AppSettings } from '../../../../shared/types/settings.types';

@Component({
  selector: 'app-orchestration-settings-tab',
  standalone: true,
  imports: [SettingRowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (setting of store.orchestrationSettings(); track setting.key) {
      <app-setting-row
        [setting]="setting"
        [value]="store.get(setting.key)"
        (valueChange)="onSettingChange($event)"
      />
    }
  `,
  styleUrl: './orchestration-settings-tab.component.scss'
})
export class OrchestrationSettingsTabComponent {
  store = inject(SettingsStore);

  onSettingChange(event: { key: string; value: unknown }): void {
    this.store.set(event.key as keyof AppSettings, event.value as string | number | boolean);
  }
}
