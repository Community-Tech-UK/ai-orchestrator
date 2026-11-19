import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  harnessLiveTestDataPath, initializeHarnessLiveTest, isHarnessLiveTest, isOwnedProfilePath, LIVE_TEST_OVERRIDES_DIR,
  resolveLiveTestClaudeStandIn, writeHarnessLiveTestReceipt,
} from './live-test-context';

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
    expect(harnessLiveTestDataPath()).toBe(f.data);
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
    expect(harnessLiveTestDataPath()).toBeNull();
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

  it('on Windows owns only the data folder made for test copies, whatever the letter case', () => {
    const home = 'C:\\Users\\tester';
    const owned = (data: string) => isOwnedProfilePath(data, 'win32', home);
    expect(owned('C:\\Users\\tester\\.aio-devapps\\data\\aio-lt-run1')).toBe(true);
    expect(owned('c:\\users\\TESTER\\.aio-devapps\\data\\aio-lt-run1')).toBe(true);
    for (const data of ['C:\\Users\\tester\\AppData\\Roaming\\harness', 'C:\\Users\\tester\\.aio-devapps\\data\\other',
      'C:\\Users\\tester\\.aio-devapps\\data\\..\\..\\AppData\\aio-lt-x', 'C:\\Users\\other\\.aio-devapps\\data\\aio-lt-run1',
      '/tmp/aio-lt-run1']) expect(owned(data)).toBe(false);
  });
});

describe('live-test Claude stand-in', () => {
  function install(f: ReturnType<typeof fixture>, mode = 0o700) {
    const dir = join(f.data, LIVE_TEST_OVERRIDES_DIR);
    mkdirSync(dir, { mode: 0o700, recursive: true });
    const file = join(dir, 'claude');
    writeFileSync(file, '#!/bin/sh\n', { mode });
    chmodSync(file, mode);
    return { dir, file };
  }

  it('is ignored outside a live test, even when a file sits where it would be', () => {
    const f = fixture();
    install(f);
    expect(isHarnessLiveTest()).toBe(false);
    expect(resolveLiveTestClaudeStandIn()).toBeNull();
  });

  it('returns nothing in a live test that has no stand-in', () => {
    initializeHarnessLiveTest(fixture().options);
    expect(resolveLiveTestClaudeStandIn()).toBeNull();
  });

  it('returns the real path of an owned, private, executable stand-in', () => {
    const f = fixture();
    const { file } = install(f);
    initializeHarnessLiveTest(f.options);
    expect(resolveLiveTestClaudeStandIn()).toBe(file);
  });

  it('is gone once the profile files are removed, and refuses a stale or replaced profile', () => {
    const f = fixture();
    const { dir } = install(f);
    initializeHarnessLiveTest(f.options);
    rmSync(dir, { recursive: true });
    expect(resolveLiveTestClaudeStandIn()).toBeNull();
    install(f);
    rmSync(join(f.data, '.aio-livetest-profile.json'));
    expect(() => resolveLiveTestClaudeStandIn()).toThrow();
    writeFileSync(join(f.data, '.aio-livetest-profile.json'), JSON.stringify({ schemaVersion: 1, mode: 'dev', dataPath: f.data }));
    expect(() => resolveLiveTestClaudeStandIn()).toThrow(/no longer matches/);
  });

  it.each([
    ['not executable', 0o600],
    ['writable by others', 0o777],
    ['writable by its group', 0o770],
  ])('refuses a stand-in that is %s', (_name, mode) => {
    const f = fixture();
    install(f, mode);
    initializeHarnessLiveTest(f.options);
    expect(() => resolveLiveTestClaudeStandIn()).toThrow();
  });

  it('refuses a link, even to a file inside the profile, and a link in place of the folder', () => {
    const f = fixture();
    const { dir, file } = install(f);
    initializeHarnessLiveTest(f.options);
    const target = join(f.data, 'elsewhere');
    writeFileSync(target, '#!/bin/sh\n', { mode: 0o700 });
    rmSync(file);
    symlinkSync(target, file);
    expect(() => resolveLiveTestClaudeStandIn()).toThrow(/plain file/);
    rmSync(dir, { recursive: true });
    const outside = join(f.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'claude'), '#!/bin/sh\n', { mode: 0o700 });
    symlinkSync(outside, dir);
    expect(() => resolveLiveTestClaudeStandIn()).toThrow(/inside its profile/);
  });
});
