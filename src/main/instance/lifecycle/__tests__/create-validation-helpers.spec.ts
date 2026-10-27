import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearKnownModelCatalogSnapshotForTesting,
  replaceKnownModelCatalogSnapshot,
} from '../../../../shared/types/provider.types';
import type { CopilotAccountProfile } from '../../../../shared/types/copilot-account.types';
import type { CopilotCliConfig } from '../../../cli/adapters/copilot-cli-adapter.types';

/**
 * Regression coverage for getKnownModelsForCli — the model-validation source of
 * truth used by both createInstance (spawn) and changeModel.
 *
 * The bug it guards: Cursor's real model list is dynamic (~130 models from
 * `cursor-agent --list-models`); the static PROVIDER_MODEL_LIST entry is only a
 * tiny curated fallback. Validating a Cursor selection against that static
 * subset wrongly reset valid live models (e.g. `composer-2.5-fast`) to the
 * provider default (`auto`). So Cursor — like Copilot — must be queried
 * dynamically here.
 */

const { cursorListModels, copilotListModels, listCopilotProfiles } = vi.hoisted(() => ({
  cursorListModels: vi.fn(),
  copilotListModels: vi.fn(),
  listCopilotProfiles: vi.fn<() => CopilotAccountProfile[]>(),
}));

vi.mock('../../../cli/adapters/cursor-cli-adapter', () => ({
  CursorCliAdapter: class {
    listAvailableModels = cursorListModels;
  },
}));

vi.mock('../../../cli/adapters/copilot-cli-adapter', () => ({
  CopilotCliAdapter: class {
    constructor(private readonly config: CopilotCliConfig = {}) {}
    listAvailableModels(options?: { fallbackToStatic?: boolean }) {
      return copilotListModels(this.config, options);
    }
  },
}));

