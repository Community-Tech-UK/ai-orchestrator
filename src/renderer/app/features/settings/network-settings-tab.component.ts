import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingRowComponent } from './setting-row.component';
import { PauseDetectorEventsDialogComponent } from './pause-detector-events-dialog.component';
import type { AppSettings, SettingMetadata } from '../../../../shared/types/settings.types';

@Component({
  selector: 'app-network-settings-tab',
  standalone: true,
  imports: [SettingRowComponent, PauseDetectorEventsDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="network-settings">
      <header class="section-header">
        <div>
          <h3>Network Safety</h3>
          <p>Control pause-on-VPN detection and the outbound traffic gate.</p>
        </div>
        <button type="button" class="secondary-btn" (click)="eventsOpen.set(true)">
          Events
        </button>
      </header>

      @if (masterSetting()) {
        <app-setting-row
          [setting]="masterSetting()!"
          [value]="store.get('pauseFeatureEnabled')"
          (valueChange)="onSettingChange($event)"
        />
      }

      @if (!store.get('pauseFeatureEnabled')) {
        <div class="disabled-note">
          Enable network safety to configure VPN detection, probes, and local-network allow-listing.
        </div>
      } @else {
        @for (setting of detailSettings(); track setting.key) {
          <app-setting-row
            [setting]="setting"
            [value]="store.get(setting.key)"
            (valueChange)="onSettingChange($event)"
          />
        }
      }
    </section>

    @if (eventsOpen()) {
      <app-pause-detector-events-dialog (closeRequested)="eventsOpen.set(false)" />
    }
  `,
  styles: [`
    .network-settings {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md, 1rem);
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }

    h3 {
      margin: 0;
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text-primary, #e5e5e5);
    }

    p {
      margin: 0.25rem 0 0;
      color: var(--text-muted, #888);
      font-size: 0.875rem;
    }

    .secondary-btn {
      height: 32px;
      padding: 0 0.85rem;
      border: 1px solid var(--border-color, #333);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-primary, #e5e5e5);
      cursor: pointer;
      font-weight: 600;
    }

    .secondary-btn:hover {
      background: rgba(255, 255, 255, 0.1);
    }

    .disabled-note {
      padding: 0.8rem 0.9rem;
      border: 1px solid rgba(148, 163, 184, 0.22);
      border-radius: 8px;
      background: rgba(148, 163, 184, 0.08);
      color: var(--text-secondary, #cbd5e1);
      font-size: 0.875rem;
      line-height: 1.4;
    }
  `],
})
export class NetworkSettingsTabComponent {
  protected readonly store = inject(SettingsStore);
  protected readonly eventsOpen = signal(false);

  protected readonly masterSetting = computed<SettingMetadata | undefined>(() =>
    this.store.networkSettings().find((setting) => setting.key === 'pauseFeatureEnabled')
  );
  protected readonly detailSettings = computed(() =>
    this.store.networkSettings().filter((setting) => setting.key !== 'pauseFeatureEnabled')
  );

  onSettingChange(event: { key: string; value: unknown }): void {
    void this.store.set(event.key as keyof AppSettings, event.value as AppSettings[keyof AppSettings]);
  }
}
