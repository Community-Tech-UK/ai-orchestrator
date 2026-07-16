import { describe, expect, it } from 'vitest';

import { PROVIDER_MODEL_LIST } from './provider.types';
import { CORE_SETTINGS_METADATA } from './settings-metadata-core';

const DEFAULT_MODEL_SETTING_PROVIDERS = ['claude', 'codex', 'gemini'] as const;

function defaultModelOptions(): { value: string | number; label: string }[] {
  const entry = CORE_SETTINGS_METADATA.find((setting) => setting.key === 'defaultModel');
  if (!entry?.options) {
    throw new Error('defaultModel metadata must expose select options');
  }
  return entry.options;
}

describe('CORE_SETTINGS_METADATA defaultModel options', () => {
  it('are derived from the static provider model list instead of drifting independently', () => {
    const expected = DEFAULT_MODEL_SETTING_PROVIDERS.flatMap((provider) =>
      (PROVIDER_MODEL_LIST[provider] ?? []).map((model) => ({
        value: model.id,
        label: model.name,
      })),
    );

    expect(defaultModelOptions()).toEqual(expected);
  });

  it('does not expose stale models absent from PROVIDER_MODEL_LIST', () => {
    const values = defaultModelOptions().map((option) => option.value);
    const knownValues = new Set(
      DEFAULT_MODEL_SETTING_PROVIDERS.flatMap((provider) =>
        (PROVIDER_MODEL_LIST[provider] ?? []).map((model) => model.id),
      ),
    );

    expect(values).not.toContain('o3');
    expect(values.every((value) => typeof value === 'string' && knownValues.has(value))).toBe(true);
  });
});

describe('CORE_SETTINGS_METADATA customModelsByProvider', () => {
  it('keeps the object-backed setting out of generic row rendering while documenting it', () => {
    const entry = CORE_SETTINGS_METADATA.find((setting) => setting.key === 'customModelsByProvider');

    expect(entry).toMatchObject({
      key: 'customModelsByProvider',
      type: 'json',
      category: 'advanced',
      hidden: true,
    });
  });
});

describe('CORE_SETTINGS_METADATA modelCatalogRemoteOverrideUrl', () => {
  it('documents the optional remote catalog override URL as an advanced setting', () => {
    const entry = CORE_SETTINGS_METADATA.find((setting) => setting.key === 'modelCatalogRemoteOverrideUrl');

    expect(entry).toMatchObject({
      key: 'modelCatalogRemoteOverrideUrl',
      type: 'string',
      category: 'advanced',
    });
    expect(entry?.placeholder).toBe('https://catalog.example.com/models-override.json');
  });
});
