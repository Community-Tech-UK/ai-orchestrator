/**
 * ShortcutHintPipe (WS-C9) — renders the live, resolver-derived hint for a
 * keybinding action id, e.g. `{{ 'toggle-command-palette' | shortcutHint }}`.
 *
 * Every displayed shortcut hint must come from here (or the equivalent
 * `KeybindingService.formatBindingByAction` call it wraps) rather than a
 * hardcoded string, so a user customization or platform difference is
 * always reflected. Impure by design: a pure pipe only re-evaluates when
 * its argument changes, but the underlying binding can change (import,
 * customization) without the action id itself changing.
 */
import { Pipe, inject, type PipeTransform } from '@angular/core';
import { KeybindingService } from '../services/keybinding.service';

@Pipe({ name: 'shortcutHint', standalone: true, pure: false })
export class ShortcutHintPipe implements PipeTransform {
  private readonly keybindingService = inject(KeybindingService);

  transform(actionId: string | null | undefined): string {
    if (!actionId) return '';
    return this.keybindingService.formatBindingByAction(actionId);
  }
}
