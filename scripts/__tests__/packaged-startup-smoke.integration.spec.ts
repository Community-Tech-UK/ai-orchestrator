import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { isProcessAlive, runPackagedStartupSmoke } = require('../packaged-startup-smoke.js') as {
  isProcessAlive: (pid: number) => boolean;
  runPackagedStartupSmoke: (options: {
    root: string;
    platform: string;
    tempRoot: string;
    startupTimeoutMs?: number;
    exitTimeoutMs?: number;
    terminateGraceMs?: number;
  }) => Promise<void>;
};

/**
 * App behaviours, run as a DETACHED process that the fake bootstrap starts and
 * then abandons by exiting 0 — the same shape as the real heap-flag relaunch,
 * where the smoke's own child handle never sees the real app.
 */
const APP_BEHAVIOURS = {
  healthy: `
    fs.writeFileSync(path.join(dir, 'startup-smoke-pid'), process.pid + '\\n');
    setTimeout(() => {
      fs.writeFileSync(path.join(dir, 'startup-smoke-ready'), 'Harness initialized\\n');
      setTimeout(() => process.exit(0), 300);
    }, 300);`,
  diesBeforeReady: `
    fs.writeFileSync(path.join(dir, 'startup-smoke-pid'), process.pid + '\\n');
    setTimeout(() => process.exit(1), 300);`,
  // A wedged main thread: SIGTERM is never acted on, as with the SIGTRAP spin.
  ignoresSigterm: `
    process.on('SIGTERM', () => undefined);
    fs.writeFileSync(path.join(dir, 'startup-smoke-pid'), process.pid + '\\n');
    setInterval(() => undefined, 1000);`,
} as const;

// Generous against a loaded CI runner; the fail-fast assertion stays far below it.
const STARTUP_TIMEOUT_MS = 10_000;
const FAIL_FAST_BOUND_MS = 5_000;
const TEST_TIMEOUT_MS = 30_000;

function writeFakePackagedApp(root: string, behaviour: keyof typeof APP_BEHAVIOURS): void {
  const macOsDir = join(root, 'release', 'mac-arm64', 'Harness.app', 'Contents', 'MacOS');
  mkdirSync(macOsDir, { recursive: true });
  const appSource = `const fs = require('node:fs'); const path = require('node:path');
    const dir = process.env.AIO_STARTUP_SMOKE_USER_DATA_PATH;${APP_BEHAVIOURS[behaviour]}`;
  const bootstrapScript = join(root, 'fake-bootstrap.js');
  writeFileSync(bootstrapScript, `const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', ${JSON.stringify(appSource)}], { detached: true, stdio: 'ignore' }).unref();
process.exit(0);
`);
  // A sh wrapper rather than a node shebang: shebangs break on paths with
  // spaces or over the kernel's length limit.
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const executable = join(macOsDir, 'Harness');
  writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(bootstrapScript)}\n`);
  chmodSync(executable, 0o755);
}

describe.skipIf(process.platform === 'win32')('packaged startup smoke against a relaunching app', () => {
  let workDir: string;
  let tempRoot: string;
  const profiles = () => readdirSync(tempRoot).filter((name) => name.startsWith('harness-startup-smoke-'));
  const keptAppPids = () => profiles().flatMap((profile) => {
    const marker = join(tempRoot, profile, 'startup-smoke-pid');
    return existsSync(marker) ? [Number(readFileSync(marker, 'utf8'))] : [];
  });
  const run = (behaviour: keyof typeof APP_BEHAVIOURS) => {
    writeFakePackagedApp(workDir, behaviour);
    return runPackagedStartupSmoke({
      root: workDir,
      platform: 'darwin',
      tempRoot,
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
      exitTimeoutMs: 5_000,
      terminateGraceMs: 300,
    });
  };

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'smoke-integration-'));
    tempRoot = join(workDir, 'tmp');
    mkdirSync(tempRoot);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // If a test failed or timed out before the smoke's own cleanup ran, a fake
    // app that ignores SIGTERM would otherwise outlive the test run.
    for (const pid of keptAppPids()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it('passes once the relaunched app is ready and has quit, and removes its profile', async () => {
    const kills: { pid: number; gone: boolean }[] = [];
    const realKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      try {
        const result = realKill(pid, signal);
        kills.push({ pid, gone: false });
        return result;
      } catch (error) {
        kills.push({ pid, gone: (error as NodeJS.ErrnoException).code === 'ESRCH' });
        throw error;
      }
    });

    await expect(run('healthy')).resolves.toBeUndefined();

    expect(profiles()).toEqual([]);
    // Once the app is seen gone its pid may be recycled by an unrelated
    // process, so the smoke must never probe or signal that pid again.
    const exitSeen = kills.findIndex((call) => call.gone);
    expect(exitSeen).toBeGreaterThanOrEqual(0);
    const appPid = kills[exitSeen]!.pid;
    expect(kills.slice(exitSeen + 1).filter((call) => call.pid === appPid)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('fails fast when the relaunched app dies before it is ready, and keeps its profile', async () => {
    const started = Date.now();

    await expect(run('diesBeforeReady')).rejects.toThrow(/exited before startup completed/);

    expect(Date.now() - started).toBeLessThan(FAIL_FAST_BOUND_MS);
    expect(profiles()).toHaveLength(1);
    expect(keptAppPids()).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it('SIGKILLs a relaunched app that ignores SIGTERM instead of orphaning it', async () => {
    await expect(run('ignoresSigterm')).rejects.toThrow(
      new RegExp(`did not initialize within ${STARTUP_TIMEOUT_MS}ms`),
    );

    const [appPid] = keptAppPids();
    expect(appPid).toBeGreaterThan(0);
    expect(isProcessAlive(appPid!)).toBe(false);
  }, TEST_TIMEOUT_MS);
});