vi.mock('../../../providers/copilot/copilot-account-routing-service', () => ({
  getCopilotAccountRoutingService: () => ({ listProfiles: listCopilotProfiles }),
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { getKnownModelsForCli, requiresFreshConfiguredModelSpawn } from '../create-validation-helpers';
import { ModelSelectionResolver } from '../model-selection-resolver';

function profile(id: string, isDefault = false): CopilotAccountProfile {
  return {
    id, label: id, expectedLogin: null, host: 'github.com',
    accountKind: 'personal', scopePolicy: 'default-eligible', automationPolicy: 'allow-routed',
    isDefault, createdAt: 0, updatedAt: 0,
  };
}

describe('requiresFreshConfiguredModelSpawn', () => {
  it('requires a fresh spawn for an explicit Cursor/Copilot model (warm process runs the default)', () => {
    expect(requiresFreshConfiguredModelSpawn('cursor', 'composer-2.5')).toBe(true);
    expect(requiresFreshConfiguredModelSpawn('cursor', 'gpt-5.3-codex')).toBe(true);
    expect(requiresFreshConfiguredModelSpawn('copilot', 'claude-opus-4.8')).toBe(true);
  });

  it('requires a fresh spawn for an explicit Antigravity model', () => {
    expect(requiresFreshConfiguredModelSpawn('antigravity', 'Gemini 3.1 Pro (High)')).toBe(true);
  });

  it('allows warm-start for the auto sentinel / unset model', () => {
    expect(requiresFreshConfiguredModelSpawn('cursor', 'auto')).toBe(false);
    expect(requiresFreshConfiguredModelSpawn('cursor', 'AUTO')).toBe(false);
    expect(requiresFreshConfiguredModelSpawn('cursor', undefined)).toBe(false);
    expect(requiresFreshConfiguredModelSpawn('cursor', '   ')).toBe(false);
  });

  it('never blocks warm-start for providers whose model can be applied after prewarm', () => {
    expect(requiresFreshConfiguredModelSpawn('claude', 'opus')).toBe(false);
    expect(requiresFreshConfiguredModelSpawn('codex', 'gpt-5.5')).toBe(false);
    expect(requiresFreshConfiguredModelSpawn('gemini', 'gemini-3.1-pro')).toBe(false);
  });
});

describe('getKnownModelsForCli', () => {
  beforeEach(() => {
    cursorListModels.mockReset();
    copilotListModels.mockReset();
    listCopilotProfiles.mockReset().mockReturnValue([]);
    clearKnownModelCatalogSnapshotForTesting();
  });

  it('queries the Cursor CLI dynamically (not the static curated subset)', async () => {
    cursorListModels.mockResolvedValue([
      { id: 'auto', name: 'Auto' },
      { id: 'composer-2.5-fast', name: 'Composer 2.5 Fast' },
      { id: 'gpt-5.3-codex-high', name: 'Codex 5.3 High' },
    ]);

    const models = await getKnownModelsForCli('cursor');

    expect(cursorListModels).toHaveBeenCalledTimes(1);
    // The live ids — including ones absent from the curated static fallback —
    // must be present so changeModel/spawn don't reset them to 'auto'.
    expect(models).toContain('composer-2.5-fast');
    expect(models).toContain('gpt-5.3-codex-high');
  });

  it('queries the Copilot CLI dynamically', async () => {
    copilotListModels.mockResolvedValue([{ id: 'claude-opus-4.8', name: 'Opus 4.8' }]);

    const models = await getKnownModelsForCli('copilot');

    expect(copilotListModels).toHaveBeenCalledTimes(1);
    expect(models).toContain('claude-opus-4.8');
    expect(copilotListModels).toHaveBeenCalledWith(
      { accountProfileId: 'legacy', accountIsLegacy: true },
      { fallbackToStatic: false },
    );
  });

  it('preserves live-only Opus when new-session validation has no resolved account yet', async () => {
    listCopilotProfiles.mockReturnValue([profile('personal', true), profile('enterprise')]);
    copilotListModels.mockImplementation(async (config: CopilotCliConfig) => [
      { id: config.accountProfileId === 'enterprise' ? 'claude-opus-5.5' : 'claude-opus-5' },
    ]);

    const result = await new ModelSelectionResolver().resolve({
      provider: 'copilot', configModelOverride: 'claude-opus-5.5',
    });

    expect(result).toEqual({ model: 'claude-opus-5.5' });
  });

  it('keeps the other account live models when one profile cannot be discovered', async () => {
    listCopilotProfiles.mockReturnValue([profile('personal', true), profile('enterprise')]);
    copilotListModels.mockImplementation(async (config: CopilotCliConfig) => {
      if (config.accountProfileId === 'personal') throw new Error('Profile signed out');
      return [{ id: 'claude-opus-5.5' }];
    });

    expect(await getKnownModelsForCli('copilot')).toContain('claude-opus-5.5');
  });

  it('keeps explicitly scoped validation on the requested account', async () => {
    listCopilotProfiles.mockReturnValue([profile('personal', true), profile('enterprise')]);
    copilotListModels.mockImplementation(async (config: CopilotCliConfig) => [
      { id: config.accountProfileId === 'enterprise' ? 'claude-opus-5.5' : 'claude-opus-5' },
    ]);

    expect(await getKnownModelsForCli('copilot', 'personal')).toEqual(['claude-opus-5']);
    expect(listCopilotProfiles).not.toHaveBeenCalled();
    expect(copilotListModels).toHaveBeenCalledWith({ accountProfileId: 'personal' }, undefined);
  });

  it('merges the profile union with models already learned by the unified catalog', async () => {
    replaceKnownModelCatalogSnapshot([{ provider: 'copilot', id: 'gpt-catalog-only' }]);
    copilotListModels.mockResolvedValue([{ id: 'claude-opus-5.5' }]);

    expect(await getKnownModelsForCli('copilot')).toEqual(['claude-opus-5.5', 'gpt-catalog-only']);
  });

  it('uses the last catalog when every Copilot profile discovery fails', async () => {
    replaceKnownModelCatalogSnapshot([{ provider: 'copilot', id: 'claude-opus-5.5' }]);
    copilotListModels.mockRejectedValue(new Error('Copilot unavailable'));

    expect(await getKnownModelsForCli('copilot')).toEqual(['claude-opus-5.5']);
  });

  it('uses the static Copilot catalog when discovery fails with no learned catalog', async () => {
    copilotListModels.mockRejectedValue(new Error('Copilot unavailable'));

    expect(await getKnownModelsForCli('copilot')).toContain('auto');
  });

  it('falls back to the static catalog when the Cursor CLI is unreachable', async () => {
    cursorListModels.mockRejectedValue(new Error('cursor-agent not found'));

    const models = await getKnownModelsForCli('cursor');

    // Real provider.types is used (not mocked here): the static Cursor fallback
    // always contains the `auto` sentinel.
    expect(models).toContain('auto');
  });

  it('uses the static catalog for non-dynamic providers without spawning a CLI', async () => {
    const models = await getKnownModelsForCli('claude');

    expect(cursorListModels).not.toHaveBeenCalled();
    expect(copilotListModels).not.toHaveBeenCalled();
    expect(models.length).toBeGreaterThan(0);
  });

  it('includes catalog-only ids for strict providers without spawning a CLI', async () => {
    replaceKnownModelCatalogSnapshot([
      { provider: 'gemini', id: 'gemini-4-pro-preview' },
      { provider: 'antigravity', id: 'Gemini 4 Pro (High)' },
    ]);

    const geminiModels = await getKnownModelsForCli('gemini');
    const antigravityModels = await getKnownModelsForCli('antigravity');

    expect(cursorListModels).not.toHaveBeenCalled();
    expect(copilotListModels).not.toHaveBeenCalled();
    expect(geminiModels).toContain('gemini-4-pro-preview');
    expect(antigravityModels).toContain('Gemini 4 Pro (High)');
  });

  it('uses the live catalog snapshot as authoritative for Codex once it is populated', async () => {
    replaceKnownModelCatalogSnapshot([
      { provider: 'codex', id: 'gpt-live-only' },
    ]);

    const models = await getKnownModelsForCli('codex');

    expect(models).toEqual(['gpt-live-only']);
  });
});
