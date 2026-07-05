import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearKnownModelCatalogSnapshotForTesting,
  replaceKnownModelCatalogSnapshot,
} from '../../../../shared/types/provider.types';

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

const { cursorListModels, copilotListModels } = vi.hoisted(() => ({
  cursorListModels: vi.fn(),
  copilotListModels: vi.fn(),
}));

vi.mock('../../../cli/adapters/cursor-cli-adapter', () => ({
  CursorCliAdapter: class {
    listAvailableModels = cursorListModels;
  },
}));

vi.mock('../../../cli/adapters/copilot-cli-adapter', () => ({
  CopilotCliAdapter: class {
    listAvailableModels = copilotListModels;
  },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { getKnownModelsForCli, requiresFreshConfiguredModelSpawn } from '../create-validation-helpers';

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
