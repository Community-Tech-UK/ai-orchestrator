import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpCliAdapter } from './acp-cli-adapter';
import { createOpenCodeAdapter } from './opencode-adapter-factory';
import { createInitializedAgentHarness, type FakeAcpProcess } from './acp-cli-adapter.test-helpers';
import { normalizeOpenCodeNativeConfig } from './opencode-v2-config';
import { projectOpenCodeConfig } from './opencode-config-shapes';

const state = vi.hoisted(() => ({
  events: [] as string[], selectedConfigs: [] as string[], gateDepth: 0, command: '', major: 2, metadataReady: false,
  select: vi.fn(), probe: vi.fn(), acquire: vi.fn(), releaseSlot: vi.fn(), cleanup: vi.fn(), which: vi.fn(),
}));
vi.mock('child_process', async (original) => {
  const actual = await original<typeof import('child_process')>();
  return { ...actual, spawnSync: state.which, default: { ...actual, spawnSync: state.which } };
});
vi.mock('./opencode-cli-launch', () => ({ selectOpenCodeLaunch: state.select }));
vi.mock('./opencode-effective-budget-config', () => ({ readOpenCodeEffectiveBudgetConfig: state.probe }));
vi.mock('../provider-concurrency-limiter', () => ({ getProviderConcurrencyLimiter: () => ({ acquire: state.acquire }) }));
vi.mock('./opencode-child-progress-source', () => ({ createOpenCodeChildProgressSource: () => ({ source: {}, request: vi.fn(), prepareSpawn: () => state.cleanup }) }));
vi.mock('./opencode-process-gate', () => {
  const gate = async () => {
    state.events.push('gate-acquire'); state.gateDepth++;
    return () => { state.events.push('gate-release'); state.gateDepth--; };
  };
  return { openCodeProcessGate: gate, withOpenCodeProcessGate: async (run: () => Promise<unknown>) => {
    const release = await gate(); try { return await run(); } finally { release(); }
  } };
});
vi.mock('../../providers/opencode-region-model-metadata', () => ({
  ensureOpenCodeRegionModelMetadata: async () => { expect(state.gateDepth).toBe(0); state.events.push('metadata'); state.metadataReady = true; },
  getCachedOpenCodeRegionModelMetadata: () => state.metadataReady ? [{ providerId: 'xiaomi-token-plan-ams', modelId: 'mimo-v2.6-flash', metadata: {
    api: { npm: '@ai-sdk/openai-compatible', url: 'https://example.test/v1' }, limit: { context: 1000000, output: 32000 },
  } }] : null,
}));

let root: string;
const processes: FakeAcpProcess[] = [];
function captureSpawn(adapter: AcpCliAdapter) {
  const proc = createInitializedAgentHarness(); processes.push(proc);
  return vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess')
    .mockImplementation(() => { state.events.push('spawn'); return proc as unknown as ChildProcess; });
}
beforeEach(() => {
  vi.clearAllMocks(); state.events.length = 0; state.selectedConfigs.length = 0; state.gateDepth = 0; state.major = 2; state.metadataReady = false;
  root = mkdtempSync(join(tmpdir(), 'aio-opencode-startup-'));
  state.command = join(root, 'opencode2'); writeFileSync(state.command, 'LOCAL_SELECTED_COMMAND_PLACEHOLDER');
  state.which.mockReturnValue({ status: 1, stdout: '' });
  state.select.mockImplementation(async (params) => {
    state.selectedConfigs.push(params.env.OPENCODE_CONFIG_CONTENT);
    expect(state.gateDepth).toBe(1); state.events.push('select'); return { command: state.command, major: state.major };
  });
  state.probe.mockImplementation(async (params) => projectOpenCodeConfig(normalizeOpenCodeNativeConfig([{ type: 'document', info: JSON.parse(params.env.OPENCODE_CONFIG_CONTENT) }]), params.model));
  state.acquire.mockImplementation(async () => { state.events.push('slot-acquire'); return state.releaseSlot; });
});
afterEach(() => {
  for (const proc of processes.splice(0)) { proc.exit(); proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy(); }
  vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true });
});

