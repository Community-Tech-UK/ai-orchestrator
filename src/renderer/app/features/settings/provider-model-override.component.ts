/**
 * S4.3 — one widget for "pin a model for this provider, or don't".
 *
 * The Orchestration tab (loop models) and the Review tab (reviewer models) had
 * hand-rolled the same trio — source label, picker, reset button — against their
 * own `Record<string, string>` map, with identical read/write/delete logic. The
 * only real differences were wording ("Session default" / "Use default" versus
 * "Auto" / "Auto") and what the picker shows before anything is pinned.
 *
 * Those differences are inputs. The behaviour — write the map with the key set,
 * delete the key to unpin, disable reset when nothing is pinned — is shared,
 * which is the part that was genuinely duplicated and the part where the two
 * copies could drift apart.
 *
 * `defaultModelByProvider` on the General tab deliberately does NOT use this. It
 * is an automatically-updated remember-the-last-model cache with no reset row,
 * not an explicit override; forcing it into this shape would change behaviour,
 * not just deduplicate markup.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { CompactModelPickerComponent } from '../models/compact-model-picker.component';
import { SettingsStore } from '../../core/state/settings.store';
import type { PendingSelection, PickerProvider } from '../models/compact-model-picker.types';
import type { AppSettings } from '../../../../shared/types/settings.types';

/** The settings keys this widget is allowed to write. */
export type ProviderModelOverrideKey =
  | 'loopModelByProvider'
  | 'crossModelReviewModelByProvider';

@Component({
  selector: 'app-provider-model-override',
  standalone: true,
  imports: [CompactModelPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="provider-model-override__source">
      {{ pinnedModel() ? 'Pinned override' : unpinnedSourceLabel() }}
    </span>
    <app-compact-model-picker
      mode="pending-create"
      [providers]="[provider()]"
      [selection]="selection()"
      (selectionChange)="onPicked($event)"
    />
    <button
      type="button"
      class="provider-model-override__reset"
      [disabled]="!pinnedModel()"
      [attr.aria-label]="resetAriaLabel()"
      (click)="reset()"
    >{{ resetLabel() }}</button>
  `,
  styleUrl: './provider-model-override.component.scss',
})
export class ProviderModelOverrideComponent {
  private readonly store = inject(SettingsStore);

  readonly settingsKey = input.required<ProviderModelOverrideKey>();
  readonly provider = input.required<PickerProvider>();
  /** Wording for "nothing pinned" — differs per tab and is user-visible. */
  readonly unpinnedSourceLabel = input.required<string>();
  readonly resetLabel = input.required<string>();
  readonly resetAriaLabel = input.required<string>();
  /**
   * What the picker shows while nothing is pinned. The loop tab shows the
   * provider's default model; the review tab shows the literal `auto`.
   */
  readonly unpinnedModel = input<string | null>(null);

  /**
   * The pinned model id, or '' when this provider follows the default.
   *
   * Read through `store.get()`, which reads the settings signal — so this stays
   * reactive AND works against the same store surface the rest of the settings
   * feature uses, rather than reaching into the signal directly.
   */
  protected readonly pinnedModel = computed(() => {
    const map = this.store.get(this.settingsKey() as keyof AppSettings) as
      Record<string, string> | undefined;
    return map?.[this.provider()] ?? '';
  });

  protected readonly selection = computed<PendingSelection>(() => ({
    provider: this.provider(),
    model: this.pinnedModel() || this.unpinnedModel(),
    reasoning: null,
  }));

  protected onPicked(selection: PendingSelection): void {
    // A picker can emit for a provider other than this row's during a swap;
    // writing that would pin the wrong provider's model.
    if (selection.provider !== this.provider() || !selection.model) return;
    this.write({ ...this.currentMap(), [this.provider()]: selection.model });
  }

  protected reset(): void {
    const next = { ...this.currentMap() };
    // Delete rather than write '': an empty string is a pinned value that
    // happens to be blank, and the read path treats absence as "follow the
    // default". Those are different states.
    delete next[this.provider()];
    this.write(next);
  }

  private currentMap(): Record<string, string> {
    const map = this.store.get(this.settingsKey() as keyof AppSettings) as
      Record<string, string> | undefined;
    return { ...(map ?? {}) };
  }

  private write(next: Record<string, string>): void {
    void this.store.set(this.settingsKey() as keyof AppSettings, next as never);
  }
}
