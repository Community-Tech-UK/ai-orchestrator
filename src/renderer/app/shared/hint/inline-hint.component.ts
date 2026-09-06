/**
 * UX5 — a behaviour-gated inline hint.
 *
 * Renders nothing unless `shouldShowHint` says the hint is earned and
 * undismissed, so mounting one is cheap and a caller does not have to duplicate
 * the policy. Dismissal is permanent and persisted; see `hint-policy.ts` for why
 * a hint that returns is worse than no hint.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { SettingsStore } from '../../core/state/settings.store';
import {
  HINTS,
  shouldShowHint,
  withDismissed,
  type HintId,
} from '../../../../shared/types/hint-policy';

@Component({
  selector: 'app-inline-hint',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      @if (copy(); as hint) {
        <aside class="inline-hint" role="note">
          <div class="inline-hint__text">
            <strong class="inline-hint__title">{{ hint.title }}</strong>
            <p class="inline-hint__body">{{ hint.body }}</p>
            @if (hint.action) {
              <p class="inline-hint__action">{{ hint.action }}</p>
            }
          </div>
          <button
            type="button"
            class="inline-hint__dismiss"
            [attr.aria-label]="'Dismiss hint: ' + hint.title"
            (click)="dismiss()"
          >Got it</button>
        </aside>
      }
    }
  `,
  styles: [`
    .inline-hint {
      display: flex; gap: 12px; align-items: flex-start; justify-content: space-between;
      padding: 10px 12px; margin: 8px 0; border-radius: 6px;
      border: 1px solid var(--border, rgba(255,255,255,0.12));
      background: rgba(255,255,255,0.03);
    }
    .inline-hint__title { display: block; font-size: 12px; }
    .inline-hint__body, .inline-hint__action { margin: 2px 0 0; font-size: 12px; opacity: 0.85; }
    .inline-hint__action { opacity: 1; }
    .inline-hint__dismiss {
      flex: none; padding: 3px 10px; font-size: 11px; border-radius: 4px; cursor: pointer;
      border: 1px solid var(--border, rgba(255,255,255,0.14));
      background: transparent; color: inherit;
    }
  `],
})
export class InlineHintComponent {
  private readonly store = inject(SettingsStore);

  readonly hintId = input.required<HintId>();
  /** The behaviour that earns this hint. Default true = "relevant whenever mounted". */
  readonly condition = input<boolean>(true);

  protected readonly copy = computed(() => HINTS[this.hintId()]);

  protected readonly visible = computed(() => shouldShowHint({
    id: this.hintId(),
    dismissed: this.store.settings().dismissedHints ?? [],
    condition: this.condition(),
  }).show);

  protected async dismiss(): Promise<void> {
    const current = this.store.settings().dismissedHints ?? [];
    const next = withDismissed(current, this.hintId());
    // Same reference means it was already dismissed; skip the round trip.
    if (next === current) return;
    await this.store.update({ dismissedHints: [...next] });
  }
}
