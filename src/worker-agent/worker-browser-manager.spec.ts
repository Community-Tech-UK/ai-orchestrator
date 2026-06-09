import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerBrowserManager } from './worker-browser-manager';
import type { WorkerBrowserAutomationConfig } from './worker-config';

/** Minimal stand-in for a Chrome ChildProcess. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  kill = vi.fn((): boolean => {
    this.killed = true;
    this.exitCode = 0;
    this.emit('exit', 0, null);
    return true;
  });

  /** Simulate Chrome dying without being asked to. */
  die(code: number): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

// Each test gets a real throwaway profile dir, so the manager's mkdir/rm/read of
// DevToolsActivePort hit a harmless temp location (Chrome itself is always faked).
let tempProfile: string;

function makeManager(
  overrides: Partial<{
    config: Partial<WorkerBrowserAutomationConfig>;
    child: FakeChild;
    chromePath: string | null;
    probe: (url: string) => Promise<boolean>;
    spawnImpl: (cmd: string, args: string[]) => FakeChild;
    readyTimeoutMs: number;
  }> = {},
): { manager: WorkerBrowserManager; child: FakeChild; spawnProcess: ReturnType<typeof vi.fn>; profileDir: string } {
  const child = overrides.child ?? new FakeChild();
  const spawnImpl = overrides.spawnImpl ?? (() => child);
  const spawnProcess = vi.fn(spawnImpl);
  const config: WorkerBrowserAutomationConfig = {
    enabled: true,
    profileDir: tempProfile,
    remoteDebuggingPort: 9333,
    ...overrides.config,
  };
  const manager = new WorkerBrowserManager({
    config,
    resolveChromePath: () => (overrides.chromePath === undefined ? '/fake/chrome' : overrides.chromePath),
    spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawn,
    probe: overrides.probe ?? (async () => true),
    readyTimeoutMs: overrides.readyTimeoutMs ?? 2_000,
  });
  return { manager, child, spawnProcess, profileDir: config.profileDir ?? tempProfile };
}

