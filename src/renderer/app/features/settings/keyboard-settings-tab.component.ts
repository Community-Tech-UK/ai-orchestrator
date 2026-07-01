/**
 * Keyboard Settings Tab Component - Displays keyboard shortcuts
 */

import { ChangeDetectionStrategy, Component, inject, computed, signal } from '@angular/core';
import { KeybindingService } from '../../core/services/keybinding.service';
import type { KeybindingConflict } from '../../core/services/keybinding-conflicts';
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

      @if (conflicts().length > 0) {
        <div class="keybinding-conflicts" role="alert">
          <strong>{{ conflicts().length }} keybinding conflict(s):</strong>
          <ul>
            @for (conflict of conflicts(); track conflict.scope + conflict.key) {
              <li><kbd>{{ conflict.key }}</kbd> ({{ conflict.scope }}) — {{ conflict.actionIds.join(', ') }}</li>
            }
          </ul>
        </div>
      }

      <div class="keybinding-io">
        <button type="button" (click)="onExport()">Export shortcuts</button>
        <textarea
          [value]="importText()"
          (input)="onImportTextInput($any($event.target).value)"
          placeholder="Paste exported shortcuts JSON to import"
          rows="3"
        ></textarea>
        <button type="button" [disabled]="!importText().trim()" (click)="onImport()">Import shortcuts</button>
        @if (ioMessage()) {
          <p class="keybinding-io-message">{{ ioMessage() }}</p>
        }
        @if (pendingImportConflicts().length > 0) {
          <div class="keybinding-import-conflicts" role="alert">
            <strong>Import conflicts:</strong>
            <ul>
              @for (conflict of pendingImportConflicts(); track conflict.scope + conflict.key) {
                <li><kbd>{{ conflict.key }}</kbd> ({{ conflict.scope }}) — {{ conflict.actionIds.join(', ') }}</li>
              }
            </ul>
          </div>
        }
      </div>

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

  protected readonly conflicts = this.keybindingService.conflicts;
  protected readonly importText = signal('');
  protected readonly ioMessage = signal('');
  protected readonly pendingImportConflicts = signal<readonly KeybindingConflict[]>([]);

  keybindingCategories = computed(() => {
    const byCategory = this.keybindingService.bindingsByCategory();
    const categories: KeybindingCategory[] = [];
    byCategory.forEach((bindings, name) => {
      categories.push({ name, bindings });
    });
    return categories;
  });

  /** Task 13: copy the exported keybindings JSON to the clipboard. */
  protected onExport(): void {
    const json = this.keybindingService.exportKeybindings();
    void navigator.clipboard?.writeText(json).then(
      () => this.ioMessage.set('Shortcuts copied to clipboard.'),
      () => this.ioMessage.set('Could not access the clipboard.'),
    );
  }

  protected onImportTextInput(value: string): void {
    this.importText.set(value);
    this.pendingImportConflicts.set([]);
  }

  /** Task 13: import keybindings from the pasted JSON, surfacing conflicts. */
  protected onImport(): void {
    try {
      const result = this.keybindingService.importKeybindings(this.importText());
      if (result.applied === 0 && result.conflicts.length > 0) {
        this.pendingImportConflicts.set(result.conflicts);
        this.ioMessage.set(
          `Import blocked: it would introduce ${result.conflicts.length} conflict(s). Resolve them first.`,
        );
        return;
      }
      this.importText.set('');
      this.pendingImportConflicts.set([]);
      this.ioMessage.set(`Imported ${result.applied} shortcut customization(s).`);
    } catch (err) {
      this.pendingImportConflicts.set([]);
      this.ioMessage.set(err instanceof Error ? err.message : 'Import failed.');
    }
  }
}
