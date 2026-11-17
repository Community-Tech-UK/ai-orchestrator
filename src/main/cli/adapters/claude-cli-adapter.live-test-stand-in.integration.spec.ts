import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { initializeHarnessLiveTest, LIVE_TEST_OVERRIDES_DIR } from '../../app/live-test-context';
import { ClaudeCliAdapter } from './claude-cli-adapter';

const STAND_IN = resolve(__dirname, '../../../../scripts/remote-checks/claude-limit-stand-in.js');
const dirs: string[] = [];
afterEach(() => {
  initializeHarnessLiveTest({ env: {}, appDataPath: '/unused', isPackaged: false, execPath: process.execPath });
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

/** A real owned live-test profile (dev mode) with the shipped stand-in installed in it. */
function ownedProfile() {
  const root = realpathSync(mkdtempSync('/tmp/aio-lt-standin-'));
  dirs.push(root);
  const data = join(root, 'profile');
  mkdirSync(join(data, LIVE_TEST_OVERRIDES_DIR), { recursive: true, mode: 0o700 });
  chmodSync(data, 0o700);
  const executablePath = realpathSync(process.execPath);
  const ownerFile = join(root, 'livetest-owner.json');
  writeFileSync(ownerFile, JSON.stringify({ schemaVersion: 1, mode: 'dev', tree: 'a'.repeat(40), dataPath: data, executablePath, port: 9877 }), { mode: 0o600 });
  writeFileSync(join(data, '.aio-livetest-profile.json'), JSON.stringify({ schemaVersion: 1, mode: 'dev', dataPath: data }), { mode: 0o600 });
  const installed = join(data, LIVE_TEST_OVERRIDES_DIR, 'claude');
  copyFileSync(STAND_IN, installed);
  chmodSync(installed, 0o700);
  initializeHarnessLiveTest({
    appDataPath: join(root, 'normal'), isPackaged: false, execPath: executablePath,
    env: { AIO_LIVETEST: '1', AIO_LIVETEST_USER_DATA_PATH: data, AIO_LIVETEST_OWNER_FILE: ownerFile },
  });
  return { root, installed };
}

describe('Claude limit stand-in', () => {
  it('answers the version probe without contacting a provider', () => {
    const result = spawnSync(process.execPath, [STAND_IN, '--version'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Claude Code');
  });

  it('is what a new Claude adapter spawns in an owned live-test profile, and its limit reaches the adapter', async () => {
    const { root, installed } = ownedProfile();
    const log = join(root, 'stand-in.log');
    const adapter = new ClaudeCliAdapter({ residentClaude: true, workingDirectory: root, env: { AIO_STAND_IN_LOG: log, AIO_STAND_IN_RESET_MINUTES: '4' } });
    expect(adapter.getConfig().command).toBe(installed);

    const telemetry: Array<{ status?: string; resetsAt?: number }> = [];
    adapter.on('rate-limit-telemetry', info => telemetry.push(info));
    const before = Math.floor(Date.now() / 1000);
    try {
      await adapter.spawn();
      await adapter.sendInput('hello');
      await vi.waitFor(() => expect(telemetry).toHaveLength(1), { timeout: 15_000 });
    } finally {
      await adapter.terminate(true).catch(() => undefined);
    }

    expect(telemetry[0]?.status).toBe('rejected');
    expect(telemetry[0]!.resetsAt!).toBeGreaterThanOrEqual(before + 4 * 60);
    expect(telemetry[0]!.resetsAt!).toBeLessThanOrEqual(before + 4 * 60 + 30);
    const events = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).event);
    expect(events).toEqual(expect.arrayContaining(['start', 'limit-reported']));
  }, 30_000);

  it('does not replace the real command outside a live test', () => {
    expect(new ClaudeCliAdapter().getConfig().command).toBe('claude');
  });
});
