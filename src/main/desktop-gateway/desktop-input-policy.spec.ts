import { describe, expect, it } from 'vitest';
import {
  isConfirmHotkey,
  isDestructiveHotkey,
  isDeniedHotkeyAtLevel,
} from './desktop-input-policy';
import type { ComputerUseAutonomyLevel } from '../../shared/types/desktop-gateway-settings.types';

const CONFIRM_KEYS = [['enter'], ['Return'], ['space'], ['SPACE']];

const DESTRUCTIVE_KEYS = [
  ['cmd', 'q'],
  ['command', 'Q'],
  ['cmd', 'option', 'escape'],
  ['cmd', 'delete'],
  ['shift', 'backspace'],
  ['ctrl', 'cmd', 'power'],
  ['ctrl', 'cmd', 'eject'],
];

const ORDINARY_KEYS = [['cmd', 'c'], ['cmd', 'v'], ['tab'], ['escape'], ['cmd', 's']];

describe('hotkey classification', () => {
  it.each(CONFIRM_KEYS)('classifies %s as a confirm key', (...keys) => {
    expect(isConfirmHotkey(keys)).toBe(true);
    expect(isDestructiveHotkey(keys)).toBe(false);
  });

  it.each(DESTRUCTIVE_KEYS)('classifies %s as destructive', (...keys) => {
    expect(isDestructiveHotkey(keys)).toBe(true);
  });

  it.each(ORDINARY_KEYS)('classifies %s as neither', (...keys) => {
    expect(isConfirmHotkey(keys)).toBe(false);
    expect(isDestructiveHotkey(keys)).toBe(false);
  });
});

describe('isDeniedHotkeyAtLevel', () => {
  it.each(CONFIRM_KEYS)('denies %s at guarded only', (...keys) => {
    expect(isDeniedHotkeyAtLevel(keys, 'guarded')).toBe(true);
    // The whole point of the change: a UI cannot be driven without Enter/Space.
    expect(isDeniedHotkeyAtLevel(keys, 'trusted')).toBe(false);
    expect(isDeniedHotkeyAtLevel(keys, 'unrestricted')).toBe(false);
  });

  it.each(DESTRUCTIVE_KEYS)('denies %s at guarded and trusted', (...keys) => {
    expect(isDeniedHotkeyAtLevel(keys, 'guarded')).toBe(true);
    expect(isDeniedHotkeyAtLevel(keys, 'trusted')).toBe(true);
    expect(isDeniedHotkeyAtLevel(keys, 'unrestricted')).toBe(false);
  });

  it.each<ComputerUseAutonomyLevel>(['guarded', 'trusted', 'unrestricted'])(
    'permits ordinary combinations at %s',
    (level) => {
      for (const keys of ORDINARY_KEYS) {
        expect(isDeniedHotkeyAtLevel(keys, level)).toBe(false);
      }
    },
  );

  it('normalizes whitespace and case before deciding', () => {
    expect(isDeniedHotkeyAtLevel([' Cmd ', ' Q '], 'trusted')).toBe(true);
    expect(isDeniedHotkeyAtLevel([' EnTeR '], 'guarded')).toBe(true);
  });
});
