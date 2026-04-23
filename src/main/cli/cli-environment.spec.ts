import { describe, expect, it } from 'vitest';
import {
  buildCliEnv,
  buildCliPath,
  buildCliSpawnOptions,
  getCliAdditionalPaths,
  shouldUseCliShell,
} from './cli-environment';

describe('cli-environment', () => {
  it('adds npm global directories for Windows CLI wrappers', () => {
    const env = {
      APPDATA: 'C:\\Users\\User\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\User\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      PATH: 'C:\\Windows\\System32',
      USERPROFILE: 'C:\\Users\\User',
    } as NodeJS.ProcessEnv;

    expect(getCliAdditionalPaths(env, 'win32')).toEqual(
      expect.arrayContaining([
        'C:\\Users\\User\\AppData\\Roaming\\npm',
        'C:\\Users\\User\\AppData\\Local\\Programs\\nodejs',
        'C:\\Program Files\\nodejs',
        'C:\\Program Files (x86)\\nodejs',
      ]),
    );
    expect(buildCliPath(env, 'win32')).toContain(';C:\\Windows\\System32');
  });

  it('uses standard POSIX search paths on Unix-like platforms', () => {
    const env = {
      HOME: '/Users/alice',
      PATH: '/usr/bin:/bin',
    } as NodeJS.ProcessEnv;

    expect(getCliAdditionalPaths(env, 'darwin')).toEqual(
      expect.arrayContaining([
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/Users/alice/.local/bin',
      ]),
    );
    expect(buildCliPath(env, 'darwin')).toContain(':/usr/bin:/bin');
  });

  it('prefers nvm and user-managed bin dirs over Homebrew on POSIX', () => {
    // Regression: a forgotten Homebrew-npm copy of a CLI (e.g. codex 0.97.0
    // at /opt/homebrew/bin) used to shadow the user's current nvm install
    // because /opt/homebrew/bin came first in PATH. User-managed installs
    // must win.
    const env = {
      HOME: '/Users/alice',
      PATH: '/usr/bin:/bin',
    } as NodeJS.ProcessEnv;

    const paths = getCliAdditionalPaths(env, 'darwin');
    const nvmCurrentIdx = paths.indexOf('/Users/alice/.nvm/versions/node/current/bin');
    const npmGlobalIdx = paths.indexOf('/Users/alice/.npm-global/bin');
    const localBinIdx = paths.indexOf('/Users/alice/.local/bin');
    const homebrewIdx = paths.indexOf('/opt/homebrew/bin');

    expect(nvmCurrentIdx).toBeGreaterThanOrEqual(0);
    expect(homebrewIdx).toBeGreaterThanOrEqual(0);
    expect(nvmCurrentIdx).toBeLessThan(homebrewIdx);
    expect(npmGlobalIdx).toBeLessThan(homebrewIdx);
    expect(localBinIdx).toBeLessThan(homebrewIdx);
  });

  it('requires shell execution on Windows for npm-installed wrappers', () => {
    expect(shouldUseCliShell('win32')).toBe(true);
    expect(shouldUseCliShell('darwin')).toBe(false);
  });

  it('builds spawn options that combine PATH expansion and Windows shell handling', () => {
    const env = {
      APPDATA: 'C:\\Users\\User\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\User\\AppData\\Local',
      PATH: 'C:\\Windows\\System32',
      USERPROFILE: 'C:\\Users\\User',
    } as NodeJS.ProcessEnv;

    const builtEnv = buildCliEnv(env, 'win32');
    const spawnOptions = buildCliSpawnOptions(env, 'win32');

    expect(builtEnv['PATH']).toContain('C:\\Users\\User\\AppData\\Roaming\\npm');
    expect(spawnOptions).toMatchObject({
      env: builtEnv,
      shell: true,
      windowsHide: true,
    });
  });
});
