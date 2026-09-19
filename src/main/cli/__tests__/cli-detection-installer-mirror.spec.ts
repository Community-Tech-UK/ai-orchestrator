/**
 * Installer-mirrored CLI copies (see `CliRegistryEntry.installerMirrorDirs`).
 *
 * `npm i -g @xai-official/grok` leaves the usual node-bin shim AND the binary
 * its own postinstall unpacks into `~/.grok/bin` — two PATH hits at the same
 * version on every install. CLI Health used to badge that "Warning: 1 other
 * copy found on PATH" forever, while the shadow probe beside it said "single
 * active install". The extra copy stays listed (it is really on disk) but
 * carries `installerCopy`, so one installation counts as one install.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const { additionalPathsMock, existsSyncMock, realpathSyncMock, spawnMock } = vi.hoisted(() => ({
  additionalPathsMock: vi.fn<() => string[]>(),
  existsSyncMock: vi.fn(),
  realpathSyncMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  default: { spawn: spawnMock },
  spawn: spawnMock,
}));

// The mirror module resolves with `realpathSync.native` (the variant that
// returns on-disk casing); the scan's own dedupe uses plain `realpathSync`.
// Both route to one mock so a test can describe the filesystem once.
vi.mock('fs', () => {
  const realpathSync = Object.assign(
    (path: unknown) => realpathSyncMock(path),
    { native: (path: unknown) => realpathSyncMock(path) },
  );
  return {
    default: { existsSync: existsSyncMock, realpathSync },
    existsSync: existsSyncMock,
    realpathSync,
  };
});

vi.mock('../cli-environment', () => ({
  buildCliSpawnOptions: vi.fn(() => ({ env: {} })),
  getCliAdditionalPaths: additionalPathsMock,
}));

vi.mock('../copilot-cli-launch', () => ({
  resolveCopilotCliLaunch: vi.fn(() => null),
}));

const NPM_SHIM = '/Users/test/.nvm/versions/node/v24.15.0/bin/grok';
const MIRROR = '/Users/test/.grok/bin/grok';

function makeVersionProc(version: string) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setTimeout(() => {
    proc.stdout.emit('data', Buffer.from(`grok ${version}\n`));
    proc.emit('close', 0);
  }, 0);
  return proc;
}

function makeFailingProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setTimeout(() => {
    proc.stderr.emit('data', Buffer.from('version probe blew up\n'));
    proc.emit('close', 1);
  }, 0);
  return proc;
}

/** Report `versions[path]` for each probed copy; absent paths don't exist. */
function stubInstalls(versions: Record<string, string>): void {
  existsSyncMock.mockImplementation((path: unknown) =>
    Object.hasOwn(versions, String(path)));
  spawnMock.mockImplementation((command: string) =>
    makeVersionProc(versions[command] ?? '0.0.0'));
}

