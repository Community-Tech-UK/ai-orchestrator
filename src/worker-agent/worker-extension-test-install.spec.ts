import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerExtensionTestInstall } from './worker-extension-test-install';

const manifest = (version: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  manifest_version: 3,
  version,
  permissions: ['tabs'],
  background: { service_worker: 'background.js' },
  ...extra,
});
const file = (name: string, content: string) => ({ name, contentBase64: Buffer.from(content).toString('base64') });

describe('WorkerExtensionTestInstall', () => {
  let root: string;
  let folder: string;
  let stateRoot: string;
  let clock: number;
  let running: string | undefined;
  let expected: string | undefined;
  let reloadOnExpected: boolean;

  const relay = {
    setExpectedExtensionVersion: (version: string) => {
      expected = version;
      // Models the extension reloading from the folder once it is told which version to expect.
      if (reloadOnExpected) running = version;
    },
    getSummary: () => ({ extensionVersion: running }),
  };

  function make(options: { folder?: string | undefined } = {}) {
    return new WorkerExtensionTestInstall({
      folder: 'folder' in options ? options.folder : folder,
      stateRoot,
      relay,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      reloadWaitMs: 5_000,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
  }
  const install = (target: WorkerExtensionTestInstall, files: ReturnType<typeof file>[], ownerId = 'owner-a', ttlMs = 600_000) =>
    target.handle({ action: 'install', ownerId, ttlMs, files });
  const build = (version: string) => [
    file('manifest.json', manifest(version)),
    file('background.js', `// test build ${version}`),
  ];
  const read = (name: string) => fs.readFileSync(path.join(folder, name), 'utf-8');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-ext-test-'));
    folder = path.join(root, 'resources', 'browser-extension');
    stateRoot = path.join(root, 'home', 'extension-test-install');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'manifest.json'), manifest('0.2.54'));
    fs.writeFileSync(path.join(folder, 'background.js'), '// main');
    fs.writeFileSync(path.join(folder, 'popup.js'), '// popup');
    clock = 1_000_000;
    running = '0.2.54';
    expected = undefined;
    reloadOnExpected = true;
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('installs the build, tells the extension its version and reports the reload', async () => {
    const target = make();
    const result = await install(target, build('0.2.55'));
    expect(result).toMatchObject({ state: 'active', testVersion: '0.2.55', originalVersion: '0.2.54', ownerId: 'owner-a', reloadObserved: true, runningExtensionVersion: '0.2.55' });
    expect(read('background.js')).toBe('// test build 0.2.55');
    expect(fs.existsSync(path.join(folder, 'popup.js'))).toBe(false);
    expect(expected).toBe('0.2.55');
    expect(target.isActive()).toBe(true);
    target.dispose();
  });

  it('reports a reload that never happened instead of claiming success', async () => {
    reloadOnExpected = false;
    const target = make();
    const result = await install(target, build('0.2.55'));
    expect(result).toMatchObject({ state: 'active', reloadObserved: false, runningExtensionVersion: '0.2.54' });
    target.dispose();
  });

  it('restores every original file byte for byte and removes the lease', async () => {
    const target = make();
    await install(target, build('0.2.55'));
    const result = await target.handle({ action: 'restore', ownerId: 'owner-a' });
    expect(result).toMatchObject({ state: 'idle', restored: true, reloadObserved: true });
    expect(read('manifest.json')).toBe(manifest('0.2.54'));
    expect(read('background.js')).toBe('// main');
    expect(read('popup.js')).toBe('// popup');
    expect(fs.readdirSync(folder).sort()).toEqual(['background.js', 'manifest.json', 'popup.js']);
    expect(expected).toBe('0.2.54');
    expect(fs.existsSync(stateRoot)).toBe(false);
    expect(target.isActive()).toBe(false);
  });

  it('puts each original file back with its pre-install modification time, also after a worker restart', async () => {
    const past = new Date('2026-01-02T03:04:05.000Z');
    for (const name of ['manifest.json', 'background.js', 'popup.js']) fs.utimesSync(path.join(folder, name), past, past);
    const before = fs.statSync(path.join(folder, 'manifest.json'));

    const first = make();
    await install(first, build('0.2.55'));
    expect(fs.statSync(path.join(folder, 'manifest.json')).mtimeMs).not.toBe(before.mtimeMs);
    first.dispose(); // the process dies; a new worker restores from the lease record
    await make().recoverOnStart();

    for (const name of ['manifest.json', 'background.js', 'popup.js']) {
      const after = fs.statSync(path.join(folder, name));
      expect(after.mtimeMs).toBe(past.getTime());
      expect(after.size).toBe(fs.readFileSync(path.join(folder, name)).length);
    }
    expect(fs.statSync(path.join(folder, 'manifest.json')).size).toBe(before.size);

    const second = make();
    await install(second, build('0.2.56'));
    await second.handle({ action: 'restore', ownerId: 'owner-a' });
    expect(fs.statSync(path.join(folder, 'manifest.json')).mtimeMs).toBe(past.getTime());
  });

  it('leaves files that are not extension files alone, through install and restore', async () => {
    fs.writeFileSync(path.join(folder, '.DS_Store'), 'finder');
    const target = make();
    await install(target, build('0.2.55'));
    expect(read('.DS_Store')).toBe('finder');
    await target.handle({ action: 'restore', ownerId: 'owner-a' });
    expect(read('.DS_Store')).toBe('finder');
    expect(read('popup.js')).toBe('// popup');
  });

  it('restoring with nothing installed is a no-op', async () => {
    expect(await make().handle({ action: 'restore', ownerId: 'x' })).toEqual({ state: 'idle', restored: false });
  });

  it.each([
    ['a version that is not above', build('0.2.54'), 'must be above'],
    ['wider permissions', [file('manifest.json', manifest('0.2.55', { permissions: ['tabs', 'history'] })), file('background.js', 'x')], 'does not have'],
    ['a missing manifest', [file('background.js', 'x')], 'needs manifest.json'],
    ['a path in a file name', [...build('0.2.55'), file('../escape.js', 'x')], 'not allowed'],
  ])('refuses %s without touching the folder', async (_label, files, message) => {
    const target = make();
    await expect(install(target, files)).rejects.toThrow(message);
    expect(read('manifest.json')).toBe(manifest('0.2.54'));
    expect(target.isActive()).toBe(false);
    expect(fs.existsSync(stateRoot)).toBe(false);
    expect(fs.existsSync(path.join(root, 'resources', 'escape.js'))).toBe(false);
  });

  it('refuses a worker that owns no extension folder', async () => {
    await expect(install(make({ folder: undefined }), build('0.2.55'))).rejects.toThrow('no unpacked extension folder');
  });

  it('keeps the lease for its owner: another install or restore is refused until it ends', async () => {
    const target = make();
    await install(target, build('0.2.55'), 'owner-a');
    await expect(install(target, build('0.2.56'), 'owner-b')).rejects.toThrow('already installed');
    await expect(target.handle({ action: 'restore', ownerId: 'owner-b' })).rejects.toThrow('another session');
    expect(read('background.js')).toBe('// test build 0.2.55');
    target.dispose();
  });

  it('lets another session restore, and install again, once the lease has expired', async () => {
    const target = make();
    await install(target, build('0.2.55'), 'owner-a', 60_000);
    clock += 61_000;
    const next = await install(target, build('0.2.56'), 'owner-b');
    expect(next).toMatchObject({ state: 'active', ownerId: 'owner-b', testVersion: '0.2.56', originalVersion: '0.2.54' });
    clock += 700_000;
    expect(await target.handle({ action: 'restore', ownerId: 'owner-c' })).toMatchObject({ restored: true });
    expect(read('popup.js')).toBe('// popup');
  });

  it('puts the original back by itself when the lease ends', async () => {
    vi.useFakeTimers();
    try {
      const target = make();
      await install(target, build('0.2.55'), 'owner-a', 60_000);
      await vi.advanceTimersByTimeAsync(0);
      clock += 61_000;
      await vi.advanceTimersByTimeAsync(61_000);
      await vi.waitFor(() => expect(target.isActive()).toBe(false));
      expect(read('background.js')).toBe('// main');
      expect(expected).toBe('0.2.54');
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a lease left by a crashed worker on the next start', async () => {
    const first = make();
    await install(first, build('0.2.55'));
    first.dispose(); // the process dies: files and lease record stay
    expect(read('background.js')).toBe('// test build 0.2.55');

    const restarted = make();
    await restarted.recoverOnStart();
    expect(read('background.js')).toBe('// main');
    expect(read('popup.js')).toBe('// popup');
    expect(restarted.isActive()).toBe(false);
    expect(fs.existsSync(stateRoot)).toBe(false);
  });

  it('start-up recovery with no lease does nothing, and a damaged record is surfaced', async () => {
    await expect(make().recoverOnStart()).resolves.toBeUndefined();
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(path.join(stateRoot, 'state.json'), '{"leaseId":1}');
    await expect(make().recoverOnStart()).rejects.toThrow('damaged');
  });

  it('keeps the lease when the original cannot be put back yet, and finishes the restore on retry', async () => {
    const target = make();
    // A directory where the temporary file must go fails the second write, and the rollback hits the same wall.
    const blocker = path.join(folder, 'background.js.aio-tmp');
    fs.mkdirSync(blocker);
    await expect(install(target, build('0.2.55'))).rejects.toThrow(/EISDIR|directory/i);
    expect(target.isActive()).toBe(true);
    expect(fs.existsSync(path.join(stateRoot, 'state.json'))).toBe(true);

    fs.rmdirSync(blocker);
    expect(await target.handle({ action: 'restore', ownerId: 'owner-a' })).toMatchObject({ restored: true });
    expect(read('manifest.json')).toBe(manifest('0.2.54'));
    expect(read('background.js')).toBe('// main');
    expect(read('popup.js')).toBe('// popup');
    expect(target.isActive()).toBe(false);
  });
  it('refuses to install over a symbolic link in the folder and leaves the file it points at alone', async () => {
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'keep me');
    fs.rmSync(path.join(folder, 'popup.js'));
    fs.symlinkSync(outside, path.join(folder, 'popup.js'));
    const target = make();
    await expect(install(target, [...build('0.2.55'), file('popup.js', '// test popup')])).rejects.toMatchObject({ code: 'folder_has_link' });
    expect(fs.readFileSync(outside, 'utf-8')).toBe('keep me');
    expect(target.isActive()).toBe(false);
    expect(read('background.js')).toBe('// main');
  });

  it('never writes through a link that appears at a temporary path or during the lease', async () => {
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'keep me');
    fs.symlinkSync(outside, path.join(folder, 'background.js.aio-tmp'));
    const target = make();
    await install(target, build('0.2.55'));
    expect(fs.readFileSync(outside, 'utf-8')).toBe('keep me');
    expect(read('background.js')).toBe('// test build 0.2.55');

    // A link planted in the folder while the test build is installed is removed as a link on restore.
    fs.symlinkSync(outside, path.join(folder, 'extra.js'));
    await target.handle({ action: 'restore', ownerId: 'owner-a' });
    expect(fs.readFileSync(outside, 'utf-8')).toBe('keep me');
    expect(fs.existsSync(path.join(folder, 'extra.js'))).toBe(false);
    expect(read('background.js')).toBe('// main');
  });
});
