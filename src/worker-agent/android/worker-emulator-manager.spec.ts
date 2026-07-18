import { EventEmitter } from 'node:events';
import type { ChildProcess, execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WorkerEmulatorManager } from './worker-emulator-manager';
import type { WorkerAndroidAutomationConfig } from '../worker-config';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  kill = vi.fn(() => {
    this.exitCode = 0;
    this.emit('exit', 0, null);
    return true;
  });
}

const baseConfig: WorkerAndroidAutomationConfig = {
  enabled: true,
  sdkPath: '/android/sdk',
  defaultAvd: 'aio-pixel7-api35',
  headlessEmulator: true,
  maxEmulators: 1,
  bootTimeoutMs: 10_000,
  allowPhysicalDevices: true,
  injectMaestroMcp: false,
  appiumMcp: false,
};

function sdkToolPath(...segments: string[]): string {
  return path.join(baseConfig.sdkPath!, ...segments);
}

function adbPath(): string {
  return sdkToolPath('platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
}

function emulatorPath(): string {
  return sdkToolPath('emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator');
}

function makeManager(config: WorkerAndroidAutomationConfig = baseConfig): {
  manager: WorkerEmulatorManager;
  children: FakeChild[];
  spawnProcess: ReturnType<typeof vi.fn>;
  execFileProcess: ReturnType<typeof vi.fn>;
} {
  const children: FakeChild[] = [];
  const spawnProcess = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  });
  const execFileProcess = vi.fn((command, args, options, callback) => {
    void command;
    void options;
    const output = (args as string[]).includes('getprop') ? '1\n' : '';
    queueMicrotask(() => callback(null, output, ''));
    return new FakeChild() as unknown as ChildProcess;
  });

  return {
    manager: new WorkerEmulatorManager({
      config,
      spawnProcess: spawnProcess as unknown as typeof spawn,
      execFileProcess: execFileProcess as unknown as typeof execFile,
      statePath: path.join(os.tmpdir(), `aio-emulator-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
      canListenPort: async () => true,
    }),
    children,
    spawnProcess,
    execFileProcess,
  };
}

describe('WorkerEmulatorManager', () => {
  it('launches a headless SDK emulator and reuses the running serial', async () => {
    const { manager, spawnProcess, execFileProcess } = makeManager();

    const first = await manager.ensureRunning();
    const second = await manager.ensureRunning();

    expect(first).toEqual(second);
    expect(first.serial).toMatch(/^emulator-\d+$/);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    const [command, args] = spawnProcess.mock.calls[0] as [string, string[]];
    expect(command).toBe(emulatorPath());
    expect(args).toEqual(expect.arrayContaining([
      '-avd',
      'aio-pixel7-api35',
      '-no-window',
      '-no-audio',
      '-no-boot-anim',
    ]));
    expect(execFileProcess).toHaveBeenCalledWith(
      adbPath(),
      expect.arrayContaining(['wait-for-device']),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('returns a warm emulator when max emulator capacity is already used', async () => {
    const { manager, spawnProcess } = makeManager();

    const first = await manager.ensureRunning('first-avd');
    const second = await manager.ensureRunning('second-avd');

    expect(second).toEqual(first);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it('can launch another instance of the same AVD when the existing serial is excluded', async () => {
    const { manager, spawnProcess } = makeManager({ ...baseConfig, maxEmulators: 2 });

    const first = await manager.ensureRunning('aio-pixel7-api35');
    const second = await manager.ensureRunning('aio-pixel7-api35', new Set([first.serial]));

    expect(second.serial).not.toBe(first.serial);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(spawnProcess.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['-port', '5554']));
    expect(spawnProcess.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(['-port', '5556']));
  });

  it('skips an emulator console port when the paired adb port is unavailable', async () => {
    const children: FakeChild[] = [];
    const spawnProcess = vi.fn<(...args: unknown[]) => ChildProcess>(() => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    });
    const execFileProcess = vi.fn((command, args, options, callback) => {
      void command;
      void options;
      const output = (args as string[]).includes('getprop') ? '1\n' : '';
      queueMicrotask(() => callback(null, output, ''));
      return new FakeChild() as unknown as ChildProcess;
    });
    const manager = new WorkerEmulatorManager({
      config: baseConfig,
      spawnProcess: spawnProcess as unknown as typeof spawn,
      execFileProcess: execFileProcess as unknown as typeof execFile,
      canListenPort: async (port: number) => port !== 5555,
    });

    await manager.ensureRunning();

    expect(spawnProcess.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['-port', '5556']));
  });

  it('uses the reconfigured boot timeout for later launches', async () => {
    const { manager, execFileProcess } = makeManager({ ...baseConfig, bootTimeoutMs: 10_000 });

    await manager.reconfigure({ ...baseConfig, bootTimeoutMs: 25_000 });
    await manager.ensureRunning();

    expect(execFileProcess).toHaveBeenCalledWith(
      adbPath(),
      expect.arrayContaining(['wait-for-device']),
      expect.objectContaining({ timeout: 25_000 }),
      expect.any(Function),
    );
  });

  it('charges wait-for-device time against the total boot timeout budget', async () => {
    const timeouts: number[] = [];
    let now = 0;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { manager, execFileProcess } = makeManager({ ...baseConfig, bootTimeoutMs: 10_000 });
    execFileProcess.mockImplementation((command, args, options, callback) => {
      void command;
      const adbArgs = args as string[];
      timeouts.push((options as { timeout: number }).timeout);
      if (adbArgs.includes('wait-for-device')) {
        now = 9_250;
      }
      const output = adbArgs.includes('getprop') ? '1\n' : '';
      callback(null, output, '');
      return new FakeChild() as unknown as ChildProcess;
    });

    try {
      await manager.ensureRunning();
    } finally {
      dateNow.mockRestore();
    }

    expect(timeouts).toHaveLength(2);
    expect(timeouts[0]).toBe(10_000);
    expect(timeouts[1]).toBeGreaterThan(0);
    expect(timeouts[1]).toBeLessThanOrEqual(750);
  });

  it('shuts down running emulators when launch-relevant config changes', async () => {
    const { manager, children } = makeManager();

    await manager.ensureRunning();
    await manager.reconfigure({ ...baseConfig, defaultAvd: 'other-avd' });

    expect(children[0]?.kill).toHaveBeenCalledTimes(1);
    expect(manager.getRunningSerials()).toEqual([]);
  });

  it('retries a failed emulator boot with cold boot snapshots disabled', async () => {
    const children: FakeChild[] = [];
    const spawnProcess = vi.fn<(...args: unknown[]) => ChildProcess>(() => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    });
    let waitForDeviceCalls = 0;
    const execFileProcess = vi.fn((command, args, options, callback) => {
      void command;
      void options;
      const adbArgs = args as string[];
      if (adbArgs.includes('wait-for-device')) {
        waitForDeviceCalls += 1;
        queueMicrotask(() => {
          if (waitForDeviceCalls === 1) {
            callback(new Error('boot failed'), '', '');
            return;
          }
          callback(null, '', '');
        });
        return new FakeChild() as unknown as ChildProcess;
      }
      queueMicrotask(() => callback(null, '1\n', ''));
      return new FakeChild() as unknown as ChildProcess;
    });
    const manager = new WorkerEmulatorManager({
      config: baseConfig,
      spawnProcess: spawnProcess as unknown as typeof spawn,
      execFileProcess: execFileProcess as unknown as typeof execFile,
      statePath: path.join(os.tmpdir(), `aio-emulator-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
      canListenPort: async () => true,
    });

    await expect(manager.ensureRunning()).resolves.toMatchObject({ serial: 'emulator-5554' });

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(spawnProcess.mock.calls[0]?.[1]).not.toContain('-no-snapshot-load');
    expect(spawnProcess.mock.calls[1]?.[1]).toContain('-no-snapshot-load');
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);
  });

  it('never passes -wipe-data on launch or cold-boot retry (protects emulator data)', async () => {
    const children: FakeChild[] = [];
    const spawnProcess = vi.fn<(...args: unknown[]) => ChildProcess>(() => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    });
    let waitForDeviceCalls = 0;
    const execFileProcess = vi.fn((command, args, options, callback) => {
      void command;
      void options;
      const adbArgs = args as string[];
      if (adbArgs.includes('wait-for-device')) {
        waitForDeviceCalls += 1;
        queueMicrotask(() => {
          // Fail the first boot to force the cold-boot retry path.
          callback(waitForDeviceCalls === 1 ? new Error('boot failed') : null, '', '');
        });
        return new FakeChild() as unknown as ChildProcess;
      }
      queueMicrotask(() => callback(null, '1\n', ''));
      return new FakeChild() as unknown as ChildProcess;
    });
    const manager = new WorkerEmulatorManager({
      config: baseConfig,
      spawnProcess: spawnProcess as unknown as typeof spawn,
      execFileProcess: execFileProcess as unknown as typeof execFile,
      statePath: path.join(os.tmpdir(), `aio-emulator-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
      canListenPort: async () => true,
    });

    await manager.ensureRunning();

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    for (const call of spawnProcess.mock.calls) {
      expect(call?.[1]).not.toContain('-wipe-data');
    }
  });

  it('suffixes adb.exe / emulator.exe when running on win32', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      const { manager, spawnProcess, execFileProcess } = makeManager();

      await manager.ensureRunning();

      const [emulatorCommand] = spawnProcess.mock.calls[0] as [string, string[]];
      expect(emulatorCommand.endsWith(`emulator${path.sep}emulator.exe`)).toBe(true);
      expect(execFileProcess).toHaveBeenCalledWith(
        expect.stringContaining('adb.exe'),
        expect.arrayContaining(['wait-for-device']),
        expect.any(Object),
        expect.any(Function),
      );
    } finally {
      platform.mockRestore();
    }
  });

  it('cleans up only persisted owned emulator processes on startup', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-emulator-state-'));
    const statePath = path.join(tempDir, 'emulators.json');
    await fs.writeFile(
      statePath,
      JSON.stringify({
        entries: [
          { avd: 'owned-avd', port: 5554, serial: 'emulator-5554', pid: 42 },
          { avd: 'operator-avd', port: 5556, serial: 'emulator-5556', pid: 84 },
        ],
      }),
      'utf-8',
    );

    const killProcess = vi.fn(() => true);
    const manager = new WorkerEmulatorManager({
      config: baseConfig,
      statePath,
      killProcess,
      readProcessCommandLine: vi.fn(async (pid) =>
        pid === 42
          ? '/android/sdk/emulator/emulator -avd owned-avd -port 5554 -no-window'
          : '/Applications/Android Studio.app/emulator -avd operator-avd -port 5560',
      ),
    });

    await manager.cleanupOwnedOrphans();

    expect(killProcess).toHaveBeenCalledWith(42);
    expect(killProcess).not.toHaveBeenCalledWith(84);
    await expect(fs.readFile(statePath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('does not treat an AVD name substring as ownership during orphan cleanup', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-emulator-state-'));
    const statePath = path.join(tempDir, 'emulators.json');
    await fs.writeFile(
      statePath,
      JSON.stringify({
        entries: [
          { avd: 'pixel', port: 5554, serial: 'emulator-5554', pid: 42 },
        ],
      }),
      'utf-8',
    );

    const killProcess = vi.fn(() => true);
    const manager = new WorkerEmulatorManager({
      config: baseConfig,
      statePath,
      killProcess,
      readProcessCommandLine: vi.fn(async () =>
        '/android/sdk/emulator/emulator -avd my-pixel -port 5554 -no-window'
      ),
    });

    await manager.cleanupOwnedOrphans();

    expect(killProcess).not.toHaveBeenCalled();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('preserves owned emulator state when orphan cleanup cannot kill the process', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-emulator-state-'));
    const statePath = path.join(tempDir, 'emulators.json');
    const entry = { avd: 'owned-avd', port: 5554, serial: 'emulator-5554', pid: 42 };
    await fs.writeFile(
      statePath,
      JSON.stringify({ entries: [entry] }),
      'utf-8',
    );

    const manager = new WorkerEmulatorManager({
      config: baseConfig,
      statePath,
      killProcess: vi.fn(() => {
        throw new Error('access denied');
      }),
      readProcessCommandLine: vi.fn(async () =>
        '/android/sdk/emulator/emulator -avd owned-avd -port 5554 -no-window'
      ),
    });

    await manager.cleanupOwnedOrphans();

    const persisted = JSON.parse(await fs.readFile(statePath, 'utf-8')) as {
      entries: Array<typeof entry>;
    };
    expect(persisted.entries).toEqual([entry]);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('preserves ownership records added while orphan cleanup is running', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-emulator-state-'));
    const statePath = path.join(tempDir, 'emulators.json');
    const staleEntry = { avd: 'old-avd', port: 5554, serial: 'emulator-5554', pid: 42 };
    const newEntry = { avd: 'new-avd', port: 5556, serial: 'emulator-5556', pid: 84 };
    await fs.writeFile(
      statePath,
      JSON.stringify({ entries: [staleEntry] }),
      'utf-8',
    );

    const manager = new WorkerEmulatorManager({
      config: baseConfig,
      statePath,
      killProcess: vi.fn(() => true),
      readProcessCommandLine: vi.fn(async () => {
        await fs.writeFile(
          statePath,
          JSON.stringify({ entries: [staleEntry, newEntry] }),
          'utf-8',
        );
        return '/android/sdk/emulator/emulator -avd old-avd -port 5554 -no-window';
      }),
    });

    await manager.cleanupOwnedOrphans();

    const persisted = JSON.parse(await fs.readFile(statePath, 'utf-8')) as {
      entries: Array<typeof staleEntry>;
    };
    expect(persisted.entries).toEqual([newEntry]);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

});