describe('CliDetectionService.scanAllCliInstalls — installer-mirrored copies', () => {
  const originalPath = process.env['PATH'];
  const originalHome = process.env['HOME'];
  const originalGrokHome = process.env['GROK_HOME'];
  const originalPlatform = process.platform;

  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    process.env['PATH'] = '';
    process.env['HOME'] = '/Users/test';
    delete process.env['GROK_HOME'];
    additionalPathsMock.mockReturnValue([
      '/Users/test/.nvm/versions/node/v24.15.0/bin',
      '/Users/test/.grok/bin',
    ]);
    realpathSyncMock.mockImplementation((path: unknown) => String(path));
    stubInstalls({ [NPM_SHIM]: '1.0.34', [MIRROR]: '1.0.34' });

    const { CliDetectionService } = await import('../cli-detection');
    CliDetectionService._resetForTesting();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    for (const [name, value] of Object.entries({
      PATH: originalPath,
      HOME: originalHome,
      GROK_HOME: originalGrokHome,
    })) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    vi.clearAllMocks();
  });

  it('marks the postinstall copy as an installer duplicate, not a second install', async () => {
    const { CliDetectionService } = await import('../cli-detection');

    const installs = await CliDetectionService.getInstance().scanAllCliInstalls('grok');

    expect(installs).toEqual([
      { path: NPM_SHIM, version: '1.0.34', installed: true, error: undefined },
      { path: MIRROR, version: '1.0.34', installed: true, error: undefined, installerCopy: true },
    ]);
  });

  it('reports no shadow for an npm grok install', async () => {
    const { CliDetectionService } = await import('../cli-detection');

    const { shadow } = await CliDetectionService.getInstance().inspectCliInstalls('grok');

    expect(shadow).toBeNull();
  });

  it('finds and tags a copy under $GROK_HOME without it being on the shared PATH', async () => {
    // The postinstall honours $GROK_HOME. The scan must find that copy even
    // though /opt/grok-home/bin is deliberately absent from the spawn PATH
    // list (getCliAdditionalPaths) and from the inherited PATH.
    process.env['GROK_HOME'] = '/opt/grok-home';
    const relocatedMirror = '/opt/grok-home/bin/grok';
    additionalPathsMock.mockReturnValue(['/Users/test/.nvm/versions/node/v24.15.0/bin']);
    stubInstalls({ [NPM_SHIM]: '1.0.34', [relocatedMirror]: '1.0.34' });

    const { CliDetectionService } = await import('../cli-detection');
    const installs = await CliDetectionService.getInstance().scanAllCliInstalls('grok');

    expect(installs.map((install) => install.path)).toEqual([NPM_SHIM, relocatedMirror]);
    expect(installs.map((install) => install.installerCopy)).toEqual([undefined, true]);
  });

  it('does not treat ~/.grok/bin as the installer copy once GROK_HOME points elsewhere', async () => {
    process.env['GROK_HOME'] = '/opt/grok-home';
    stubInstalls({ [NPM_SHIM]: '1.0.34', [MIRROR]: '1.0.34' });

    const { CliDetectionService } = await import('../cli-detection');
    const installs = await CliDetectionService.getInstance().scanAllCliInstalls('grok');

    // Same version, so no conflict — but it is a real second copy the
    // installer no longer maintains, listed as such rather than hidden.
    expect(installs.map((install) => install.installerCopy)).toEqual([undefined, undefined]);
  });

  it('recognises a mirror dir reached through a trailing-slash PATH entry', async () => {
    // PATH entries written as `~/.grok/bin/` make the scanner build
    // `<dir>//grok`; the mirror must still be recognised.
    additionalPathsMock.mockReturnValue([
      '/Users/test/.nvm/versions/node/v24.15.0/bin',
      '/Users/test/.grok/bin/',
    ]);
    const doubledMirror = '/Users/test/.grok/bin//grok';
    stubInstalls({ [NPM_SHIM]: '1.0.34', [doubledMirror]: '1.0.34' });

    const { CliDetectionService } = await import('../cli-detection');
    const installs = await CliDetectionService.getInstance().scanAllCliInstalls('grok');

    expect(installs.map((install) => install.installerCopy)).toEqual([undefined, true]);
  });

  it('neither claims nor denies a match when a version could not be read', async () => {
    // The npm shim exists but its version probe failed (installed, no version).
    // "unknown" is not evidence the mirror is a copy of it — so no tag — and
    // equally not evidence of a conflict, so no shadow report either. A
    // transient probe failure used to flash a version-mismatch warning that
    // the next scan cleared.
    existsSyncMock.mockImplementation((path: unknown) =>
      [NPM_SHIM, MIRROR].includes(String(path)));
    spawnMock.mockImplementation((command: string) => {
      if (command === NPM_SHIM) return makeFailingProc();
      return makeVersionProc('1.0.34');
    });

    const { CliDetectionService } = await import('../cli-detection');
    const { installs, shadow } = await CliDetectionService.getInstance()
      .inspectCliInstalls('grok');

    expect(installs.map((install) => install.installerCopy)).toEqual([undefined, undefined]);
    expect(shadow).toBeNull();
  });

  it('still reports a conflict between two copies whose versions were read', async () => {
    additionalPathsMock.mockReturnValue([
      '/Users/test/.nvm/versions/node/v24.15.0/bin',
      '/opt/homebrew/bin',
      '/Users/test/.grok/bin',
    ]);
    // Three copies: the npm shim, a stale Homebrew copy, and the mirror of the
    // shim. The conflict is real, and the mirror is not part of it.
    stubInstalls({
      [NPM_SHIM]: '1.0.34',
      '/opt/homebrew/bin/grok': '1.0.30',
      [MIRROR]: '1.0.34',
    });

    const { CliDetectionService } = await import('../cli-detection');
    const { installs, shadow } = await CliDetectionService.getInstance()
      .inspectCliInstalls('grok');

    expect(installs.map((install) => install.path)).toEqual([
      NPM_SHIM,
      '/opt/homebrew/bin/grok',
      MIRROR,
    ]);
    expect(installs[2]?.installerCopy).toBe(true);
    expect(shadow?.installs.map((install) => install.path))
      .toEqual([NPM_SHIM, '/opt/homebrew/bin/grok']);
  });

  it('leaves a copy whose version disagrees untagged — a half-finished update is real', async () => {
    stubInstalls({ [NPM_SHIM]: '1.0.34', [MIRROR]: '1.0.30' });

    const { CliDetectionService } = await import('../cli-detection');
    const { installs, shadow } = await CliDetectionService.getInstance()
      .inspectCliInstalls('grok');

    expect(installs.map((install) => install.installerCopy)).toEqual([undefined, undefined]);
    expect(shadow).toMatchObject({
      cli: 'grok',
      activePath: NPM_SHIM,
      activeVersion: '1.0.34',
    });
    expect(shadow?.installs.map((install) => install.path)).toEqual([NPM_SHIM, MIRROR]);
  });

  it('keeps a stale installer copy in the conflict, even when a leftover shares its version', async () => {
    // npm 1.0.34 active, a stale Homebrew 1.0.30, and an installer copy also
    // at 1.0.30 (a postinstall that never finished). Matching the copy against
    // the Homebrew version would hide it from the report, so the user would
    // remove Homebrew and only then discover the stale installer copy. Matched
    // against the active version instead, both stale copies are reported at
    // once — and the per-copy advice sorts out which to remove and which to
    // refresh by reinstalling.
    additionalPathsMock.mockReturnValue([
      '/Users/test/.nvm/versions/node/v24.15.0/bin',
      '/opt/homebrew/bin',
      '/Users/test/.grok/bin',
    ]);
    stubInstalls({
      [NPM_SHIM]: '1.0.34',
      '/opt/homebrew/bin/grok': '1.0.30',
      [MIRROR]: '1.0.30',
    });

    const { CliDetectionService } = await import('../cli-detection');
    const { installs, shadow } = await CliDetectionService.getInstance()
      .inspectCliInstalls('grok');

    expect(installs.map((install) => install.installerCopy))
      .toEqual([undefined, undefined, undefined]);
    expect(shadow?.installs.map((install) => install.path))
      .toEqual([NPM_SHIM, '/opt/homebrew/bin/grok', MIRROR]);
  });

  it('treats the mirror dir as the install when it is the only copy (native installer)', async () => {
    stubInstalls({ [MIRROR]: '1.0.34' });

    const { CliDetectionService } = await import('../cli-detection');
    const installs = await CliDetectionService.getInstance().scanAllCliInstalls('grok');

    expect(installs).toEqual([
      { path: MIRROR, version: '1.0.34', installed: true, error: undefined },
    ]);
  });

  it('lists the duplicated install first even when the installer copy is found first', async () => {
    // Mirror dir ahead of the node bin dir in the search order. The active row
    // must still be the npm-managed copy: that is the one to report as current
    // and the one the update plan acts on.
    additionalPathsMock.mockReturnValue([
      '/Users/test/.grok/bin',
      '/Users/test/.nvm/versions/node/v24.15.0/bin',
    ]);

    const { CliDetectionService } = await import('../cli-detection');
    const installs = await CliDetectionService.getInstance().scanAllCliInstalls('grok');

    expect(installs.map((install) => install.path)).toEqual([NPM_SHIM, MIRROR]);
    expect(installs[1]?.installerCopy).toBe(true);
  });

  it('matches the installer dir through a symlinked home', async () => {
    // grok's postinstall resolves realpath($HOME) before appending .grok, so
    // on a machine whose home is a symlink the literal $HOME/.grok/bin never
    // matches what is actually on PATH.
    process.env['HOME'] = '/Users/link';
    const realMirror = '/Volumes/data/test/.grok/bin/grok';
    additionalPathsMock.mockReturnValue([
      '/Users/test/.nvm/versions/node/v24.15.0/bin',
      '/Volumes/data/test/.grok/bin',
    ]);
    realpathSyncMock.mockImplementation((path: unknown) =>
      String(path) === '/Users/link' ? '/Volumes/data/test' : String(path));
    stubInstalls({ [NPM_SHIM]: '1.0.34', [realMirror]: '1.0.34' });

    const { CliDetectionService } = await import('../cli-detection');
    const installs = await CliDetectionService.getInstance().scanAllCliInstalls('grok');

    expect(installs.map((install) => install.installerCopy)).toEqual([undefined, true]);
  });

  it('leaves CLIs without installer mirrors untouched', async () => {
    additionalPathsMock.mockReturnValue([
      '/Users/test/.nvm/versions/node/v24.15.0/bin',
      '/opt/homebrew/bin',
    ]);
    stubInstalls({
      '/Users/test/.nvm/versions/node/v24.15.0/bin/codex': '0.155.1',
      '/opt/homebrew/bin/codex': '0.155.1',
    });

    const { CliDetectionService } = await import('../cli-detection');
    const installs = await CliDetectionService.getInstance().scanAllCliInstalls('codex');

    expect(installs.map((install) => install.path)).toEqual([
      '/Users/test/.nvm/versions/node/v24.15.0/bin/codex',
      '/opt/homebrew/bin/codex',
    ]);
    expect(installs.every((install) => install.installerCopy === undefined)).toBe(true);
  });
});

