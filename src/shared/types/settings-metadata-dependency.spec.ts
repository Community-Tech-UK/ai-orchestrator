import { describe, expect, it } from 'vitest';
import { SETTINGS_METADATA } from './settings-metadata';

describe('setting dependencies', () => {
  it('declares a dependency when the description says the setting is only used with another toggle', () => {
    const conditional = SETTINGS_METADATA.filter(meta => /only used when/i.test(meta.description));
    expect(conditional.length).toBeGreaterThan(0);
    for (const meta of conditional) expect(meta.dependsOn, meta.key).toBeTruthy();
  });
  it('declares both known dependencies and resolves each to real metadata', () => {
    expect(SETTINGS_METADATA.find(m => m.key === 'maxDiskStorageMB')?.dependsOn).toBe('enableDiskStorage');
    expect(SETTINGS_METADATA.find(m => m.key === 'chromeDevtoolsAttachProfileId')?.dependsOn).toBe('chromeDevtoolsAttachEnabled');
    for (const meta of SETTINGS_METADATA.filter(m => m.dependsOn)) {
      expect(SETTINGS_METADATA.some(parent => parent.key === meta.dependsOn), meta.key).toBe(true);
    }
  });
});
