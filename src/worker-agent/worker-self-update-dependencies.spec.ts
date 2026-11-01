import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dependenciesMayDiffer, resolveNpmCli, workerNativeModulesLoaded } from './worker-self-update-dependencies';

describe('workerNativeModulesLoaded', () => {
  it('spots a loaded native binary on either path style', () => {
    expect(workerNativeModulesLoaded(['C:\\repo\\node_modules\\node-pty\\prebuilds\\win32-x64\\pty.node'])).toBe(true);
    expect(workerNativeModulesLoaded(['/repo/node_modules/better-sqlite3/build/Release/better_sqlite3.node'])).toBe(true);
  });

  it('does not count a module whose JavaScript loaded but whose binary did not', () => {
    // A worker that ran a session has better-sqlite3's lib/*.js in require.cache;
    // Windows only locks the binary, which loads on the first database open.
    expect(workerNativeModulesLoaded([
      'C:\\repo\\node_modules\\better-sqlite3\\lib\\index.js',
      'C:\\repo\\node_modules\\better-sqlite3\\lib\\database.js',
      '/repo/node_modules/node-pty/lib/index.js',
    ])).toBe(false);
  });

  it('ignores other modules, including look-alike names', () => {
    expect(workerNativeModulesLoaded([
      '/repo/node_modules/ws/index.js',
      '/repo/node_modules/node-pty-prebuilt/build/pty.node',
      '/repo/dist/worker-agent/index.js',
    ])).toBe(false);
  });
});

describe('resolveNpmCli', () => {
  it('finds npm beside node.exe, as on Windows and nvm4w', () => {
    const node = path.join('C:', 'nvm4w', 'nodejs', 'node.exe');
    const npm = path.join('C:', 'nvm4w', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    expect(resolveNpmCli(node, (p) => p === npm)).toBe(npm);
  });

  it('finds npm under the prefix lib directory, as on Unix', () => {
    const npm = path.join('/usr/local/bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    expect(resolveNpmCli('/usr/local/bin/node', (p) => p === npm)).toBe(npm);
  });

  it('returns null when npm is nowhere to be found', () => {
    expect(resolveNpmCli('/opt/node/bin/node', () => false)).toBeNull();
  });
});

describe('dependenciesMayDiffer', () => {
  const git = (code: number) => async (args: string[]) => {
    expect(args).toEqual(['diff', '--quiet', 'old', 'new', '--', 'package.json', 'package-lock.json']);
    return { code };
  };

  it('reads git diff: 0 unchanged, 1 changed, anything else changed too', async () => {
    expect(await dependenciesMayDiffer(git(0), 'old', 'new')).toBe(false);
    expect(await dependenciesMayDiffer(git(1), 'old', 'new')).toBe(true);
    expect(await dependenciesMayDiffer(git(128), 'old', 'new')).toBe(true);
  });

  it('counts an unknown install as changed and the same commit as unchanged, without asking git', async () => {
    const neverCalled = async () => { throw new Error('git should not run'); };
    expect(await dependenciesMayDiffer(neverCalled, null, 'new')).toBe(true);
    expect(await dependenciesMayDiffer(neverCalled, 'new', 'new')).toBe(false);
  });
});
