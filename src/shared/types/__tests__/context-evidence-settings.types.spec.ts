import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTEXT_EVIDENCE_MODE_BY_PROVIDER } from '../settings-defaults';
import { DEFAULT_SETTINGS, type ContextEvidenceMode } from '../settings.types';

const VALID_MODES = new Set<ContextEvidenceMode>(['off', 'shadow', 'enforce']);

describe('DEFAULT_SETTINGS — contextEvidenceModeByProvider shape', () => {
  it('defaults every concrete provider to off, matching the frozen default map', () => {
    expect(DEFAULT_SETTINGS.contextEvidenceModeByProvider).toEqual(DEFAULT_CONTEXT_EVIDENCE_MODE_BY_PROVIDER);
    for (const mode of Object.values(DEFAULT_SETTINGS.contextEvidenceModeByProvider)) {
      expect(mode).toBe('off');
    }
  });

  it('never includes the auto selector or the legacy openai alias as a default key', () => {
    const keys = Object.keys(DEFAULT_SETTINGS.contextEvidenceModeByProvider);
    expect(keys).not.toContain('auto');
    expect(keys).not.toContain('openai');
    expect(keys).toContain('codex');
  });

  it('only ever contains off | shadow | enforce values', () => {
    for (const mode of Object.values(DEFAULT_SETTINGS.contextEvidenceModeByProvider)) {
      expect(VALID_MODES.has(mode as ContextEvidenceMode)).toBe(true);
    }
  });

  it('is a distinct object per DEFAULT_SETTINGS reference (not a shared mutable default)', () => {
    expect(DEFAULT_SETTINGS.contextEvidenceModeByProvider).not.toBe(DEFAULT_CONTEXT_EVIDENCE_MODE_BY_PROVIDER);
  });
});
