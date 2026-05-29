/**
 * Keyboard Settings Tab Component - Displays keyboard shortcuts
 */

import { ChangeDetectionStrategy, Component, inject, computed } from '@angular/core';
import { KeybindingService } from '../../core/services/keybinding.service';
import type { KeyBinding } from '../../../../shared/types/keybinding.types';

interface KeybindingCategory {
  name: string;
  bindings: KeyBinding[];
}

@Component({
  selector: 'app-keyboard-settings-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="keyboard-shortcuts-section">
      <p class="keyboard-intro">
        A reference of all keyboard shortcuts in the app. Press the key
        combination shown to trigger that action.
      </p>
      @for (category of keybindingCategories(); track category.name) {
        <div class="shortcut-category">
          <h3 class="category-title">{{ category.name }}</h3>
          <div class="shortcut-list">
            @for (binding of category.bindings; track binding.id) {
              <div class="shortcut-row">
                <div class="shortcut-info">
                  <span class="shortcut-name">{{ binding.name }}</span>
                  <span class="shortcut-desc">{{ binding.description }}</span>
                </div>
                <div class="shortcut-keys">
                  <kbd>{{ keybindingService.formatBinding(binding) }}</kbd>
                </div>
              </div>
            }
          </div>
        </div>
      }
    </div>
  `,
  styleUrl: './keyboard-settings-tab.component.scss'
})
export class KeyboardSettingsTabComponent {
  keybindingService = inject(KeybindingService);

  keybindingCategories = computed(() => {
    const byCategory = this.keybindingService.bindingsByCategory();
    const categories: KeybindingCategory[] = [];
    byCategory.forEach((bindings, name) => {
      categories.push({ name, bindings });
    });
    return categories;
  });
}
