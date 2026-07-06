/**
 * Network Settings Tab - VPN-pause detection and traffic gate configuration.
 *
 * Uses the draft/apply pattern (copilot_todo.md item 5): changes are collected
 * locally and only written to the store when the user clicks "Apply changes".
 * Styles extracted to .scss (copilot_todo.md item 15).
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingRowComponent } from './setting-row.component';
import { PauseDetectorEventsDialogComponent } from './pause-detector-events-dialog.component';
import { SettingsCardComponent } from './ui/settings-card.component';
import { SaveStateBannerComponent, type SaveState } from './ui/save-state-banner.component';
import { InlineHelpComponent } from '../../shared/help/inline-help.component';
import type { AppSettings, SettingMetadata } from '../../../../shared/types/settings.types';

@Component({
  selector: 'app-network-settings-tab',
  standalone: true,
  imports: [
    SettingRowComponent,
    PauseDetectorEventsDialogComponent,
    SettingsCardComponent,
    SaveStateBannerComponent,
    InlineHelpComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './network-settings-tab.component.html',
  styleUrl: './network-settings-tab.component.scss',
})
export class NetworkSettingsTabComponent {
  protected readonly store = inject(SettingsStore);
  protected readonly eventsOpen = signal(false);
  private readonly _draft = signal<Partial<AppSettings>>({});

  protected readonly masterSetting = computed<SettingMetadata | undefined>(() =>
    this.store.networkSettings().find((s) => s.key === 'pauseFeatureEnabled'),
  );
  protected readonly detailSettings = computed(() =>
    this.store.networkSettings().filter((s) => s.key !== 'pauseFeatureEnabled'),
  );

  /**
   * Returns a map of key → effective value (draft overrides store).
   * Exposing this as a signal ensures the template re-renders when the
   * draft changes.
   */
  protected readonly effectiveValues = computed((): Record<string, unknown> => {
    const d = this._draft();
    const result: Record<string, unknown> = {};
    for (const s of this.store.networkSettings()) {
      const key = s.key as keyof AppSettings;
      result[s.key] = key in d ? d[key] : this.store.get(key);
    }
    return result;
  });

  /** Whether the master toggle is on in the draft (or store if not drafted). */
  protected readonly masterEnabled = computed(
    () => (this.effectiveValues()['pauseFeatureEnabled'] as boolean) ?? false,
  );

  protected readonly dirty = computed(() => {
    const d = this._draft();
    return Object.entries(d).some(
      ([key, val]) => val !== this.store.get(key as keyof AppSettings),
    );
  });

  private readonly saving = signal(false);

  protected readonly saveState = computed<SaveState>(() => {
    if (this.saving()) return 'saving';
    return this.dirty() ? 'dirty' : 'saved';
  });

  onSettingChange(event: { key: string; value: unknown }): void {
    this._draft.update((d) => ({ ...d, [event.key]: event.value }));
  }

  async apply(): Promise<void> {
    this.saving.set(true);
    try {
      await Promise.all(
        Object.entries(this._draft()).map(([key, val]) =>
          this.store.set(key as keyof AppSettings, val as AppSettings[keyof AppSettings]),
        ),
      );
      this._draft.set({});
    } finally {
      this.saving.set(false);
    }
  }

  discard(): void {
    this._draft.set({});
  }
}
