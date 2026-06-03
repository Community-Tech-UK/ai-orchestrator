import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { getKnownModelsForCli } from '../create-validation-helpers';

describe('getKnownModelsForCli', () => {
  beforeEach(() => {
    cursorListModels.mockReset();
    copilotListModels.mockReset();
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
});
