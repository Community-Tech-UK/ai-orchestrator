import { describe, expect, it } from 'vitest';
import { buildCliPath, getCliAdditionalPaths, shouldUseCliShell } from './cli-environment';

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

  it('requires shell execution on Windows for npm-installed wrappers', () => {
    expect(shouldUseCliShell('win32')).toBe(true);
    expect(shouldUseCliShell('darwin')).toBe(false);
  });
});
