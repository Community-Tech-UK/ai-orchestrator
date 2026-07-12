import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OPENAI_MODELS, CLAUDE_MODELS } from '../../../shared/types/provider.types';

const getAll = vi.fn();

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll }),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { resolveAutomationDefaultModel } = await import('../automation-model-defaults');

describe('resolveAutomationDefaultModel', () => {
  beforeEach(() => {
    getAll.mockReset();
  });

  it('prefers the operator loopModelByProvider entry over the interactive default', () => {
    getAll.mockReturnValue({ loopModelByProvider: { codex: OPENAI_MODELS.GPT56_TERRA } });

    // The regression this whole module exists for: automation must NOT inherit
    // the interactive codex default (gpt-5.6-sol) just because it changed.
    expect(resolveAutomationDefaultModel('codex')).toBe(OPENAI_MODELS.GPT56_TERRA);
    expect(resolveAutomationDefaultModel('codex')).not.toBe(OPENAI_MODELS.GPT56_SOL);
  });

  it('falls back to the provider interactive default when no entry is configured', () => {
    getAll.mockReturnValue({ loopModelByProvider: {} });

    expect(resolveAutomationDefaultModel('codex')).toBe(OPENAI_MODELS.GPT56_SOL);
    expect(resolveAutomationDefaultModel('claude')).toBe(CLAUDE_MODELS.OPUS);
  });

  it('treats empty string, whitespace and "auto" as "no opinion"', () => {
    for (const configured of ['', '   ', 'auto', 'AUTO']) {
      getAll.mockReturnValue({ loopModelByProvider: { codex: configured } });
      expect(resolveAutomationDefaultModel('codex')).toBe(OPENAI_MODELS.GPT56_SOL);
    }
  });

  it('tolerates a missing loopModelByProvider map', () => {
    getAll.mockReturnValue({});

    expect(resolveAutomationDefaultModel('codex')).toBe(OPENAI_MODELS.GPT56_SOL);
  });

  it('falls back instead of throwing when settings cannot be read', () => {
    getAll.mockImplementation(() => {
      throw new Error('settings unavailable');
    });

    // A settings failure must never take a running loop down.
    expect(resolveAutomationDefaultModel('codex')).toBe(OPENAI_MODELS.GPT56_SOL);
  });
});
