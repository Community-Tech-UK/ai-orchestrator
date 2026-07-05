import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelDisplayInfo } from '../../../shared/types/provider.types';
import { PROVIDER_MODEL_LIST } from '../../../shared/types/provider.types';

const discoverCodexModelsMock = vi.hoisted(() => vi.fn());

vi.mock('./codex/model-list', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codex/model-list')>();
  return {
    ...actual,
    discoverCodexModels: discoverCodexModelsMock,
  };
});

import { CodexCliAdapter } from './codex-cli-adapter';

describe('CodexCliAdapter.listAvailableModels', () => {
  afterEach(() => {
    discoverCodexModelsMock.mockReset();
  });

  it('returns app-server-discovered models', async () => {
    const discovered: ModelDisplayInfo[] = [
      { id: 'gpt-5.9-codex', name: 'GPT-5.9 Codex', tier: 'balanced', family: 'GPT' },
    ];
    discoverCodexModelsMock.mockResolvedValue(discovered);
    const adapter = new CodexCliAdapter({ workingDir: '/tmp/project' });

    await expect(adapter.listAvailableModels()).resolves.toBe(discovered);
    expect(discoverCodexModelsMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/project',
    }));
  });

  it('falls back to static Codex models by default when app-server discovery fails', async () => {
    discoverCodexModelsMock.mockRejectedValue(new Error('model/list unsupported'));
    const adapter = new CodexCliAdapter();

    await expect(adapter.listAvailableModels()).resolves.toEqual(PROVIDER_MODEL_LIST['codex']);
  });

  it('can disable static fallback so catalog discovery does not fake cli-discovered provenance', async () => {
    discoverCodexModelsMock.mockRejectedValue(new Error('model/list unsupported'));
    const adapter = new CodexCliAdapter();

    await expect(adapter.listAvailableModels({ fallbackToStatic: false })).rejects.toThrow('model/list unsupported');
  });
});
