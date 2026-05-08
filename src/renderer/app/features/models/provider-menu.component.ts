import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  computed,
  signal,
} from '@angular/core';
import { NestedMenuComponent } from '../../shared/menu/nested-menu.component';
import type { MenuItem, MenuModel } from '../../shared/menu/menu.types';
import type { PickerProvider } from './compact-model-picker.types';

/**
 * Default chat-side provider order. Excludes `auto` (picker always pins
 * a concrete provider) and `cursor` (chats don't currently support cursor).
 * The new-session/instance-draft surface passes a wider list including
 * cursor via the `providers` input.
 */
export const DEFAULT_CHAT_PROVIDERS: PickerProvider[] = ['claude', 'codex', 'gemini', 'copilot'];

/** Full provider order — used by the new-session/instance-draft surface. */
export const DEFAULT_INSTANCE_PROVIDERS: PickerProvider[] = ['claude', 'codex', 'gemini', 'copilot', 'cursor'];

const PROVIDER_LABELS: Record<PickerProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  copilot: 'Copilot',
  cursor: 'Cursor',
};

const PROVIDER_COLORS: Record<PickerProvider, string> = {
  claude: '#d97706',
  codex: '#10a37f',
  gemini: '#4285f4',
  copilot: '#a855f7',
  cursor: '#0f172a',
};

/**
 * Popover content for the compact picker's provider chip.
 *
 * The list of providers is configurable so the same component serves
 * both the chat-creation form (4 providers) and the new-session form
 * (5 providers, including cursor).
 */
@Component({
  selector: 'app-provider-menu',
  standalone: true,
  imports: [NestedMenuComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-nested-menu
      [model]="menuModel()"
      [autoFocus]="true"
      (itemSelect)="onSelect($event)"
      (dismiss)="dismiss.emit()"
    />
  `,
})
export class ProviderMenuComponent {
  // @Input setters write into private signals so `menuModel` (a computed)
  // reacts to input changes. Plain @Input fields would only be picked up
  // on first read and the computed would cache the stale value.
  private readonly _selectedProvider = signal<PickerProvider | null>(null);
  private readonly _providers = signal<PickerProvider[]>(DEFAULT_CHAT_PROVIDERS);
  private readonly _disabledReasonFor = signal<(provider: PickerProvider) => string | undefined>(() => undefined);

  @Input({ required: true }) set selectedProvider(value: PickerProvider | null) {
    this._selectedProvider.set(value);
  }
  @Input() set providers(value: PickerProvider[] | undefined | null) {
    this._providers.set(value && value.length > 0 ? value : DEFAULT_CHAT_PROVIDERS);
  }
  @Input() set disabledReasonFor(fn: ((provider: PickerProvider) => string | undefined) | undefined | null) {
    this._disabledReasonFor.set(fn ?? (() => undefined));
  }

  @Output() providerSelect = new EventEmitter<PickerProvider>();
  @Output() dismiss = new EventEmitter<void>();

  readonly menuModel = computed<MenuModel<{ provider: PickerProvider; color: string }>>(() => {
    const selected = this._selectedProvider();
    const disabled = this._disabledReasonFor();
    return {
      sections: [{
        id: 'providers',
        items: this._providers().map((provider) => ({
          id: provider,
          label: PROVIDER_LABELS[provider],
          selected: provider === selected,
          disabledReason: disabled(provider),
          payload: { provider, color: PROVIDER_COLORS[provider] },
        } as MenuItem<{ provider: PickerProvider; color: string }>)),
      }],
    };
  });

  onSelect(item: MenuItem<{ provider: PickerProvider; color: string }>): void {
    if (!item.payload) return;
    this.providerSelect.emit(item.payload.provider);
  }
}

export const PROVIDER_MENU_LABELS = PROVIDER_LABELS;
export const PROVIDER_MENU_COLORS = PROVIDER_COLORS;
export const PROVIDER_MENU_ORDER = DEFAULT_CHAT_PROVIDERS;
