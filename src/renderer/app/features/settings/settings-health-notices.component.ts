/**
 * S3.4 — renders the health notices for whichever tab is open.
 *
 * Mounted once in the settings shell rather than per-tab: the registry already
 * says which tab each notice belongs to, so one mount plus a tab input beats
 * seven tabs each remembering to include a component.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { SettingsStore } from '../../core/state/settings.store';
import { activeHealthNotices } from '../../../../shared/types/settings-health-notices';

@Component({
  selector: 'app-settings-health-notices',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (notices().length > 0) {
      <div class="settings-health-notices" role="status">
        @for (notice of notices(); track notice.id) {
          <p class="settings-health-notice" [attr.data-severity]="notice.severity" [attr.data-notice-id]="notice.id">
            <span class="settings-health-notice__severity">{{ severityLabel(notice.severity) }}</span>
            <span class="settings-health-notice__message">{{ notice.message(settingsRecord()) }}</span>
          </p>
        }
      </div>
    }
  `,
  styleUrl: './settings-health-notices.component.scss',
})
export class SettingsHealthNoticesComponent {
  private readonly store = inject(SettingsStore);

  readonly tab = input.required<string>();

  protected readonly settingsRecord = computed(
    () => this.store.settings() as unknown as Record<string, unknown>,
  );

  protected readonly notices = computed(
    () => activeHealthNotices(this.settingsRecord(), this.tab()),
  );

  /**
   * A word, not just a colour. Severity carried by a tint alone is the
   * colour-only-state problem this backlog has already had to fix twice.
   */
  protected severityLabel(severity: string): string {
    return severity === 'warning' ? 'Check this' : 'Note';
  }
}
