/**
 * Platform-reserved key combinations (WS-C9).
 *
 * A conservative list of combos AIO must never let a default or
 * user-customized binding claim, because the OS/window-manager owns them (or
 * because losing them would be dangerous, e.g. an accidental app quit).
 *
 * Deliberately NOT included: combos AIO already binds on purpose today
 * (`Cmd+W` → close-instance, `Cmd+H` → toggle-history, `Cmd+,` →
 * toggle-settings). Those prove the app can safely intercept some
 * conventionally-reserved combos in its own BrowserWindow; this list only
 * covers the ones AIO does not use and that are either destructive
 * (quit) or an OS-level gesture Electron typically never even forwards to
 * the renderer, so binding them would silently never fire.
 */
import { normalizeCombo } from '../services/keybinding-conflicts';
import type { KeyCombo } from '../../../../shared/types/keybinding.types';

export type KeybindingPlatform = 'mac' | 'other';

export interface ReservedCombo {
  readonly combo: KeyCombo;
  /** 'all' = reserved on every platform. */
  readonly platform: KeybindingPlatform | 'all';
  readonly reason: string;
}

export const RESERVED_COMBOS: readonly ReservedCombo[] = [
  { combo: { key: 'q', modifiers: ['meta'] }, platform: 'mac', reason: 'macOS Quit Application' },
  { combo: { key: 'm', modifiers: ['meta'] }, platform: 'mac', reason: 'macOS Minimize Window' },
  { combo: { key: 'tab', modifiers: ['meta'] }, platform: 'mac', reason: 'macOS Application Switcher' },
  { combo: { key: ' ', modifiers: ['meta'] }, platform: 'mac', reason: 'macOS Spotlight' },
  { combo: { key: 'f4', modifiers: ['alt'] }, platform: 'other', reason: 'Windows Close Window' },
  { combo: { key: 'tab', modifiers: ['alt'] }, platform: 'other', reason: 'Windows/Linux Task Switcher' },
  { combo: { key: 'delete', modifiers: ['ctrl', 'alt'] }, platform: 'other', reason: 'Windows Secure Attention Sequence' },
  { combo: { key: 'escape', modifiers: ['ctrl'] }, platform: 'other', reason: 'Windows Start Menu' },
];

const RESERVED_BY_COMBO = new Map<string, ReservedCombo>();
for (const entry of RESERVED_COMBOS) {
  RESERVED_BY_COMBO.set(`${entry.platform}|${normalizeCombo(entry.combo)}`, entry);
}

/** Returns the matching reserved-combo entry for `combo` on `platform`, or `undefined` if unreserved. */
export function findReservedCombo(combo: KeyCombo, platform: KeybindingPlatform): ReservedCombo | undefined {
  const key = normalizeCombo(combo);
  return RESERVED_BY_COMBO.get(`all|${key}`) ?? RESERVED_BY_COMBO.get(`${platform}|${key}`);
}

export function isReservedCombo(combo: KeyCombo, platform: KeybindingPlatform): boolean {
  return findReservedCombo(combo, platform) !== undefined;
}
