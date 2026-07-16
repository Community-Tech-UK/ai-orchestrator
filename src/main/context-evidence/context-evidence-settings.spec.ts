import { describe, expect, it, vi } from 'vitest';
import {
  assertPrivilegedSettingsCliWritable,
  coerceRendererSettingValue,
  coerceWritableSettingValue,
  getSettingsToolPolicy,
} from '../core/config/settings-control-policy';
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types/settings.types';
import { createSettingsToolDefinitions } from '../mcp/orchestrator-settings-tools';
import {
  getContextEvidenceMode,
  normalizeContextEvidenceModeByProvider,
  normalizeContextEvidenceProviderId,
  type ContextEvidenceProviderRegistry,
} from './context-evidence-settings';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const fakeRegistry: ContextEvidenceProviderRegistry = {
  list: () => [{ provider: 'claude' }, { provider: 'codex' }, { provider: 'gemini' }],
  listPluginProviderAdapters: () => [{ descriptor: { provider: 'copilot' } }],
};

describe('normalizeContextEvidenceProviderId', () => {
  it('canonicalizes case and whitespace', () => {
    expect(normalizeContextEvidenceProviderId('  Codex  ')).toBe('codex');
    expect(normalizeContextEvidenceProviderId('CLAUDE')).toBe('claude');
  });

  it('maps the legacy openai alias to codex', () => {
    expect(normalizeContextEvidenceProviderId('openai')).toBe('codex');
  });

  it('drops the auto selector and empty/blank input', () => {
    expect(normalizeContextEvidenceProviderId('auto')).toBeNull();
    expect(normalizeContextEvidenceProviderId('')).toBeNull();
    expect(normalizeContextEvidenceProviderId('   ')).toBeNull();
  });
});

describe('normalizeContextEvidenceModeByProvider', () => {
  it('initializes every concrete adapter (including plugin adapters) to off', () => {
    const normalized = normalizeContextEvidenceModeByProvider(undefined, fakeRegistry);
    expect(normalized).toEqual({ claude: 'off', codex: 'off', copilot: 'off', gemini: 'off' });
  });

  it('applies persisted modes only for known concrete providers with valid values', () => {
    const normalized = normalizeContextEvidenceModeByProvider(
      { claude: 'shadow', codex: 'enforce', unknownProvider: 'enforce', gemini: 'not-a-mode' },
      fakeRegistry,
    );
    expect(normalized).toEqual({ claude: 'shadow', codex: 'enforce', copilot: 'off', gemini: 'off' });
    expect(normalized).not.toHaveProperty('unknownProvider');
  });

  it('ignores the auto selector key entirely', () => {
    const normalized = normalizeContextEvidenceModeByProvider({ auto: 'enforce' }, fakeRegistry);
    expect(normalized).toEqual({ claude: 'off', codex: 'off', copilot: 'off', gemini: 'off' });
  });

  it('maps the legacy openai key onto codex, with an explicit codex key winning', () => {
    const legacyOnly = normalizeContextEvidenceModeByProvider({ openai: 'shadow' }, fakeRegistry);
    expect(legacyOnly['codex']).toBe('shadow');

    const explicitWins = normalizeContextEvidenceModeByProvider(
      { openai: 'shadow', codex: 'enforce' },
      fakeRegistry,
    );
    expect(explicitWins['codex']).toBe('enforce');
  });

  it('returns a fresh complete map for malformed input (non-object, array, null)', () => {
    for (const malformed of [null, undefined, 'off', ['codex', 'shadow'], 42]) {
      expect(normalizeContextEvidenceModeByProvider(malformed, fakeRegistry)).toEqual({
        claude: 'off', codex: 'off', copilot: 'off', gemini: 'off',
      });
    }
  });

  it('does not depend on object insertion order between canonical and legacy keys', () => {
    const legacyFirst = normalizeContextEvidenceModeByProvider({ openai: 'shadow', codex: 'enforce' }, fakeRegistry);
    const canonicalFirst = normalizeContextEvidenceModeByProvider({ codex: 'enforce', openai: 'shadow' }, fakeRegistry);
    expect(legacyFirst).toEqual(canonicalFirst);
  });
});