describe('WorkerBrowserManager', () => {
  beforeEach(() => {
    tempProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-bm-'));
  });

  afterEach(() => {
    fs.rmSync(tempProfile, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('rejects ensureRunning when automation is disabled', async () => {
    const { manager } = makeManager({ config: { enabled: false } });
    expect(manager.isEnabled()).toBe(false);
    await expect(manager.ensureRunning()).rejects.toThrow(/not enabled/);
  });

  it('launches Chrome once and returns the CDP base URL (fixed port)', async () => {
    const { manager, spawnProcess, profileDir } = makeManager();
    const url = await manager.ensureRunning();
    expect(url).toBe('http://127.0.0.1:9333');
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnProcess.mock.calls[0];
    expect(cmd).toBe('/fake/chrome');
    expect(args).toContain('--remote-debugging-port=9333');
    expect(args).toContain(`--user-data-dir=${profileDir}`);
    expect(args).toContain('--remote-allow-origins=*');
    expect(args).toContain('about:blank');
    expect(args).not.toContain('--headless=new');
    expect(fs.existsSync(profileDir)).toBe(true);
  });

  it('passes --headless=new when configured', async () => {
    const { manager, spawnProcess } = makeManager({
      config: { remoteDebuggingPort: 9001, headless: true },
    });
    await manager.ensureRunning();
    expect(spawnProcess.mock.calls[0][1]).toContain('--headless=new');
  });

  it('reuses the running Chrome on subsequent calls (no relaunch)', async () => {
    const { manager, spawnProcess } = makeManager();
    const first = await manager.ensureRunning();
    const second = await manager.ensureRunning();
    expect(first).toBe(second);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(manager.getBrowserUrl()).toBe(first);
  });

  it('coalesces concurrent ensureRunning calls into a single launch', async () => {
    const { manager, spawnProcess } = makeManager();
    const [a, b, c] = await Promise.all([
      manager.ensureRunning(),
      manager.ensureRunning(),
      manager.ensureRunning(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it('rejects and allows retry when no Chrome executable is found', async () => {
    const { manager, spawnProcess } = makeManager({ chromePath: null });
    await expect(manager.ensureRunning()).rejects.toThrow(/No Chrome/);
    expect(spawnProcess).not.toHaveBeenCalled();
    // A failed launch must clear the in-flight promise so a later call retries.
    await expect(manager.ensureRunning()).rejects.toThrow(/No Chrome/);
  });

  it('rejects when the CDP endpoint never becomes ready', async () => {
    const { manager } = makeManager({ probe: async () => false, readyTimeoutMs: 0 });
    await expect(manager.ensureRunning()).rejects.toThrow(/did not become ready/);
  });

  it('detects Chrome exiting during readiness wait', async () => {
    const child = new FakeChild();
    const probe = vi.fn(async () => {
      child.die(1);
      return false;
    });
    const { manager } = makeManager({ child, probe, readyTimeoutMs: 5_000 });
    await expect(manager.ensureRunning()).rejects.toThrow(/exited before becoming ready \(code 1\)/);
  });

  it('reads the chosen port from DevToolsActivePort when port is ephemeral (0)', async () => {
    const child = new FakeChild();
    const { manager } = makeManager({
      config: { remoteDebuggingPort: undefined }, // → 0
      child,
      // Simulate Chrome writing its DevToolsActivePort file on spawn.
      spawnImpl: (_cmd, args) => {
        expect(args).toContain('--remote-debugging-port=0');
        fs.writeFileSync(
          path.join(tempProfile, 'DevToolsActivePort'),
          '45678\n/devtools/browser/abc-123\n',
        );
        return child;
      },
    });
    const url = await manager.ensureRunning();
    expect(url).toBe('http://127.0.0.1:45678');
  });

  it('shutdown kills Chrome and a later ensureRunning relaunches', async () => {
    const { manager, child, spawnProcess } = makeManager();
    await manager.ensureRunning();
    await manager.shutdown();
    expect(child.kill).toHaveBeenCalled();
    expect(manager.getBrowserUrl()).toBeNull();

    // Relaunch uses a fresh child.
    const child2 = new FakeChild();
    spawnProcess.mockReturnValue(child2);
    const url = await manager.ensureRunning();
    expect(url).toBe('http://127.0.0.1:9333');
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it('clears state when Chrome exits on its own', async () => {
    const { manager, child } = makeManager();
    await manager.ensureRunning();
    expect(manager.getBrowserUrl()).not.toBeNull();
    child.die(0);
    expect(manager.getBrowserUrl()).toBeNull();
  });

  it('shutdown is a no-op when nothing is running', async () => {
    const { manager, child } = makeManager();
    await expect(manager.shutdown()).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('getSummary reflects config (enabled/headless/profileDir)', () => {
    const { manager } = makeManager({
      config: { enabled: true, profileDir: tempProfile, headless: true, remoteDebuggingPort: 9333 },
    });
    expect(manager.getSummary()).toEqual({
      enabled: true,
      headless: true,
      profileDir: tempProfile,
      running: false,
    });
  });

  it('getSummary reports running:true after Chrome is up', async () => {
    const { manager } = makeManager();
    await manager.ensureRunning();
    expect(manager.getSummary().running).toBe(true);
    await manager.shutdown();
    expect(manager.getSummary().running).toBe(false);
  });

  it('reconfigure to disabled shuts down a running Chrome', async () => {
    const { manager, child } = makeManager();
    await manager.ensureRunning();
    await manager.reconfigure({ enabled: false });
    expect(child.kill).toHaveBeenCalled();
    expect(manager.isEnabled()).toBe(false);
    expect(manager.getBrowserUrl()).toBeNull();
  });

  it('reconfigure with a changed profileDir shuts down so the next spawn relaunches', async () => {
    const { manager, child } = makeManager();
    await manager.ensureRunning();
    await manager.reconfigure({ enabled: true, profileDir: '/different/profile', remoteDebuggingPort: 9333 });
    expect(child.kill).toHaveBeenCalled();
    expect(manager.getBrowserUrl()).toBeNull();
  });

  it('reconfigure with no launch-relevant change keeps Chrome running', async () => {
    const { manager, child } = makeManager();
    await manager.ensureRunning();
    // Same profileDir/port/headless/chromePath — only re-affirming enabled.
    await manager.reconfigure({ enabled: true, profileDir: tempProfile, remoteDebuggingPort: 9333 });
    expect(child.kill).not.toHaveBeenCalled();
    expect(manager.getBrowserUrl()).toBe('http://127.0.0.1:9333');
  });
});
