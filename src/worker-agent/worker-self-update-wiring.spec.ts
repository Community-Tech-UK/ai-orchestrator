import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportCapabilities, setWorkerBuildStatusProvider } from './capability-reporter';
import { WorkerActivity } from './worker-activity';
import type { WorkerConfig } from './worker-config';
import { runWorkerSelfCheck, startWorkerSelfUpdate } from './worker-self-update-wiring';
import { WORKER_SUPERVISED_ENV } from './worker-self-update';

const COMMIT = 'd'.repeat(40);

describe('worker self-update wiring', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    setWorkerBuildStatusProvider(null);
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-self-update-'));
    tempDirs.push(dir);
    return dir;
  }

  function fakeBundle(): string {
    const dir = path.join(tempDir(), 'dist', 'worker-agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.js'), '');
    fs.writeFileSync(path.join(dir, '.source-commit'), `${COMMIT}\n`);
    return path.join(dir, 'index.js');
  }

  const config = { autoUpdate: undefined } as unknown as WorkerConfig;
  const agent = { activity: new WorkerActivity(() => 0) };

  it.each([
    ['service mode', { serviceMode: true, env: { [WORKER_SUPERVISED_ENV]: '1' } }, 'operating-system service'],
    ['no supervisor', { serviceMode: false, env: {} }, 'supervisor'],
  ])('stays off under %s and still reports the build commit', async (_label, change, reason) => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const updater = startWorkerSelfUpdate({
      agent,
      config,
      configPath: '/cfg.json',
      onRestart: async () => undefined,
      entrypoint: fakeBundle(),
      ...change,
    });

    expect(updater).toBeNull();
    const capabilities = await reportCapabilities([], 1);
    expect(capabilities.workerAgent).toMatchObject({
      buildCommit: COMMIT,
      autoUpdate: { state: 'disabled' },
    });
    expect(capabilities.workerAgent?.autoUpdate?.reason).toContain(reason);
  });

  it('starts under a supervisor in a buildable checkout, reports status, and restarts with exit 75', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const bundle = fakeBundle();
    const repo = path.resolve(path.dirname(bundle), '..', '..');
    fs.mkdirSync(path.join(repo, '.git'));
    fs.writeFileSync(path.join(repo, 'build-worker-agent.ts'), '');
    fs.mkdirSync(path.join(repo, 'node_modules', 'tsx', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '');
    const order: string[] = [];

    const updater = startWorkerSelfUpdate({
      agent,
      config,
      configPath: '/cfg.json',
      serviceMode: false,
      onRestart: async () => {
        order.push('shutdown');
      },
      entrypoint: bundle,
      env: { [WORKER_SUPERVISED_ENV]: '1' },
    });
    try {
      expect(updater).not.toBeNull();
      const capabilities = await reportCapabilities([], 1);
      expect(capabilities.workerAgent).toMatchObject({ buildCommit: COMMIT, autoUpdate: { state: 'idle' } });

      exit.mockImplementation(((code?: number) => {
        order.push(`exit ${code}`);
      }) as never);
      await (updater as unknown as { options: { restart: () => Promise<void> } }).options.restart();
      expect(order).toEqual(['shutdown', 'exit 75']);
    } finally {
      updater?.stop();
    }
  });

  async function startEnabled(onRestart: () => Promise<void>) {
    const bundle = fakeBundle();
    const repo = path.resolve(path.dirname(bundle), '..', '..');
    fs.mkdirSync(path.join(repo, '.git'));
    fs.writeFileSync(path.join(repo, 'build-worker-agent.ts'), '');
    fs.mkdirSync(path.join(repo, 'node_modules', 'tsx', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '');
    const updater = startWorkerSelfUpdate({
      agent,
      config,
      configPath: '/cfg.json',
      serviceMode: false,
      onRestart,
      entrypoint: bundle,
      env: { [WORKER_SUPERVISED_ENV]: '1' },
    });
    updater?.stop();
    return (updater as unknown as { options: { restart: () => Promise<void> } }).options.restart;
  }

  it('exits for the supervisor even when the clean shutdown throws', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const restart = await startEnabled(async () => {
      throw new Error('disconnect failed');
    });

    await restart();

    expect(exit).toHaveBeenCalledWith(75);
  });

  it('keeps the shutdown timeout referenced, so a hang cannot turn into a quiet exit 0', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const restart = await startEnabled(() => new Promise<void>(() => undefined));
    const timers: ReturnType<typeof setTimeout>[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const timer = realSetTimeout(fn, ms);
      timers.push(timer);
      return timer;
    }) as typeof setTimeout);

    void restart();

    expect(timers).toHaveLength(1);
    expect(timers[0]!.hasRef()).toBe(true);
    clearTimeout(timers[0]);
  });

  it('exits for the supervisor when the clean shutdown hangs', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const restart = await startEnabled(() => new Promise<void>(() => undefined));
    vi.useFakeTimers();
    try {
      const done = restart();
      await vi.advanceTimersByTimeAsync(30_000);
      await done;
      expect(exit).toHaveBeenCalledWith(75);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays off when the config opts out, even under a supervisor', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const updater = startWorkerSelfUpdate({
      agent,
      config: { autoUpdate: { enabled: false } } as unknown as WorkerConfig,
      configPath: '/cfg.json',
      serviceMode: false,
      onRestart: async () => undefined,
      entrypoint: fakeBundle(),
      env: { [WORKER_SUPERVISED_ENV]: '1' },
    });
    expect(updater).toBeNull();
  });

  describe('runWorkerSelfCheck', () => {
    it('passes for a readable config, including one with a byte-order mark', () => {
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const configPath = path.join(tempDir(), 'worker-node.json');
      fs.writeFileSync(configPath, '﻿{"nodeId":"n"}');
      expect(runWorkerSelfCheck(['--self-check', '--config', configPath])).toBe(0);
    });

    it('passes when there is no config file yet', () => {
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      expect(runWorkerSelfCheck(['--self-check', '--config', path.join(tempDir(), 'missing.json')])).toBe(0);
    });

    it('fails for a config the worker could not parse, without rewriting it', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const configPath = path.join(tempDir(), 'worker-node.json');
      fs.writeFileSync(configPath, '{ not json');
      expect(runWorkerSelfCheck(['--self-check', '--config', configPath])).toBe(1);
      expect(fs.readFileSync(configPath, 'utf8')).toBe('{ not json');
    });
  });
});
