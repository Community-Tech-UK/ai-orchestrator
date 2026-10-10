import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const lifecycle = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: lifecycle.spawn, default: { ...actual, spawn: lifecycle.spawn } };
});
vi.mock('../cli/adapters/base-cli-process-utils', () => ({ killProcessGroup: () => false }));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('./unified-model-catalog-service', () => ({
  getUnifiedModelCatalog: () => ({ onCliDiscoveryRefreshed: vi.fn() }),
}));

import {
  discoverOpenCodeModels,
  cacheOpenCodeRegionModelMetadata,
  OpenCodeCliDiscoveryService,
  parseOpenCodeModelList,
  toOpenCodeModelDisplayInfos,
} from './opencode-cli-discovery-service';
import { withOpenCodeProcessGate } from '../cli/adapters/opencode-process-gate';
import { _resetOpenCodeRegionModelMetadataForTesting, getCachedOpenCodeRegionModelMetadata } from './opencode-region-model-metadata';

afterEach(() => { vi.useRealTimers(); _resetOpenCodeRegionModelMetadataForTesting(); vi.clearAllMocks(); });

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

  it('filters the per-account aio-mimo aliases (each model shows once)', () => {
    const withAliases = parseOpenCodeModelList([
      block('xiaomi-token-plan-ams/mimo-v2.6-pro', 'MiMo-V2.6-Pro', true, { text: true, audio: false }),
      block('aio-mimo-max-b-1a2b/mimo-v2.6-pro', 'MiMo B', true, { text: true, audio: false }),
    ].join('\n'));
    const ids = toOpenCodeModelDisplayInfos(withAliases).map((info) => info.id);
    expect(ids).toEqual(['xiaomi-token-plan-ams/mimo-v2.6-pro']);
  });
});

function fakeProcess(stdout: string, code: number | null): ChildProcess {
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

  it('hands the raw metadata blocks to the region cache sink', async () => {
    const seen: Array<[string, string]> = [];
    await discoverOpenCodeModels(() => fakeProcess(VERBOSE_OUTPUT, 0), (blocks) => {
      seen.push(...blocks.map((block) => [block.providerId, block.modelId] as [string, string]));
    });
    expect(seen).toEqual([
      ['opencode', 'big-pickle'],
      ['xiaomi-token-plan-ams', 'mimo-v2-tts'],
      ['xiaomi-token-plan-ams', 'mimo-v2.6-pro'],
      ['xiaomi-token-plan-ams', 'mimo-v2.6-flash'],
    ]);
  });

  it('rejects when the CLI exits successfully but prints nothing usable', async () => {
    await expect(discoverOpenCodeModels(() => fakeProcess('Synthetic unparseable model output\n', 0))).rejects.toThrow(/empty or unparseable/);
  });
});

describe('OpenCode discovery subprocess cleanup', () => {
  it('protects the default discovery path through delayed timeout close and never caches partial metadata', async () => {
    vi.useFakeTimers();
    _resetOpenCodeRegionModelMetadataForTesting();
    const proc = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), pid: 4242, kill: vi.fn(),
    });
    lifecycle.spawn.mockReturnValueOnce(proc);
    const catalog = { onCliDiscoveryRefreshed: vi.fn() };
    const service = new OpenCodeCliDiscoveryService({ catalog });
    const reading = service.refreshOnce();
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(VERBOSE_OUTPUT);
    let otherReader = false;
    const competing = withOpenCodeProcessGate(async () => { otherReader = true; });
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(otherReader).toBe(false);
      expect(catalog.onCliDiscoveryRefreshed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      proc.emit('close', 0);
      await reading;
      await competing;
    }
    expect(otherReader).toBe(true);
    expect(getCachedOpenCodeRegionModelMetadata('ams')).toBeNull();
    expect(catalog.onCliDiscoveryRefreshed).not.toHaveBeenCalled();
    expect(proc.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1, null])('keeps catalog and region cache unchanged after a failed close (%s) with partial valid output', async (code) => {
    _resetOpenCodeRegionModelMetadataForTesting();
    lifecycle.spawn.mockImplementationOnce(() => fakeProcess(VERBOSE_OUTPUT, code));
    const catalog = { onCliDiscoveryRefreshed: vi.fn() };
    await new OpenCodeCliDiscoveryService({ catalog }).refreshOnce();
    expect(catalog.onCliDiscoveryRefreshed).not.toHaveBeenCalled();
    expect(getCachedOpenCodeRegionModelMetadata('ams')).toBeNull();
  });

  it('does not call the metadata sink when a live error precedes valid output and close', async () => {
    vi.useFakeTimers();
    _resetOpenCodeRegionModelMetadataForTesting();
    const proc = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), pid: 4242, kill: vi.fn(),
    });
    const metadata = vi.fn(cacheOpenCodeRegionModelMetadata);
    const reading = discoverOpenCodeModels(() => proc as unknown as ChildProcess, metadata)
      .then(() => undefined, (error: Error) => error);
    proc.emit('error', new Error('Synthetic live discovery failure'));
    proc.stdout.write(VERBOSE_OUTPUT);
    proc.emit('close', 0);
    expect(await reading).toBeInstanceOf(Error);
    expect(metadata).not.toHaveBeenCalled();
    expect(getCachedOpenCodeRegionModelMetadata('ams')).toBeNull();
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
