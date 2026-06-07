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

  it('includes the Git-for-Windows toolchain dirs on Windows', () => {
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
        'C:\\Program Files\\Git\\cmd',
        'C:\\Program Files\\Git\\bin',
        'C:\\Users\\User\\AppData\\Local\\Microsoft\\WindowsApps',
      ]),
    );
  });

  it('includes Ollama Windows install directories for stripped Electron and worker PATHs', () => {
    const env = {
      LOCALAPPDATA: 'C:\\Users\\User\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      USERPROFILE: 'C:\\Users\\User',
    } as NodeJS.ProcessEnv;

    expect(getCliAdditionalPaths(env, 'win32')).toEqual(
      expect.arrayContaining([
        'C:\\Users\\User\\AppData\\Local\\Programs\\Ollama',
        'C:\\Program Files\\Ollama',
        'C:\\Program Files (x86)\\Ollama',
      ]),
    );
  });

  it('keeps $HOME-relative node/npm bin dirs on Windows (bash-style nvm installs node + the agent CLI there)', () => {
    // Regression guard: dropping these on Windows broke worker spawn because
    // `C:\Users\x/.nvm/versions/node/current/bin` (forward slashes resolve on
    // Windows) is where node and the agent CLI wrapper actually live on a
    // bash-nvm dev box. They must remain in the Windows search set.
    const env = {
      APPDATA: 'C:\\Users\\User\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\User\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      PATH: 'C:\\Windows\\System32',
      USERPROFILE: 'C:\\Users\\User',
      HOME: 'C:\\Users\\User',
    } as NodeJS.ProcessEnv;

    expect(getCliAdditionalPaths(env, 'win32')).toEqual(
      expect.arrayContaining([
        'C:\\Users\\User/.nvm/versions/node/current/bin',
        'C:\\Users\\User/.npm-global/bin',
      ]),
    );
  });

  it('includes the nvm-windows active-version symlink so node/npm resolve on Windows', () => {
    // nvm-windows exposes the active node via %NVM_SYMLINK% (a user-chosen
    // path like C:\nvm4w\nodejs, NOT C:\Program Files\nodejs). It must be on
    // PATH and must precede the WindowsApps Store-alias dir so bare `node`/
    // `npm` resolve to the real interpreter. Observed live on windows-pc:
    // node v24.11.0 was installed via nvm-windows but never on the worker PATH.
    const env = {
      LOCALAPPDATA: 'C:\\Users\\User\\AppData\\Local',
      NVM_HOME: 'C:\\Users\\User\\AppData\\Local\\nvm',
      NVM_SYMLINK: 'C:\\nvm4w\\nodejs',
      USERPROFILE: 'C:\\Users\\User',
    } as NodeJS.ProcessEnv;

    const paths = getCliAdditionalPaths(env, 'win32');
    const symlinkIdx = paths.indexOf('C:\\nvm4w\\nodejs');
    const windowsAppsIdx = paths.indexOf('C:\\Users\\User\\AppData\\Local\\Microsoft\\WindowsApps');

    expect(symlinkIdx).toBeGreaterThanOrEqual(0);
    expect(windowsAppsIdx).toBeGreaterThanOrEqual(0);
    expect(symlinkIdx).toBeLessThan(windowsAppsIdx);
  });

  it('includes core Windows system dirs so a minimal-PATH worker can resolve system tools', () => {
    // Observed live on windows-pc: a detached worker inherited PATH of just
    // `C:\Program Files\PowerShell\7`, so the spawned agent could not run
    // cmd/where/reg/ipconfig. These dirs always exist on Windows; adding them
    // makes the worker robust to a stripped launch PATH.
    const env = {
      ProgramFiles: 'C:\\Program Files',
      USERPROFILE: 'C:\\Users\\User',
      SystemRoot: 'C:\\Windows',
    } as NodeJS.ProcessEnv;

    expect(getCliAdditionalPaths(env, 'win32')).toEqual(
      expect.arrayContaining([
        'C:\\Windows\\System32',
        'C:\\Windows\\System32\\Wbem',
      ]),
    );
  });

  it('falls back to C:\\Windows when SystemRoot/windir are unset on win32', () => {
    const env = { USERPROFILE: 'C:\\Users\\User' } as NodeJS.ProcessEnv;

    expect(getCliAdditionalPaths(env, 'win32')).toContain('C:\\Windows\\System32');
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

  it('preserves Windows Path casing while expanding command lookup directories', () => {
    const env = {
      APPDATA: 'C:\\Users\\User\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\User\\AppData\\Local',
      Path: 'C:\\Existing\\Bin',
      USERPROFILE: 'C:\\Users\\User',
    } as NodeJS.ProcessEnv;

    const builtEnv = buildCliEnv(env, 'win32');

    expect(builtEnv['PATH']).toContain('C:\\Users\\User\\AppData\\Local\\Programs\\Ollama');
    expect(builtEnv['PATH']).toContain(';C:\\Existing\\Bin');
    expect(builtEnv['Path']).toBe(builtEnv['PATH']);
  });
});
