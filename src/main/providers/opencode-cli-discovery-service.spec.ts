import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('./unified-model-catalog-service', () => ({
  getUnifiedModelCatalog: () => ({ onCliDiscoveryRefreshed: vi.fn() }),
}));

import {
  discoverOpenCodeModels,
  OpenCodeCliDiscoveryService,
  parseOpenCodeModelList,
  toOpenCodeModelDisplayInfos,
} from './opencode-cli-discovery-service';

const block = (id: string, name: string, toolcall: boolean, output: Record<string, boolean>) =>
  `${id}\n${JSON.stringify({ id: id.split('/')[1], providerID: id.split('/')[0], name, capabilities: { toolcall, output } }, null, 2)}`;

/** Shape of `opencode models --verbose` 1.18.29 (fields trimmed). */
const VERBOSE_OUTPUT = [
  block('opencode/big-pickle', 'Big Pickle', true, { text: true, audio: false }),
  block('xiaomi-token-plan-ams/mimo-v2-tts', 'MiMo-V2-TTS', false, { text: false, audio: true }),
  block('xiaomi-token-plan-ams/mimo-v2.6-pro', 'MiMo-V2.6-Pro', true, { text: true, audio: false }),
  block('xiaomi-token-plan-ams/mimo-v2.6-flash', 'MiMo-V2.6-Flash', true, { text: true, audio: false }),
].join('\n');

describe('parseOpenCodeModelList', () => {
  it('reads provider/model headers and their metadata', () => {
    const entries = parseOpenCodeModelList(VERBOSE_OUTPUT);
    expect(entries.map((entry) => [entry.id, entry.isChatModel])).toEqual([
      ['opencode/big-pickle', true],
      ['xiaomi-token-plan-ams/mimo-v2-tts', false],
      ['xiaomi-token-plan-ams/mimo-v2.6-pro', true],
      ['xiaomi-token-plan-ams/mimo-v2.6-flash', true],
    ]);
    expect(entries[2]).toMatchObject({ providerId: 'xiaomi-token-plan-ams', name: 'MiMo-V2.6-Pro' });
  });

  it('falls back to a name filter when there is no capability metadata', () => {
    const entries = parseOpenCodeModelList('opencode/big-pickle\nxiaomi-token-plan-ams/mimo-v2.5-tts-voiceclone\n');
    expect(entries.map((entry) => [entry.id, entry.isChatModel])).toEqual([
      ['opencode/big-pickle', true],
      ['xiaomi-token-plan-ams/mimo-v2.5-tts-voiceclone', false],
    ]);
  });

  it('ignores banner lines and broken JSON without losing the ids', () => {
    const entries = parseOpenCodeModelList('Loading models...\nopencode/big-pickle\n{ not json\n');
    expect(entries).toEqual([{ id: 'opencode/big-pickle', providerId: 'opencode', isChatModel: true }]);
  });
});

describe('toOpenCodeModelDisplayInfos', () => {
  it('drops non-chat models and groups by backend label', () => {
    expect(toOpenCodeModelDisplayInfos(parseOpenCodeModelList(VERBOSE_OUTPUT))).toEqual([
      { id: 'opencode/big-pickle', name: 'Big Pickle', tier: 'balanced', family: 'OpenCode Zen' },
      { id: 'xiaomi-token-plan-ams/mimo-v2.6-pro', name: 'MiMo-V2.6-Pro', tier: 'powerful', family: 'Xiaomi Token Plan (Europe)' },
      { id: 'xiaomi-token-plan-ams/mimo-v2.6-flash', name: 'MiMo-V2.6-Flash', tier: 'fast', family: 'Xiaomi Token Plan (Europe)' },
    ]);
  });
});

function fakeProcess(stdout: string, code: number): ChildProcess {
  const proc = new EventEmitter() as ChildProcess & EventEmitter;
  const out = new PassThrough();
  Object.assign(proc, { stdout: out, stderr: new PassThrough(), pid: undefined, kill: vi.fn() });
  setImmediate(() => {
    out.write(stdout);
    proc.emit('close', code);
  });
  return proc;
}

describe('discoverOpenCodeModels', () => {
  it('resolves the chat models', async () => {
    const models = await discoverOpenCodeModels(() => fakeProcess(VERBOSE_OUTPUT, 0));
    expect(models.map((model) => model.id)).toContain('xiaomi-token-plan-ams/mimo-v2.6-pro');
  });

  it('rejects when the CLI prints nothing usable', async () => {
    await expect(discoverOpenCodeModels(() => fakeProcess('Error: not signed in\n', 1))).rejects.toThrow(/empty or unparseable/);
  });
});

describe('OpenCodeCliDiscoveryService', () => {
  it('feeds discovered models into the catalog under the opencode provider', async () => {
    const catalog = { onCliDiscoveryRefreshed: vi.fn() };
    const models = [{ id: 'opencode/big-pickle', name: 'Big Pickle', tier: 'balanced' as const }];
    const service = new OpenCodeCliDiscoveryService({ catalog, lister: async () => models });
    await service.refreshOnce();
    expect(catalog.onCliDiscoveryRefreshed).toHaveBeenCalledWith('opencode', models);
  });

  it('keeps the existing catalog when the CLI is missing', async () => {
    const catalog = { onCliDiscoveryRefreshed: vi.fn() };
    const service = new OpenCodeCliDiscoveryService({
      catalog,
      lister: async () => {
        throw new Error('spawn opencode ENOENT');
      },
    });
    await expect(service.refreshOnce()).resolves.toBeUndefined();
    expect(catalog.onCliDiscoveryRefreshed).not.toHaveBeenCalled();
  });
});