describe('CliDetectionService.scanAllCliInstalls — scan reuse', () => {
  const originalPath = process.env['PATH'];
  const originalHome = process.env['HOME'];
  const originalPlatform = process.platform;

  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    process.env['PATH'] = '';
    process.env['HOME'] = '/Users/test';
    additionalPathsMock.mockReturnValue(['/Users/test/.nvm/versions/node/v24.15.0/bin']);
    realpathSyncMock.mockImplementation((path: unknown) => String(path));
    stubInstalls({ [NPM_SHIM]: '1.0.34' });

    const { CliDetectionService } = await import('../cli-detection');
    CliDetectionService._resetForTesting();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = originalPath;
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    vi.clearAllMocks();
  });

  it('reuses one scan across the callers of a single refresh', async () => {
    // A CLI Health refresh asks three times over (card list, update plan,
    // shadow probe). Re-spawning --version for each is wasted work, and two
    // scans disagreeing is how the card ended up contradicting its own probe
    // row when a probe timed out in one pass but not the other.
    const { CliDetectionService } = await import('../cli-detection');
    const service = CliDetectionService.getInstance();

    const [first, second] = await Promise.all([
      service.scanAllCliInstalls('grok'),
      service.inspectCliInstalls('grok'),
    ]);
    const third = await service.scanAllCliInstalls('grok');

    expect(first).toEqual(second.installs);
    expect(third).toEqual(first);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('rescans on a forced refresh, and later callers reuse that fresh scan', async () => {
    // CLI Health's Refresh must look again, but the update plan and the
    // shadow probe that follow it in the same refresh should read the same
    // fresh result rather than re-spawn.
    const { CliDetectionService } = await import('../cli-detection');
    const service = CliDetectionService.getInstance();

    await service.scanAllCliInstalls('grok');
    stubInstalls({ [NPM_SHIM]: '1.0.35' });
    const forced = await service.scanAllCliInstalls('grok', { forceRefresh: true });
    const { installs } = await service.inspectCliInstalls('grok');

    expect(forced[0]?.version).toBe('1.0.35');
    expect(installs[0]?.version).toBe('1.0.35');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('never caches or shares a scan that was running when the cache was cleared', async () => {
    // A scan started before an update finishes must not write its pre-update
    // result back, nor be joined by the Refresh that follows "Run updater".
    const { CliDetectionService } = await import('../cli-detection');
    const service = CliDetectionService.getInstance();

    const stale = service.scanAllCliInstalls('grok');
    service.clearCache();
    stubInstalls({ [NPM_SHIM]: '1.0.35' });
    const fresh = service.scanAllCliInstalls('grok', { forceRefresh: true });

    expect((await stale)[0]?.version).toBe('1.0.34');
    expect((await fresh)[0]?.version).toBe('1.0.35');
    // The stale result did not land in the cache either.
    expect((await service.scanAllCliInstalls('grok'))[0]?.version).toBe('1.0.35');
  });

  it('keeps a scan pinned for the whole of a refresh, then lets it expire', async () => {
    // Inside one CLI Health refresh the card's scan must back the probe row
    // even if a --version or `which` probe in between burns its 5s timeout.
    const { CliDetectionService } = await import('../cli-detection');
    const service = CliDetectionService.getInstance();
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);

    try {
      await service.withPinnedInstallScans(async () => {
        await service.scanAllCliInstalls('grok', { forceRefresh: true });
        // Well past the 5s TTL (a probe burning its timeout), inside the cap.
        now.mockReturnValue(start + 30_000);
        stubInstalls({ [NPM_SHIM]: '1.0.35' });
        const later = await service.inspectCliInstalls('grok');
        expect(later.installs[0]?.version).toBe('1.0.34');
      });
      expect(spawnMock).toHaveBeenCalledTimes(1);

      // Outside the pin the TTL applies again, so the same age now rescans.
      const after = await service.scanAllCliInstalls('grok');
      expect(after[0]?.version).toBe('1.0.35');
      expect(spawnMock).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('caps pinned reuse so a refresh that never settles cannot freeze scans', async () => {
    const { CliDetectionService } = await import('../cli-detection');
    const service = CliDetectionService.getInstance();
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);

    try {
      await service.withPinnedInstallScans(async () => {
        await service.scanAllCliInstalls('grok', { forceRefresh: true });
        now.mockReturnValue(start + 61_000);
        stubInstalls({ [NPM_SHIM]: '1.0.35' });
        const stale = await service.scanAllCliInstalls('grok');
        expect(stale[0]?.version).toBe('1.0.35');
      });
      expect(spawnMock).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('re-scans after clearCache, which an update calls', async () => {
    const { CliDetectionService } = await import('../cli-detection');
    const service = CliDetectionService.getInstance();

    await service.scanAllCliInstalls('grok');
    service.clearCache();
    stubInstalls({ [NPM_SHIM]: '1.0.35' });
    const after = await service.scanAllCliInstalls('grok');

    expect(after[0]?.version).toBe('1.0.35');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});

describe('installer mirror directory matching', () => {
  it('matches a mirror dir regardless of repeated or trailing separators', async () => {
    const { CLI_REGISTRY, getInstallerMirrorDirs, isInstallerMirrorPath } =
      await import('../cli-registry');

    const relocated = getInstallerMirrorDirs(
      CLI_REGISTRY.grok,
      { HOME: '/Users/test', GROK_HOME: '/opt/grok-home/' },
      'darwin',
    );
    expect(relocated).toEqual(['/opt/grok-home/bin']);
    expect(isInstallerMirrorPath('/opt/grok-home/bin/grok', relocated, 'darwin')).toBe(true);

    const standard = getInstallerMirrorDirs(CLI_REGISTRY.grok, { HOME: '/Users/test' }, 'darwin');
    expect(isInstallerMirrorPath('/Users/test/.grok/bin//grok', standard, 'darwin')).toBe(true);
    expect(isInstallerMirrorPath('/Users/test/.local/bin/grok', standard, 'darwin')).toBe(false);
    // A nested path is not the mirror dir itself.
    expect(isInstallerMirrorPath('/Users/test/.grok/bin/sub/grok', standard, 'darwin')).toBe(false);
  });

  it('treats the installer dirs as a fallback chain, like $GROK_HOME ?? ~/.grok', async () => {
    // grok's postinstall writes to exactly one place. With GROK_HOME set a
    // ~/.grok/bin copy is an abandoned leftover: a reinstall never refreshes
    // it, so it must not be treated as the installer's own.
    const { CLI_REGISTRY } = await import('../cli-registry');
    const { isInstallerOwnedPath } = await import('../cli-install-mirrors');
    const relocatedEnv = { HOME: '/Users/test', GROK_HOME: '/opt/grok-home' };

    expect(isInstallerOwnedPath(CLI_REGISTRY.grok, '/opt/grok-home/bin/grok', relocatedEnv, 'darwin'))
      .toBe(true);
    expect(isInstallerOwnedPath(CLI_REGISTRY.grok, '/Users/test/.grok/bin/grok', relocatedEnv, 'darwin'))
      .toBe(false);
    expect(isInstallerOwnedPath(CLI_REGISTRY.grok, '/Users/test/.grok/bin/grok', { HOME: '/Users/test' }, 'darwin'))
      .toBe(true);
  });

  it('matches case-insensitively on Windows only', async () => {
    const { CLI_REGISTRY, getInstallerMirrorDirs, isInstallerMirrorPath } =
      await import('../cli-registry');

    const windowsDirs = getInstallerMirrorDirs(
      CLI_REGISTRY.grok,
      { USERPROFILE: 'C:\\Users\\James' },
      'win32',
    );
    expect(windowsDirs).toContain('c:/users/james/.grok/bin');
    expect(isInstallerMirrorPath('C:\\Users\\James\\.grok\\bin\\grok.exe', windowsDirs, 'win32'))
      .toBe(true);

    const posixDirs = getInstallerMirrorDirs(CLI_REGISTRY.grok, { HOME: '/Users/test' }, 'darwin');
    expect(isInstallerMirrorPath('/Users/test/.GROK/bin/grok', posixDirs, 'darwin')).toBe(false);
  });

  it('reports no mirror dirs for a CLI that declares none', async () => {
    const { CLI_REGISTRY, getInstallerMirrorDirs } = await import('../cli-registry');

    expect(getInstallerMirrorDirs(CLI_REGISTRY.codex, { HOME: '/Users/test' }, 'darwin'))
      .toEqual([]);
  });
});
