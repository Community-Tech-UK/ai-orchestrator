/**
 * S4.1 — the apply path for Overnight / Interactive profiles.
 *
 * The profile data and its diff/active policy live in
 * `shared/types/settings-profiles.ts`; this is the only thing that applies one.
 * Without it the profiles were a data file rather than a feature, which is how
 * they shipped in the first pass and how they were labelled.
 *
 * The row states what a switch would actually change before you make it. A
 * profile control that silently rewrites five settings is worse than no
 * profile control.
 */
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { SettingsStore } from '../../core/state/settings.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import {
  activeProfile,
  diffProfile,
  SETTINGS_PROFILES,
  type SettingsProfile,
} from '../../../../shared/types/settings-profiles';

@Component({
  selector: 'app-settings-profile-row',
  standalone: true,
  imports: [AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="profile-row">
      <div class="profile-info">
        <h4 class="profile-title">Run profile</h4>
        <p class="profile-desc">
          Flip the unattended-run settings together instead of one at a time.
          @if (current(); as active) {
            <strong>Currently: {{ labelFor(active) }}.</strong>
          } @else {
            <strong>Currently: custom</strong> — your settings do not match either profile.
          }
        </p>
      </div>

      <div class="profile-actions">
        @for (profile of profiles; track profile.id) {
          <button
            type="button"
            class="profile-btn"
            [class.is-active]="current() === profile.id"
            [disabled]="busy() || current() === profile.id"
            [appTooltip]="profile.description"
            [attr.aria-label]="profile.label + ': ' + profile.description"
            (click)="apply(profile)"
          >{{ profile.label }}</button>
        }
      </div>

      @if (preview(); as changes) {
        <p class="profile-preview" role="status">{{ changes }}</p>
      }
    </div>
  `,
  styles: [`
    .profile-row { display: flex; flex-direction: column; gap: 8px; padding: 12px 0; }
    .profile-title { margin: 0 0 2px; font-size: 13px; }
    .profile-desc { margin: 0; font-size: 12px; opacity: 0.85; }
    .profile-actions { display: flex; gap: 8px; }
    .profile-btn {
      padding: 4px 12px; font-size: 12px; border-radius: 4px; cursor: pointer;
      border: 1px solid var(--border, rgba(255,255,255,0.14));
      background: transparent; color: inherit;
    }
    .profile-btn.is-active { border-color: var(--primary, #7dd3fc); font-weight: 600; }
    .profile-btn:disabled { cursor: default; opacity: 0.7; }
    .profile-preview { margin: 0; font-size: 11px; opacity: 0.8; }
  `],
})
export class SettingsProfileRowComponent {
  private readonly store = inject(SettingsStore);

  protected readonly profiles = SETTINGS_PROFILES;
  protected readonly busy = signal(false);
  protected readonly lastApplied = signal<string | null>(null);

  protected readonly current = computed(() => activeProfile(this.store.settings()));

  /** What the last apply actually changed, so the action is not silent. */
  protected readonly preview = computed(() => this.lastApplied());

  protected labelFor(id: string): string {
    return SETTINGS_PROFILES.find((p) => p.id === id)?.label ?? id;
  }

  protected async apply(profile: SettingsProfile): Promise<void> {
    if (this.busy()) return;
    const changes = diffProfile(profile, this.store.settings());
    if (changes.length === 0) {
      this.lastApplied.set(`${profile.label} was already applied — nothing changed.`);
      return;
    }
    this.busy.set(true);
    try {
      await this.store.update(profile.values);
      this.lastApplied.set(
        `Applied ${profile.label}: changed ${changes.length} setting`
        + `${changes.length === 1 ? '' : 's'} (${changes.map((c) => c.key).join(', ')}).`,
      );
    } finally {
      this.busy.set(false);
    }
  }
}
