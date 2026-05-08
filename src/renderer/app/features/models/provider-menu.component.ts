import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  computed,
} from '@angular/core';
import { NestedMenuComponent } from '../../shared/menu/nested-menu.component';
import type { MenuItem, MenuModel } from '../../shared/menu/menu.types';
import type { ChatProvider } from '../../../../shared/types/chat.types';

/**
 * Fixed presentation order for the picker.
 *
 * Excludes `auto` (the picker always pins a concrete provider) and
 * `cursor` (Cursor isn't part of `ChatProvider` today — chats route only
 * through `claude / codex / gemini / copilot`). If chat-side cursor
 * support is added later, the entry can be added here.
 */
const PROVIDERS: ChatProvider[] = ['claude', 'codex', 'gemini', 'copilot'];

const PROVIDER_LABELS: Record<ChatProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  copilot: 'Copilot',
};

const PROVIDER_COLORS: Record<ChatProvider, string> = {
  claude: '#d97706',
  codex: '#10a37f',
  gemini: '#4285f4',
  copilot: '#a855f7',
};

/**
 * Popover content for the compact picker's provider chip. Renders the
 * five chat providers as a flat `<app-nested-menu>` and reports the
 * selected provider via `(providerSelect)`.
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
  @Input({ required: true }) selectedProvider!: ChatProvider | null;
  @Input() disabledReasonFor: (provider: ChatProvider) => string | undefined = () => undefined;

  @Output() providerSelect = new EventEmitter<ChatProvider>();
  @Output() dismiss = new EventEmitter<void>();

  readonly menuModel = computed<MenuModel<{ provider: ChatProvider; color: string }>>(() => ({
    sections: [{
      id: 'providers',
      items: PROVIDERS.map((provider) => ({
        id: provider,
        label: PROVIDER_LABELS[provider],
        selected: provider === this.selectedProvider,
        disabledReason: this.disabledReasonFor(provider),
        payload: { provider, color: PROVIDER_COLORS[provider] },
      } as MenuItem<{ provider: ChatProvider; color: string }>)),
    }],
  }));

  onSelect(item: MenuItem<{ provider: ChatProvider; color: string }>): void {
    if (!item.payload) return;
    this.providerSelect.emit(item.payload.provider);
  }
}

export const PROVIDER_MENU_LABELS = PROVIDER_LABELS;
export const PROVIDER_MENU_COLORS = PROVIDER_COLORS;
export const PROVIDER_MENU_ORDER = PROVIDERS;
