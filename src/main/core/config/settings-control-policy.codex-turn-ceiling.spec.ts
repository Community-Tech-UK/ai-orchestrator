import { describe, expect, it } from 'vitest';
import { coerceRendererSettingValue, coerceWritableSettingValue } from './settings-control-policy';
import { PAUSE_SETTING_VALIDATORS } from './settings-validators';
import { DEFAULT_SETTINGS, SETTINGS_METADATA } from '../../../shared/types/settings.types';
import { SETTING_SURFACING } from '../../../shared/types/settings-surfacing';
import { ADVANCED_SECTION_DEFINITIONS } from '../../../renderer/app/features/settings/advanced-settings-sections';
import {
  CODEX_TURN_CEILING_MAX_TOKENS,
  type CodexTurnCeilingSettings,
} from '../../../shared/types/codex-turn-ceiling-settings.types';

const KEYS: (keyof CodexTurnCeilingSettings)[] = [
  'codexTurnCeilingHarnessWorkWrapUpTokens',
  'codexTurnCeilingHarnessWorkStopTokens',
  'codexTurnCeilingChatsWrapUpTokens',
  'codexTurnCeilingChatsStopTokens',
];

describe('Codex per-round token ceiling settings (Decision 16a)', () => {
  it('ships 150M/300M for Harness work and a 150M nudge with no stop for chats', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      codexTurnCeilingHarnessWorkWrapUpTokens: 150_000_000,
      codexTurnCeilingHarnessWorkStopTokens: 300_000_000,
      codexTurnCeilingChatsWrapUpTokens: 150_000_000,
      codexTurnCeilingChatsStopTokens: 0,
    });
  });

  it.each(KEYS)('%s is a visible tab setting that accepts 0 up to the bound on every write surface', (key) => {
    expect(SETTING_SURFACING[key]).toBe('tab');
    for (const value of [0, 1, 150_000_000, CODEX_TURN_CEILING_MAX_TOKENS]) {
      expect(coerceWritableSettingValue(key, value).value).toBe(value);
      expect(coerceRendererSettingValue(key, value).value).toBe(value);
      expect(PAUSE_SETTING_VALIDATORS[key]?.(value)).toEqual({ ok: true, value });
    }
    for (const value of [-1, 1.5, Number.NaN, CODEX_TURN_CEILING_MAX_TOKENS + 1, '300']) {
      expect(() => coerceWritableSettingValue(key, value as number)).toThrow();
      expect(() => coerceRendererSettingValue(key, value as number)).toThrow();
      expect(PAUSE_SETTING_VALIDATORS[key]?.(value as number)?.ok).toBe(false);
    }
  });

  it.each(KEYS)('%s says plainly that it cannot act in command mode', (key) => {
    const description = SETTINGS_METADATA.find((entry) => entry.key === key)?.description ?? '';
    expect(description).toContain('only works for Codex sessions that use the Codex app server');
    expect(description).toContain('command mode');
    expect(description).toContain('only when a turn ends');
    expect(description).toContain('hardened');
  });

  it('appears in the advanced settings next to the other Codex controls', () => {
    const listed = ADVANCED_SECTION_DEFINITIONS.flatMap((section) => [...section.keys]);
    for (const key of KEYS) expect(listed).toContain(key);
  });
});
