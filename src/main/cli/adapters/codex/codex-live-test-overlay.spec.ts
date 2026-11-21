import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeHarnessLiveTest } from '../../../app/live-test-context';
import { CodexHomeManager } from './codex-home-manager';
import { CODEX_LIVE_TEST_OVERLAY_FILE, applyCodexLiveTestOverlay, readCodexLiveTestOverlay } from './codex-live-test-overlay';

const BROKEN_SERVER = '[mcp_servers.broken_probe]\ncommand = "/nonexistent/aio-broken-tool-server"\nargs = ["--serve"]\n';

describe('Codex live-test tool-server overlay', () => {
  const originalHome = process.env['HOME'];
  const dirs: string[] = [];
  let data = '';

  /** A validated live-test copy, exactly as the dev-app runner prepares one. */
  function startLiveTest(): void {
    const root = realpathSync(mkdtempSync('/tmp/aio-lt-codex-overlay-'));
    dirs.push(root);
    data = join(root, 'profile');
    mkdirSync(data, { mode: 0o700 });
    const ownerFile = join(root, 'livetest-owner.json');
    const executablePath = realpathSync(process.execPath);
    writeFileSync(ownerFile, JSON.stringify({
      schemaVersion: 1, mode: 'dev', tree: 'a'.repeat(40), dataPath: data, executablePath, port: 9877,
    }), { mode: 0o600 });
    writeFileSync(join(data, '.aio-livetest-profile.json'), JSON.stringify({ schemaVersion: 1, mode: 'dev', dataPath: data }), { mode: 0o600 });
    initializeHarnessLiveTest({
      appDataPath: join(root, 'normal'), isPackaged: false, execPath: process.execPath,
      env: { AIO_LIVETEST: '1', AIO_LIVETEST_USER_DATA_PATH: data, AIO_LIVETEST_OWNER_FILE: ownerFile },
    });
  }

  function writeOverlay(content: string, mode = 0o600): string {
    const file = join(data, CODEX_LIVE_TEST_OVERLAY_FILE);
    writeFileSync(file, content, { mode });
    chmodSync(file, mode);
    return file;
  }

  function fakeHome(config: string): string {
    const home = mkdtempSync(join(tmpdir(), 'codex-overlay-home-'));
    dirs.push(home);
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'config.toml'), config, 'utf-8');
    process.env['HOME'] = home;
    return home;
  }

  beforeEach(() => {
    initializeHarnessLiveTest({ env: {}, appDataPath: '/unused', isPackaged: false, execPath: process.execPath });
  });

  afterEach(() => {
    initializeHarnessLiveTest({ env: {}, appDataPath: '/unused', isPackaged: false, execPath: process.execPath });
    if (originalHome === undefined) delete process.env['HOME']; else process.env['HOME'] = originalHome;
    dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  it('is off outside a live-test copy, even when an overlay file sits in a folder', () => {
    startLiveTest();
    writeOverlay(BROKEN_SERVER);
    initializeHarnessLiveTest({ env: {}, appDataPath: '/unused', isPackaged: false, execPath: process.execPath });
    expect(readCodexLiveTestOverlay()).toBeNull();
  });

  it('returns null when the live-test copy has no overlay', () => {
    startLiveTest();
    expect(readCodexLiveTestOverlay()).toBeNull();
  });

  it('reads a private tool-server overlay from the copy\'s own data folder', () => {
    startLiveTest();
    writeOverlay(BROKEN_SERVER);
    expect(readCodexLiveTestOverlay()).toBe(BROKEN_SERVER);
  });

  it.each([
    ['a model or auth setting', 'model = "x"\n'],
    ['an approval or sandbox table', '[sandbox_workspace_write]\nnetwork_access = true\n'],
    ['a table mixed with a tool server', `${BROKEN_SERVER}\n[profiles.p]\nmodel = "x"\n`],
    ['a bare [mcp_servers] table', '[mcp_servers]\nstartup_timeout_sec = 5\n'],
    ['a root mcp_servers key', 'mcp_servers = { broken_probe = { command = "x" } }\n'],
    ['a bare [mcp_servers] table beside a tool server', `${BROKEN_SERVER}\n[mcp_servers]\nx = 1\n`],
    ['a sub-table of a server', `${BROKEN_SERVER}\n[mcp_servers.broken_probe.env]\nX = "1"\n`],
    ['a dotted root key into a server', 'mcp_servers.broken_probe.command = "x"\n'],
    ['an array table', '[[mcp_servers.broken_probe]]\ncommand = "x"\n'],
  ])('rejects %s', (_label, content) => {
    startLiveTest();
    writeOverlay(content);
    expect(() => readCodexLiveTestOverlay()).toThrow(/may only define \[mcp_servers/);
  });

  it('rejects text that is not valid TOML', () => {
    startLiveTest();
    writeOverlay('[mcp_servers.broken\n');
    expect(() => readCodexLiveTestOverlay()).toThrow();
  });

  it('rejects a symlinked overlay, so it cannot point at a real config', () => {
    startLiveTest();
    const outside = join(dirs[0]!, 'real.toml');
    writeFileSync(outside, BROKEN_SERVER);
    symlinkSync(outside, join(data, CODEX_LIVE_TEST_OVERLAY_FILE));
    expect(() => readCodexLiveTestOverlay()).toThrow(/regular file/);
  });

  it('rejects an overlay another user could change, and an oversized one', () => {
    startLiveTest();
    writeOverlay(BROKEN_SERVER, 0o666);
    expect(() => readCodexLiveTestOverlay()).toThrow(/not be writable by others/);
    writeOverlay(`${BROKEN_SERVER}# ${'x'.repeat(20_000)}\n`);
    expect(() => readCodexLiveTestOverlay()).toThrow(/too large/);
  });

  it('stops applying once the copy\'s data folder is removed', () => {
    startLiveTest();
    writeOverlay(BROKEN_SERVER);
    rmSync(data, { recursive: true });
    expect(readCodexLiveTestOverlay()).toBeNull();
  });

  it('replaces a same-named user server and keeps the rest of the config', () => {
    const merged = applyCodexLiveTestOverlay(
      'model = "m"\n\n[mcp_servers.broken_probe]\ncommand = "real"\n\n[mcp_servers.other]\ncommand = "keep"\n',
      BROKEN_SERVER,
    );
    expect(merged).toContain('model = "m"');
    expect(merged).toContain('[mcp_servers.other]');
    expect(merged).toContain('/nonexistent/aio-broken-tool-server');
    expect(merged).not.toContain('command = "real"');
    expect(applyCodexLiveTestOverlay('model = "m"\n', null)).toBe('model = "m"\n');
  });

  describe('in the prepared Codex home', () => {
    it.each(['prepareSessionIsolatedHome', 'prepareMcpFreeHome'] as const)('%s adds the broken server without touching ~/.codex', (prepare) => {
      startLiveTest();
      writeOverlay(BROKEN_SERVER);
      const home = fakeHome('model = "m"\n\n[mcp_servers.real]\ncommand = "real-binary"\n');
      const realConfig = join(home, '.codex', 'config.toml');
      const before = readFileSync(realConfig, 'utf-8');

      const manager = new CodexHomeManager();
      const generated = manager[prepare]();
      expect(generated).toBeTruthy();
      const config = readFileSync(join(generated!, 'config.toml'), 'utf-8');
      expect(config).toContain('[mcp_servers.broken_probe]');
      expect(lstatSync(join(generated!, 'config.toml')).isSymbolicLink()).toBe(false);
      expect(config.includes('[mcp_servers.real]')).toBe(prepare === 'prepareSessionIsolatedHome');
      expect(readFileSync(realConfig, 'utf-8')).toBe(before);

      manager.cleanup();
      expect(existsSync(generated!)).toBe(false);
    });

    it('keeps the overlay server beside an injected Browser Gateway config', () => {
      startLiveTest();
      writeOverlay(BROKEN_SERVER);
      fakeHome('model = "m"\n');
      const manager = new CodexHomeManager();
      const generated = manager.prepareHomeWithMcpConfig('[mcp_servers.browser_gateway]\ncommand = "node"\n', 'exec');
      const config = readFileSync(join(generated!, 'config.toml'), 'utf-8');
      expect(config).toContain('[mcp_servers.browser_gateway]');
      expect(config).toContain('[mcp_servers.broken_probe]');
      manager.cleanup();
    });

    it('creates the config for a user with no Codex directory', () => {
      startLiveTest();
      writeOverlay(BROKEN_SERVER);
      const home = mkdtempSync(join(tmpdir(), 'codex-overlay-nohome-'));
      dirs.push(home);
      process.env['HOME'] = home;
      const manager = new CodexHomeManager();
      const generated = manager.prepareSessionIsolatedHome();
      expect(readFileSync(join(generated!, 'config.toml'), 'utf-8')).toContain('[mcp_servers.broken_probe]');
      manager.cleanup();
    });

    it('refuses to prepare a home when the requested overlay is unusable', () => {
      startLiveTest();
      writeOverlay('model = "x"\n');
      fakeHome('model = "m"\n');
      const manager = new CodexHomeManager();
      expect(manager.prepareSessionIsolatedHome()).toBeNull();
    });

    it('leaves normal runs exactly as before', () => {
      fakeHome('model = "m"\n');
      const manager = new CodexHomeManager();
      const generated = manager.prepareSessionIsolatedHome();
      expect(lstatSync(join(generated!, 'config.toml')).isSymbolicLink()).toBe(true);
      manager.cleanup();
    });
  });
});
