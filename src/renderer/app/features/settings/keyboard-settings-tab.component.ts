/**
 * Keyboard Settings Tab Component - Displays keyboard shortcuts
 *
 * WS-C9: searchable, grouped-by-context shortcut surface. Every hint shown
 * here comes from `ShortcutHintPipe` (the live resolver), never a hardcoded
 * string.
 */

import { ChangeDetectionStrategy, Component, inject, computed, signal } from '@angular/core';
import { KeybindingService } from '../../core/services/keybinding.service';
import type { KeybindingConflict } from '../../core/services/keybinding-conflicts';
import type { ReservedKeyViolation } from '../../core/keybindings/validate';
import { ShortcutHintPipe } from '../../core/keybindings/shortcut-hint.pipe';
import {
  KEYBINDING_CONTEXTS,
  KEYBINDING_CONTEXT_LABELS,
} from '../../core/keybindings/keybinding-registry';
import type { KeyBinding, KeybindingContext } from '../../../../shared/types/keybinding.types';

interface KeybindingContextGroup {
  context: KeybindingContext;
  label: string;
  bindings: KeyBinding[];
}

function matchesQuery(binding: KeyBinding, contextLabel: string, query: string): boolean {
  if (!query) return true;
  const haystack = `${binding.name} ${binding.description} ${binding.action} ${binding.category ?? ''} ${contextLabel}`.toLowerCase();
  return haystack.includes(query);
}

@Component({
  selector: 'app-keyboard-settings-tab',
  standalone: true,
  imports: [ShortcutHintPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="keyboard-shortcuts-section">
      <p class="keyboard-intro">
        A reference of all keyboard shortcuts in the app, grouped by where
        they're active. Press the key combination shown to trigger that
        action.
      </p>

      <input
        class="keybinding-search"
        type="search"
        [value]="query()"
        (input)="onQueryInput($any($event.target).value)"
        placeholder="Search shortcuts by name, description, or context…"
        aria-label="Search keyboard shortcuts"
      />

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
        @if (pendingReservedViolations().length > 0) {
          <div class="keybinding-import-conflicts" role="alert">
            <strong>Reserved shortcuts (cannot be imported):</strong>
            <ul>
              @for (violation of pendingReservedViolations(); track violation.actionId + violation.key) {
                <li><kbd>{{ violation.key }}</kbd> — {{ violation.actionId }} ({{ violation.reason }})</li>
              }
            </ul>
          </div>
        }
      </div>

      @if (groupedByContext().length === 0) {
        <p class="keybinding-empty">No shortcuts match "{{ query() }}".</p>
      }

      @for (group of groupedByContext(); track group.context) {
        <div class="shortcut-category">
          <h3 class="category-title">{{ group.label }}</h3>
          <div class="shortcut-list">
            @for (binding of group.bindings; track binding.id) {
              <div class="shortcut-row">
                <div class="shortcut-info">
                  <span class="shortcut-name">{{ binding.name }}</span>
                  <span class="shortcut-desc">{{ binding.description }}</span>
                </div>
                <div class="shortcut-keys">
                  <kbd>{{ binding.action | shortcutHint }}</kbd>
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
  protected readonly pendingReservedViolations = signal<readonly ReservedKeyViolation[]>([]);
  protected readonly query = signal('');

  /** Searchable, context-grouped shortcut surface (WS-C9). */
  groupedByContext = computed<KeybindingContextGroup[]>(() => {
    const bindings = this.keybindingService.allBindings();
    const query = this.query().trim().toLowerCase();
    const groups: KeybindingContextGroup[] = [];
    for (const context of KEYBINDING_CONTEXTS) {
      const label = KEYBINDING_CONTEXT_LABELS[context];
      const matched = bindings.filter(
        (binding) => (binding.context ?? 'global') === context && matchesQuery(binding, label, query),
      );
      if (matched.length > 0) {
        groups.push({ context, label, bindings: matched });
      }
    }
    return groups;
  });

  /** Task 13: copy the exported keybindings JSON to the clipboard. */
  protected onExport(): void {
    const json = this.keybindingService.exportKeybindings();
    void navigator.clipboard?.writeText(json).then(
      () => this.ioMessage.set('Shortcuts copied to clipboard.'),
      () => this.ioMessage.set('Could not access the clipboard.'),
    );
  }

  protected onQueryInput(value: string): void {
    this.query.set(value);
  }

  protected onImportTextInput(value: string): void {
    this.importText.set(value);
    this.pendingImportConflicts.set([]);
    this.pendingReservedViolations.set([]);
  }

  /** Task 13 (reserved-key checks added in WS-C9): import shortcuts from the pasted JSON, surfacing violations. */
  protected onImport(): void {
    try {
      const result = this.keybindingService.importKeybindings(this.importText());
      if (result.applied === 0 && (result.conflicts.length > 0 || result.reservedViolations.length > 0)) {
        this.pendingImportConflicts.set(result.conflicts);
        this.pendingReservedViolations.set(result.reservedViolations);
        const parts: string[] = [];
        if (result.conflicts.length > 0) parts.push(`${result.conflicts.length} conflict(s)`);
        if (result.reservedViolations.length > 0) parts.push(`${result.reservedViolations.length} reserved shortcut(s)`);
        this.ioMessage.set(`Import blocked: it would introduce ${parts.join(' and ')}. Resolve them first.`);
        return;
      }
      this.importText.set('');
      this.pendingImportConflicts.set([]);
      this.pendingReservedViolations.set([]);
      this.ioMessage.set(`Imported ${result.applied} shortcut customization(s).`);
    } catch (err) {
      this.pendingImportConflicts.set([]);
      this.pendingReservedViolations.set([]);
      this.ioMessage.set(err instanceof Error ? err.message : 'Import failed.');
    }
  }
}
