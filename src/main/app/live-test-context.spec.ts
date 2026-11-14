import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeHarnessLiveTest, isHarnessLiveTest, writeHarnessLiveTestReceipt } from './live-test-context';

const dirs: string[] = [];
afterEach(() => {
  initializeHarnessLiveTest({ env: {}, appDataPath: '/unused', isPackaged: false, execPath: process.execPath });
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/aio-lt-context-'));
  dirs.push(root);
  const data = join(root, 'profile');
  mkdirSync(data, { mode: 0o700 });
  const executable = join(root, 'repo/release/Harness.app/Contents/MacOS/Harness');
  mkdirSync(join(executable, '..'), { recursive: true });
  writeFileSync(executable, 'fixture');
  const ownerFile = join(root, 'livetest-owner.json');
  const owner = { schemaVersion: 1, mode: 'packaged', tree: 'a'.repeat(40), dataPath: data, executablePath: executable, port: 9877 };
  writeFileSync(ownerFile, JSON.stringify(owner), { mode: 0o600 });
  writeFileSync(join(data, '.aio-livetest-profile.json'), JSON.stringify({ schemaVersion: 1, mode: 'packaged', dataPath: data }), { mode: 0o600 });
  return { root, data, executable, ownerFile, owner,
    options: { appDataPath: join(root, 'normal'), isPackaged: true, execPath: executable,
      env: { AIO_LIVETEST: '1', AIO_LIVETEST_USER_DATA_PATH: data, AIO_LIVETEST_OWNER_FILE: ownerFile } },
  };
}

describe('owned live-test context', () => {
  it('binds a packaged runtime receipt to its real executable, profile and snapshot', () => {
    const f = fixture();
    expect(initializeHarnessLiveTest(f.options)?.dataPath).toBe(f.data);
    expect(isHarnessLiveTest()).toBe(true);
    writeHarnessLiveTestReceipt({ pid: process.pid, isPackaged: true, version: 'test', ready: true });
    expect(JSON.parse(readFileSync(join(f.root, 'runtime.json'), 'utf8'))).toMatchObject({
      pid: process.pid, isPackaged: true, ready: true, tree: f.owner.tree, dataPath: f.data, executablePath: f.executable,
    });
  });

  it('refuses partial enablement, startup-smoke mixing and a wrong executable or mode', () => {
    const f = fixture();
    expect(() => initializeHarnessLiveTest({ ...f.options, env: { AIO_LIVETEST: '1' } })).toThrow();
    expect(() => initializeHarnessLiveTest({ ...f.options, env: { ...f.options.env, AIO_LIVETEST: '' } })).toThrow();
    expect(() => initializeHarnessLiveTest({ ...f.options, env: { ...f.options.env, AIO_STARTUP_SMOKE: '1' } })).toThrow();
    expect(() => initializeHarnessLiveTest({ ...f.options, execPath: process.execPath })).toThrow(/executable/);
    expect(() => initializeHarnessLiveTest({ ...f.options, isPackaged: false })).toThrow(/mode/);
    expect(isHarnessLiveTest()).toBe(false);
  });

  it('refuses normal-profile overlap and a symlinked profile', () => {
    const f = fixture();
    expect(() => initializeHarnessLiveTest({ ...f.options, appDataPath: f.data })).toThrow(/overlap/);
    const link = join(f.root, 'profile-link');
    symlinkSync(f.data, link);
    expect(() => initializeHarnessLiveTest({ ...f.options, env: { ...f.options.env, AIO_LIVETEST_USER_DATA_PATH: link } })).toThrow(/canonical/);
  });

  it('refuses a missing profile marker, public ownership receipt and a package outside the owned copy', () => {
    const f = fixture();
    rmSync(join(f.data, '.aio-livetest-profile.json'));
    expect(() => initializeHarnessLiveTest(f.options)).toThrow();
    writeFileSync(join(f.data, '.aio-livetest-profile.json'), JSON.stringify({ schemaVersion: 1, mode: 'packaged', dataPath: f.data }));
    chmodSync(f.ownerFile, 0o644);
    expect(() => initializeHarnessLiveTest(f.options)).toThrow(/private/);
    chmodSync(f.ownerFile, 0o600);
    writeFileSync(f.ownerFile, JSON.stringify({ ...f.owner, executablePath: process.execPath }));
    expect(() => initializeHarnessLiveTest({ ...f.options, execPath: process.execPath })).toThrow(/owned copy/);
  });
});
