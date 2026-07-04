import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { MAX_MODEL_ID_LENGTH } from '../../shared/types/provider.types';

const mockHome = vi.hoisted(() => ({ path: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((key: string) => {
      if (key === 'home') return mockHome.path;
      return path.join(mockHome.path, key);
    }),
  },
}));

import { _resetAgentRegistryForTesting, getAgentRegistry } from './agent-registry';

describe('AgentRegistry custom agent model hints', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aio-agent-registry-'));
    mockHome.path = tempRoot;
    _resetAgentRegistryForTesting();
  });

  afterEach(async () => {
    _resetAgentRegistryForTesting();
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('drops custom agent model hints beyond the dynamic model id limit', async () => {
    const tooLongCatalogModelId = `${'m'.repeat(MAX_MODEL_ID_LENGTH - 2)}-v1`;
    expect(tooLongCatalogModelId).toHaveLength(MAX_MODEL_ID_LENGTH + 1);
    await writeAgentMarkdown('long-model.md', [
      '---',
      'name: Long Model',
      `model: ${tooLongCatalogModelId}`,
      '---',
      '# Long Model',
      '',
      'Use a model hint that should be ignored.',
    ].join('\n'));

    const { agents } = await getAgentRegistry().listAgents(path.join(tempRoot, 'workspace'));
    const agent = agents.find((entry) => entry.source === 'file' && entry.profile.name === 'Long Model');

    expect(agent).toBeDefined();
    expect(agent?.profile.modelOverride).toBeUndefined();
  });

  async function writeAgentMarkdown(fileName: string, contents: string): Promise<void> {
    const dir = path.join(tempRoot, '.orchestrator', 'agents');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, fileName), contents, 'utf8');
  }
});