describe('OpenCode selected-install availability', () => {
  it('uses the selected install for direct status, request initialization and actual factory startup', async () => {
    const adapter = createOpenCodeAdapter({ workingDirectory: root });
    adapter.configureHardenedMode({ writableRoots: [root] });
    const spawn = captureSpawn(adapter);
    expect(await adapter.checkStatus()).toEqual({ available: true, path: state.command });
    await adapter.initializeForRequest();
    await expect(adapter.spawn()).resolves.toBe(4242);
    expect(spawn).toHaveBeenCalledOnce();
    expect(state.which).not.toHaveBeenCalled();
    expect(adapter.getConfig().command).toBe(state.command);
    expect(state.select).toHaveBeenCalledTimes(4);
    for (const [params] of state.select.mock.calls) {
      expect(params).toMatchObject({ workingDirectory: root, writableRoots: [root] });
    }
    expect(state.events).toEqual(['gate-acquire', 'select', 'gate-release', 'gate-acquire', 'select', 'gate-release',
      'gate-acquire', 'select', 'gate-release', 'slot-acquire', 'gate-acquire', 'select', 'spawn', 'gate-release']);
    await adapter.terminate(false);
    expect(state.releaseSlot).toHaveBeenCalledOnce(); expect(state.cleanup).toHaveBeenCalledOnce(); expect(state.gateDepth).toBe(0);
  });

  it('reports missing or unusable selected installs without falling back to a bare-command availability assumption', async () => {
    state.select.mockRejectedValue(new Error('No supported OpenCode install.'));
    const adapter = createOpenCodeAdapter({ workingDirectory: root }); const spawn = captureSpawn(adapter);
    expect(await adapter.checkStatus()).toEqual({ available: false, error: 'No supported OpenCode install.' });
    await expect(adapter.initializeForRequest()).rejects.toThrow('No supported OpenCode install.');
    await expect(adapter.spawn()).rejects.toThrow('No supported OpenCode install.');
    expect(spawn).not.toHaveBeenCalled(); expect(state.which).not.toHaveBeenCalled(); expect(state.acquire).not.toHaveBeenCalled(); expect(state.gateDepth).toBe(0);
  });

  it('reselects after waiting for a slot and refuses a changed major while releasing gates and the slot', async () => {
    state.acquire.mockImplementation(async () => { state.events.push('slot-acquire'); state.major = 1; return state.releaseSlot; });
    const adapter = createOpenCodeAdapter({ workingDirectory: root, nodePlacement: { requiresOpenCodeMajor: 2 } }); const spawn = captureSpawn(adapter);
    await expect(adapter.spawn()).rejects.toThrow('requires OpenCode 2');
    expect(state.select).toHaveBeenCalledTimes(2); expect(state.probe).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
    expect(state.releaseSlot).toHaveBeenCalledOnce(); expect(state.gateDepth).toBe(0);
  });

  it('resolves a cold named-account preflight before region metadata, then builds its provider after metadata outside the startup gate', async () => {
    const adapter = createOpenCodeAdapter({ workingDirectory: root, model: 'xiaomi-token-plan-ams/mimo-v2.6-flash',
      accountRoute: { provider: 'opencode', profileId: 'startup-placeholder', source: 'default', executionNodeId: 'local', region: 'ams' } });
    const spawn = captureSpawn(adapter);
    // Stop after the real preparation has injected the routed provider and released every startup resource.
    spawn.mockImplementation(() => { throw new Error('SPAWN_CAPTURED_AFTER_PREPARATION'); });
    await expect(adapter.spawn()).rejects.toThrow('SPAWN_CAPTURED_AFTER_PREPARATION');
    expect(state.events.indexOf('metadata')).toBeGreaterThan(state.events.indexOf('select'));
    expect(state.select).toHaveBeenCalledTimes(2);
    expect(state.selectedConfigs[0]).not.toContain('aio-mimo-startup-placeholder');
    const finalProbe = state.probe.mock.calls.at(-1)![0];
    expect(JSON.parse(finalProbe.env.OPENCODE_CONFIG_CONTENT).providers).toHaveProperty('aio-mimo-startup-placeholder');
    expect(state.cleanup).toHaveBeenCalledOnce(); expect(state.releaseSlot).toHaveBeenCalledOnce(); expect(state.gateDepth).toBe(0);
  });

  it('checks the current spawn command rather than the immutable constructor command', async () => {
    const adapter = new AcpCliAdapter({ command: 'old-command', workingDirectory: root }); adapter.setSpawnCommand(state.command);
    expect(await adapter.checkStatus()).toEqual({ available: true, path: state.command }); expect(state.which).not.toHaveBeenCalled();
  });

  it.each(['ACP', 'copilot-acp', 'cursor-acp'])('preserves the early availability failure for ordinary %s adapters without acquiring resources', async (adapterName) => {
    const prepare = vi.fn();
    const adapter = new AcpCliAdapter({ adapterName, command: 'missing-placeholder-command', workingDirectory: root, prepareSpawn: prepare,
      concurrencyLimiter: { acquire: state.acquire }, concurrencyKey: 'placeholder' }); const spawn = captureSpawn(adapter);
    await expect(adapter.spawn()).rejects.toThrow('was not found on PATH');
    expect(state.which).toHaveBeenCalledOnce(); expect(state.select).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled(); expect(state.acquire).not.toHaveBeenCalled();
  });

  it.each(['ACP', 'copilot-acp', 'cursor-acp'])('preserves ordinary %s startup and resource cleanup without a dynamic resolver', async (adapterName) => {
    const prepare = vi.fn(() => state.cleanup);
    const adapter = new AcpCliAdapter({ adapterName, command: state.command, workingDirectory: root, prepareSpawn: prepare,
      concurrencyLimiter: { acquire: state.acquire }, concurrencyKey: 'placeholder' }); const spawn = captureSpawn(adapter);
    await expect(adapter.spawn()).resolves.toBe(4242);
    expect(prepare).toHaveBeenCalledOnce(); expect(spawn).toHaveBeenCalledOnce(); expect(state.select).not.toHaveBeenCalled();
    await adapter.terminate(false);
    expect(state.releaseSlot).toHaveBeenCalledOnce(); expect(state.cleanup).toHaveBeenCalledOnce();
  });
});
