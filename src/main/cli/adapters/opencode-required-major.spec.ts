import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodeAdapter } from './opencode-adapter-factory';
import type { UnifiedSpawnOptions } from './adapter-factory.types';
import { _resetOpenCodeRegionModelMetadataForTesting } from '../../providers/opencode-region-model-metadata';

const state = vi.hoisted(() => ({ capture: vi.fn(), lookup: vi.fn(), acquire: vi.fn(), lister: vi.fn(), candidates: [] as string[], major2: false }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawnSync: state.lookup, default: { ...actual, spawnSync: state.lookup } };
});
vi.mock('../cli-registry', async (original) => ({ ...await original<typeof import('../cli-registry')>(), getCliCandidatePaths: () => [] }));
vi.mock('./opencode-effective-budget-config', async (original) => ({ ...await original<typeof import('./opencode-effective-budget-config')>(), runOpenCodeCapture: state.capture }));
vi.mock('../provider-concurrency-limiter', () => ({ getProviderConcurrencyLimiter: () => ({ acquire: state.acquire }) }));
vi.mock('../../providers/opencode-model-lister-process', () => ({ captureOpenCodeModelList: state.lister }));
let root: string;
beforeEach(() => {
  vi.clearAllMocks(); state.major2 = false; root = mkdtempSync(join(tmpdir(), 'aio-required-major-'));
  _resetOpenCodeRegionModelMetadataForTesting();
  state.candidates = [join(root, 'opencode'), join(root, 'opencode2')];
  for (const candidate of state.candidates) writeFileSync(candidate, 'LOCAL_FAKE_CLI_PLACEHOLDER');
  state.lookup.mockImplementation((_command: string, args: string[]) => ({ status: 0, stdout: args.includes('opencode2') && state.major2 ? state.candidates[1] : args.includes('opencode') ? state.candidates[0] : '' }));
  state.capture.mockImplementation(async (params: { command: string; args: string[] }) => ({ code: 0,
    stdout: params.args[0] === '--version' ? (params.command === state.candidates[0] ? '1.19.1' : '2.0.30') : params.command === state.candidates[0] ? '{}' : '[]',
  }));
  state.acquire.mockRejectedValue(new Error('Unexpected provider slot acquisition.'));
  state.lister.mockRejectedValue(new Error('Unexpected native model listing.'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('actual selector at the OpenCode factory boundary', () => {
  it.each([
    { nodePlacement: { requiresOpenCodeMajor: 2 } },
    { forkSession: true, sessionId: 'LOCAL_NATIVE_PARENT_PLACEHOLDER' },
    { additionalDirectories: ['/tmp/placeholder-extra'] },
  ] satisfies Partial<UnifiedSpawnOptions>[])('refuses a major 1 config read for %j in readiness and startup', async (options) => {
    const adapter = createOpenCodeAdapter({ workingDirectory: root, ...options });
    expect(await adapter.checkStatus()).toMatchObject({ available: false, error: expect.stringContaining('requires OpenCode 2') });
    await expect(adapter.spawn()).rejects.toThrow('requires OpenCode 2');
    expect(state.capture.mock.calls.map(([params]) => params.args)).toEqual([['--version'], ['--version']]);
    expect(state.acquire).not.toHaveBeenCalled();
  });

  it.each([{ forkSession: true }, { additionalDirectories: ['/tmp/placeholder-extra'] }] satisfies Partial<UnifiedSpawnOptions>[])('refuses explicit major 1 plus native-v2 features before any command probe: %j', (options) => {
    expect(() => createOpenCodeAdapter({ workingDirectory: root, nodePlacement: { requiresOpenCodeMajor: 1 }, ...options })).toThrow(/require OpenCode 2/);
    expect(state.lookup).not.toHaveBeenCalled(); expect(state.capture).not.toHaveBeenCalled(); expect(state.acquire).not.toHaveBeenCalled();
  });

  it('keeps ordinary major 1 fallback available when no explicit or native-v2 requirement exists', async () => {
    const adapter = createOpenCodeAdapter({ workingDirectory: root });
    expect(await adapter.checkStatus()).toEqual({ available: true, path: state.candidates[0] });
    expect(state.capture.mock.calls.map(([params]) => params.args)).toEqual([['--version'], ['debug', 'config']]);
  });

  it('honors explicit major 1 even with a preferred supported major 2 install present', async () => {
    state.major2 = true;
    const adapter = createOpenCodeAdapter({ workingDirectory: root, nodePlacement: { requiresOpenCodeMajor: 1 } });
    expect(await adapter.checkStatus()).toEqual({ available: true, path: state.candidates[0] });
    expect(state.capture.mock.calls.map(([params]) => [params.command, params.args])).toEqual([
      [state.candidates[0], ['--version']], [state.candidates[1], ['--version']], [state.candidates[0], ['debug', 'config']],
    ]);
  });

  it('filters cold account metadata selection after an install changes during the concurrency wait', async () => {
    state.major2 = true;
    const release = vi.fn(); let afterWait = 0;
    state.acquire.mockImplementation(async () => { afterWait = state.capture.mock.calls.length; state.major2 = false; return release; });
    const adapter = createOpenCodeAdapter({ workingDirectory: root, nodePlacement: { requiresOpenCodeMajor: 2 },
      model: 'xiaomi-token-plan-ams/mimo-v2.6-flash', accountRoute: {
        provider: 'opencode', profileId: 'metadata-race-placeholder', source: 'default', executionNodeId: 'local', region: 'ams',
      } });
    await expect(adapter.spawn()).rejects.toThrow('requires OpenCode 2');
    expect(afterWait).toBe(3);
    expect(state.capture.mock.calls.slice(afterWait).map(([params]) => params.args)).toEqual([['--version'], ['--version']]);
    expect(state.lister).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
  });
});
