vi.mock('../cli/adapters/opencode-cli-launch', () => ({ selectOpenCodeLaunch: vi.fn(async () => ({ command: 'opencode', major: 1 })) }));
import { selectOpenCodeLaunch } from '../cli/adapters/opencode-cli-launch';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: mocks.warn, debug: vi.fn(), error: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  warn: vi.fn(),
  killGroup: vi.fn<(pid: number | undefined, signal: NodeJS.Signals) => boolean>(() => false),
}));

vi.mock('../cli/adapters/base-cli-process-utils', () => ({ killProcessGroup: mocks.killGroup }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mocks.spawn, default: { ...actual, spawn: mocks.spawn } };
});

import {
  _resetOpenCodeRegionModelMetadataForTesting,
  ensureOpenCodeRegionModelMetadata,
  getCachedOpenCodeRegionModelMetadata,
  putOpenCodeRegionModelMetadata,
  readOpenCodeRegionModelMetadata,
} from './opencode-region-model-metadata';
import { withOpenCodeProcessGate } from '../cli/adapters/opencode-process-gate';
import type { OpenCodeAccountRegion } from '../../shared/types/provider-account.types';

const VERBOSE = [
  'xiaomi-token-plan-ams/mimo-v2.6-pro',
  JSON.stringify({ id: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro', api: { npm: '@ai-sdk/openai-compatible', url: 'https://token-plan-ams.xiaomimimo.com/v1' } }),
].join('\n');

/** Fake `opencode models …` process that prints `output` and closes. */
function fakeLister(output: string, code: number | null = 0, delayMs = 20) {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4242,
    kill: vi.fn(),
  });
  setTimeout(() => {
    proc.stdout.write(output);
    proc.emit('close', code);
  }, delayMs);
  return proc;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(selectOpenCodeLaunch).mockReset().mockResolvedValue({ command: 'opencode', major: 1 });
  mocks.killGroup.mockReset().mockReturnValue(false);
  _resetOpenCodeRegionModelMetadataForTesting();
});