describe('getContextEvidenceMode', () => {
  it('resolves the canonical persisted mode for one provider', () => {
    expect(getContextEvidenceMode({ codex: 'enforce' }, 'codex')).toBe('enforce');
    expect(getContextEvidenceMode({ codex: 'enforce' }, 'CODEX')).toBe('enforce');
  });

  it('falls back to off for the auto selector, missing input, or unknown provider', () => {
    expect(getContextEvidenceMode({ codex: 'enforce' }, 'auto')).toBe('off');
    expect(getContextEvidenceMode(undefined, 'codex')).toBe('off');
    expect(getContextEvidenceMode({}, 'codex')).toBe('off');
  });

  it('falls back to the legacy openai alias only when codex has no explicit value', () => {
    expect(getContextEvidenceMode({ openai: 'shadow' }, 'codex')).toBe('shadow');
    expect(getContextEvidenceMode({ openai: 'shadow', codex: 'enforce' }, 'codex')).toBe('enforce');
  });

  it('ignores malformed persisted values rather than throwing', () => {
    expect(getContextEvidenceMode({ codex: 'not-a-real-mode' }, 'codex')).toBe('off');
  });
});

describe('contextEvidenceModeByProvider control-policy and settings-tool exposure', () => {
  it('is read-only through the agent-facing settings tool tier', () => {
    expect(getSettingsToolPolicy('contextEvidenceModeByProvider')).toMatchObject({ tier: 'read-only' });
    expect(() => coerceWritableSettingValue('contextEvidenceModeByProvider', { codex: 'shadow' }))
      .toThrow(/read-only/);
  });

  it('is operator-only even on the privileged aio-mcp CLI path', () => {
    expect(() => assertPrivilegedSettingsCliWritable('contextEvidenceModeByProvider'))
      .toThrow(/operator-only/);
  });

  it('is writable by the trusted operator renderer surface, normalized through the Task 7 helper', () => {
    const coerced = coerceRendererSettingValue('contextEvidenceModeByProvider', { claude: 'enforce' });
    expect(coerced).toEqual({ key: 'contextEvidenceModeByProvider', value: { claude: 'enforce' } });
    // The renderer boundary only type-checks the raw shape; normalization into a
    // complete, alias-resolved map happens once through getContextEvidenceMode /
    // normalizeContextEvidenceModeByProvider at every read site (this file).
    expect(normalizeContextEvidenceModeByProvider(coerced.value, fakeRegistry)).toEqual({
      claude: 'enforce', codex: 'off', copilot: 'off', gemini: 'off',
    });
  });

  it('exposes get_setting (readable) but refuses set_setting (not silently agent-writable) via the safe MCP tool surface', async () => {
    const values: AppSettings = { ...DEFAULT_SETTINGS, contextEvidenceModeByProvider: { codex: 'shadow' } };
    const settingsManager = {
      getAll: () => ({ ...values }),
      get: <K extends keyof AppSettings>(key: K) => values[key],
      set: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => { values[key] = value; },
      resetOne: <K extends keyof AppSettings>(key: K) => { values[key] = DEFAULT_SETTINGS[key]; },
    };
    const tools = createSettingsToolDefinitions({ settingsManager });
    const getTool = tools.find((tool) => tool.name === 'get_setting')!;
    const setTool = tools.find((tool) => tool.name === 'set_setting')!;

    const read = await getTool.handler({ key: 'contextEvidenceModeByProvider' }) as { value: unknown; writable: boolean };
    expect(read).toMatchObject({ value: { codex: 'shadow' }, writable: false });
    await expect(setTool.handler({ key: 'contextEvidenceModeByProvider', value: { codex: 'enforce' } }))
      .rejects.toThrow(/read-only/);
    expect(values.contextEvidenceModeByProvider).toEqual({ codex: 'shadow' });
  });
});