afterEach(() => {
  _resetOpenCodeRegionModelMetadataForTesting();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('ensureOpenCodeRegionModelMetadata', () => {
  it.each([
    'moon', undefined, null, '', { region: 'ams' }, ['ams'], true, 1,
    ' ams', 'AMS', 'ams & echo AIO_REGION_PLACEHOLDER &',
  ])('refuses invalid runtime regions before native metadata work or cache writes (%j)', async (invalid) => {
    const region = invalid as OpenCodeAccountRegion;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      expect(getCachedOpenCodeRegionModelMetadata(region)).toBeNull();
      expect(() => putOpenCodeRegionModelMetadata(region, [{ providerId: 'xiaomi-token-plan-moon', modelId: 'fixture-model', metadata: {} }]))
        .toThrow('Invalid OpenCode Token Plan region.');
      await expect(readOpenCodeRegionModelMetadata(region)).rejects.toThrow('Invalid OpenCode Token Plan region.');
      await ensureOpenCodeRegionModelMetadata([region]);
      expect(mocks.warn.mock.calls).toEqual([['Ignoring invalid OpenCode Token Plan region']]);
      expect(getCachedOpenCodeRegionModelMetadata(region)).toBeNull();
      expect(mocks.spawn).not.toHaveBeenCalled();
    } finally { Object.defineProperty(process, 'platform', platform); }
  });

  it.each(['ams', 'sgp', 'cn'] as const)('retains native metadata arguments and caching for valid %s regions', async (region) => {
    mocks.spawn.mockImplementation(() => fakeLister(VERBOSE.replaceAll('-ams', `-${region}`), 0, 5));
    await ensureOpenCodeRegionModelMetadata([region]);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.spawn).toHaveBeenCalledWith(expect.any(String), ['models', `xiaomi-token-plan-${region}`, '--verbose'], expect.any(Object));
    expect(getCachedOpenCodeRegionModelMetadata(region)).toHaveLength(1);
    await ensureOpenCodeRegionModelMetadata([region]);
    expect(mocks.spawn).toHaveBeenCalledOnce();
  });

  it('retains valid discovery cache writes and ignores unrelated model rows', () => {
    putOpenCodeRegionModelMetadata('ams', [
      { providerId: 'xiaomi-token-plan-ams', modelId: 'fixture-model', metadata: {} },
      { providerId: 'unrelated-provider', modelId: 'fixture-model', metadata: {} },
    ]);
    expect(getCachedOpenCodeRegionModelMetadata('ams')).toEqual([{ providerId: 'xiaomi-token-plan-ams', modelId: 'fixture-model', metadata: {} }]);
    expect(getCachedOpenCodeRegionModelMetadata('sgp')).toBeNull();
  });

  it('shares one gated read between concurrent cold callers and caches the result', async () => {
    mocks.spawn.mockImplementation(() => fakeLister(VERBOSE, 0, 30));
    await Promise.all([
      ensureOpenCodeRegionModelMetadata(['ams']),
      ensureOpenCodeRegionModelMetadata(['ams']),
    ]);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(getCachedOpenCodeRegionModelMetadata('ams')).toHaveLength(1);
    // A warm cache reads nothing further.
    await ensureOpenCodeRegionModelMetadata(['ams']);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed read and leaves no cache behind', async () => {
    mocks.spawn.mockImplementationOnce(() => fakeLister('Error: Provider not found', 1, 5));
    await ensureOpenCodeRegionModelMetadata(['ams']);
    expect(getCachedOpenCodeRegionModelMetadata('ams')).toBeNull();
    mocks.spawn.mockImplementationOnce(() => fakeLister(VERBOSE, 0, 5));
    await ensureOpenCodeRegionModelMetadata(['ams']);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(getCachedOpenCodeRegionModelMetadata('ams')).toHaveLength(1);
  });

  it('keeps the lock until a timed-out child closes, escalating and rejecting even valid partial output', async () => {
    vi.useFakeTimers();
    const proc = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), pid: 4242, kill: vi.fn(),
    });
    mocks.spawn.mockReturnValue(proc);
    let settled = false;
    const reading = readOpenCodeRegionModelMetadata('ams').then(
      () => { settled = true; return undefined; },
      (error: Error) => { settled = true; return error; },
    );
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(VERBOSE);
    let otherReader = false;
    const competing = withOpenCodeProcessGate(async () => { otherReader = true; });
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(settled).toBe(false);
      expect(otherReader).toBe(false);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
      expect(otherReader).toBe(false);
    } finally {
      proc.emit('close', 0);
      expect(await reading).toMatchObject({ message: expect.stringContaining('Timeout') });
      await competing;
    }
    expect(otherReader).toBe(true);
    expect(getCachedOpenCodeRegionModelMetadata('ams')).toBeNull();
    expect(proc.listenerCount('close')).toBe(0);
    expect(proc.listenerCount('error')).toBe(0);
    expect(proc.stdout.listenerCount('data')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for close after a live child error and retries without stale in-flight state', async () => {
    vi.useFakeTimers();
    const proc = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), pid: 4242, kill: vi.fn(),
    });
    mocks.spawn.mockReturnValueOnce(proc);
    let otherReader = false;
    const reading = ensureOpenCodeRegionModelMetadata(['ams']);
    await vi.advanceTimersByTimeAsync(0);
    const competing = withOpenCodeProcessGate(async () => { otherReader = true; });
    proc.emit('error', new Error('Synthetic live process error'));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(otherReader).toBe(false);
    } finally {
      proc.emit('close', 1);
      await reading;
      await competing;
    }
    expect(getCachedOpenCodeRegionModelMetadata('ams')).toBeNull();
    mocks.spawn.mockImplementationOnce(() => fakeLister(VERBOSE));
    const retry = ensureOpenCodeRegionModelMetadata(['ams']);
    await vi.advanceTimersByTimeAsync(100);
    await retry;
    expect(getCachedOpenCodeRegionModelMetadata('ams')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });


  it('drains stderr and tears down listeners and escalation after a failed output stream', async () => {
    vi.useFakeTimers();
    const proc = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), pid: 4242, kill: vi.fn(),
    });
    mocks.spawn.mockReturnValueOnce(proc);
    const reading = ensureOpenCodeRegionModelMetadata(['ams']);
    await vi.advanceTimersByTimeAsync(0);
    proc.stderr.write('Synthetic native diagnostic discarded');
    expect(proc.stderr.readableLength).toBe(0);
    proc.stdout.emit('error', new Error('Synthetic output stream failure'));
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    proc.emit('close', 1);
    await reading;
    expect(getCachedOpenCodeRegionModelMetadata('ams')).toBeNull();
    expect(proc.stderr.listenerCount('data')).toBe(0);
    expect(proc.stdout.listenerCount('error')).toBe(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for an owned real subprocess to exit before admitting the next reader', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const proc = actual.spawn(process.execPath, ['-e', [
      "process.on('SIGTERM', () => {});",
      "process.stdout.write('fixture-ready\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    await new Promise<void>((resolve, reject) => {
      proc.once('error', reject);
      proc.stdout!.once('data', () => resolve());
    });
    vi.useFakeTimers();
    mocks.spawn.mockReturnValueOnce(proc);
    const reading = readOpenCodeRegionModelMetadata('ams').then(() => undefined, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    let enteredAfterExit = false;
    const competing = withOpenCodeProcessGate(async () => {
      enteredAfterExit = proc.exitCode !== null || proc.signalCode !== null;
    });
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await reading).toMatchObject({ message: expect.stringContaining('Timeout') });
      await competing;
      expect(enteredAfterExit).toBe(true);
      expect(getCachedOpenCodeRegionModelMetadata('ams')).toBeNull();
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }
  });


  it('terminates an owned wrapper and its inherited-pipe descendant before releasing metadata startup protection', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const actualUtils = await vi.importActual<typeof import('../cli/adapters/base-cli-process-utils')>('../cli/adapters/base-cli-process-utils');
    mocks.killGroup.mockImplementation(actualUtils.killProcessGroup);
    const nativeTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    let proc!: import('node:child_process').ChildProcess;
    let descendantPid: number | undefined;
    let descendantReady = false;
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
    const descendantCode = "process.on('SIGTERM',()=>{}); process.stdout.write('descendant-ready\\n'); setInterval(()=>{},1000);";
    const wrapperCode = [
      "const {spawn}=require('node:child_process');",
      "process.on('SIGTERM',()=>{});",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:['ignore','inherit','inherit']});`,
      "process.stdout.write(JSON.stringify({childPid:child.pid})+'\\n');",
      'setInterval(()=>{},1000);',
    ].join('\n');
    mocks.spawn.mockImplementationOnce((_command, _args, options) => {
      proc = actual.spawn(process.execPath, ['-e', wrapperCode], { ...options, shell: false });
      let pending = '';
      proc.stdout!.on('data', (data: Buffer) => {
        pending += data.toString();
        let end: number;
        while ((end = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (line === 'descendant-ready') descendantReady = true;
          else { try { descendantPid = (JSON.parse(line) as { childPid: number }).childPid; } catch { /* fixture readiness only */ } }
          if (descendantReady && descendantPid !== undefined) ready();
        }
      });
      return proc;
    });
    vi.useFakeTimers();
    const reading = readOpenCodeRegionModelMetadata('ams').then(() => undefined, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    let competing!: Promise<void>;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([readyPromise, new Promise<never>((_resolve, reject) => {
        deadline = nativeTimeout(() => reject(new Error('Owned wrapper readiness timed out')), 1000);
      })]);
      nativeClearTimeout(deadline!);
      let closed = false;
      proc.once('close', () => { closed = true; });
      competing = withOpenCodeProcessGate(async () => { expect(closed).toBe(true); });
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await Promise.race([
        reading,
        new Promise<undefined>((resolve) => { deadline = nativeTimeout(() => resolve(undefined), 1000); }),
      ]);
      expect(result).toMatchObject({ message: expect.stringContaining('Timeout') });
      expect(closed).toBe(true);
      await competing;
    } finally {
      if (deadline) nativeClearTimeout(deadline);
      // These are exclusively the subprocesses created and identified by this fixture.
      if (proc.exitCode === null && proc.signalCode === null && !actualUtils.killProcessGroup(proc.pid, 'SIGKILL')) proc.kill('SIGKILL');
      if (descendantPid !== undefined) { try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already reaped */ } }
      await reading;
      await competing;
      mocks.killGroup.mockReset().mockReturnValue(false);
    }
  });


  it.each([1, null])('rejects a failed close (%s) even when stdout contains usable metadata', async (code) => {
    vi.useFakeTimers();
    mocks.spawn.mockImplementationOnce(() => fakeLister(VERBOSE, code));
    const reading = readOpenCodeRegionModelMetadata('ams').then(() => undefined, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await reading).toMatchObject({ message: expect.stringContaining('Failed') });
    expect(getCachedOpenCodeRegionModelMetadata('ams')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

});

it('reads region metadata from the selected version 2 standalone model operation', async () => {
  vi.stubEnv('OPENCODE_CONFIG_CONTENT', JSON.stringify({ providers: {
    'xiaomi-token-plan-ams': { activation: 'disabled', body: { temperature: 0.3 }, models: { 'fixture-model': { limit: { output: 123 }, body: { top_p: 0.8 } } } },
    'unrelated-provider': { activation: 'disabled' },
  }, customInstruction: 'preserve-inline-config' }));
  vi.mocked(selectOpenCodeLaunch).mockResolvedValueOnce({ command: '/fixture/opencode2', major: 2 });
  mocks.spawn.mockImplementationOnce(() => fakeLister(JSON.stringify({ data: [{ providerID: 'xiaomi-token-plan-ams', modelID: 'mimo-v2.6-pro',
    name: 'MiMo Pro', capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 1000000, output: 98304 } }] })));
  await readOpenCodeRegionModelMetadata('ams');
  expect(mocks.spawn).toHaveBeenCalledWith('/fixture/opencode2', ['api', '--standalone', 'GET', '/api/model'], expect.any(Object));
  const options = mocks.spawn.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
  expect(JSON.parse(options.env['OPENCODE_CONFIG_CONTENT']!)).toEqual({ providers: {
    'xiaomi-token-plan-ams': { activation: 'enabled', body: { temperature: 0.3 }, models: { 'fixture-model': { limit: { output: 123 }, body: { top_p: 0.8 } } } },
    'unrelated-provider': { activation: 'disabled' },
  }, customInstruction: 'preserve-inline-config' });
  expect(JSON.parse(process.env['OPENCODE_CONFIG_CONTENT']!)['providers']['xiaomi-token-plan-ams']['activation']).toBe('disabled');
  expect(getCachedOpenCodeRegionModelMetadata('ams')?.[0]?.metadata['limit']).toEqual({ context: 1000000, output: 98304 });
});

it('forwards the required major through cold region ensure/read/selection', async () => {
  vi.mocked(selectOpenCodeLaunch).mockRejectedValueOnce(new Error('This session requires OpenCode 2.'));
  await ensureOpenCodeRegionModelMetadata(['ams'], { requiredMajor: 2 });
  expect(vi.mocked(selectOpenCodeLaunch).mock.calls[0]?.[0].requiredMajor).toBe(2);
  expect(mocks.spawn).not.toHaveBeenCalled(); expect(getCachedOpenCodeRegionModelMetadata('ams')).toBeNull();
});

it('does not share an unrestricted pending region read with a major-constrained caller', async () => {
  vi.mocked(selectOpenCodeLaunch).mockResolvedValueOnce({ command: 'opencode', major: 1 })
    .mockRejectedValueOnce(new Error('This session requires OpenCode 2.'));
  mocks.spawn.mockImplementationOnce(() => fakeLister(VERBOSE, 0, 30));
  const unrestricted = readOpenCodeRegionModelMetadata('ams');
  const required = readOpenCodeRegionModelMetadata('ams', { requiredMajor: 2 });
  await expect(required).rejects.toThrow('requires OpenCode 2');
  await expect(unrestricted).resolves.toHaveLength(1);
  expect(selectOpenCodeLaunch).toHaveBeenCalledTimes(2);
  expect(vi.mocked(selectOpenCodeLaunch).mock.calls.at(-1)?.[0].requiredMajor).toBe(2);
  expect(mocks.spawn).toHaveBeenCalledOnce();
});
