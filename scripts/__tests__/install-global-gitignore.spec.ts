import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

interface ResolveOptions {
  execFileSync?: (command: string, args: string[], opts?: unknown) => string;
  env?: Record<string, string | undefined>;
  homedir?: string;
}

interface InstallOptions extends ResolveOptions {
  targetPath?: string;
  readFileSync?: (file: string, encoding: string) => string;
  writeFileSync?: (file: string, contents: string, encoding: string) => void;
  mkdirSync?: (dir: string, opts?: unknown) => void;
  existsSync?: (file: string) => boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

interface InstallResult {
  updated: boolean;
  reason?: string;
  path?: string;
  added?: string[];
}

const { MANAGED_PATTERNS, expandHome, resolveGlobalIgnorePath, installGlobalGitignore } =
  require('../install-global-gitignore.js') as {
    MANAGED_PATTERNS: string[];
    expandHome: (filePath: string, homedir: string) => string;
    resolveGlobalIgnorePath: (options?: ResolveOptions) => string;
    installGlobalGitignore: (options?: InstallOptions) => InstallResult;
  };

describe('install-global-gitignore: expandHome', () => {
  it('expands a bare tilde and tilde-prefixed paths', () => {
    expect(expandHome('~', '/home/me')).toBe('/home/me');
    expect(expandHome('~/foo/bar', '/home/me')).toBe(path.join('/home/me', 'foo/bar'));
  });

  it('leaves absolute and relative paths untouched', () => {
    expect(expandHome('/etc/gitignore', '/home/me')).toBe('/etc/gitignore');
    expect(expandHome('sub/ignore', '/home/me')).toBe('sub/ignore');
  });
});

describe('install-global-gitignore: resolveGlobalIgnorePath', () => {
  it('honours a configured core.excludesfile', () => {
    const resolved = resolveGlobalIgnorePath({
      execFileSync: () => '~/dotfiles/gitignore\n',
      homedir: '/home/me',
    });
    expect(resolved).toBe(path.join('/home/me', 'dotfiles/gitignore'));
  });

  it('falls back to XDG_CONFIG_HOME when config is unset', () => {
    const resolved = resolveGlobalIgnorePath({
      execFileSync: () => '',
      env: { XDG_CONFIG_HOME: '/xdg' },
      homedir: '/home/me',
    });
    expect(resolved).toBe(path.join('/xdg', 'git', 'ignore'));
  });

  it('falls back to ~/.config/git/ignore when config and XDG are unset', () => {
    const resolved = resolveGlobalIgnorePath({
      execFileSync: () => {
        throw new Error('exit 1'); // git config exits non-zero when unset
      },
      env: {},
      homedir: '/home/me',
    });
    expect(resolved).toBe(path.join('/home/me', '.config', 'git', 'ignore'));
  });
});

describe('install-global-gitignore: installGlobalGitignore', () => {
  it('appends missing managed patterns to an existing file', () => {
    const writes: { file: string; contents: string }[] = [];
    const result = installGlobalGitignore({
      targetPath: '/home/me/.config/git/ignore',
      existsSync: () => true,
      readFileSync: () => 'node_modules/\n.DS_Store\n',
      writeFileSync: (file, contents) => writes.push({ file, contents }),
      mkdirSync: () => undefined,
      log: () => undefined,
      warn: () => undefined,
    });

    expect(result.updated).toBe(true);
    expect(result.added).toEqual(MANAGED_PATTERNS);
    expect(writes).toHaveLength(1);
    for (const pattern of MANAGED_PATTERNS) {
      expect(writes[0].contents).toContain(pattern);
    }
    // Preserves prior content.
    expect(writes[0].contents).toContain('node_modules/');
  });

  it('is idempotent when every managed pattern is already present', () => {
    const writes: string[] = [];
    const result = installGlobalGitignore({
      targetPath: '/home/me/.config/git/ignore',
      existsSync: () => true,
      readFileSync: () => `# something\n${MANAGED_PATTERNS.join('\n')}\n`,
      writeFileSync: (_file, contents) => writes.push(contents),
      mkdirSync: () => undefined,
      log: () => undefined,
      warn: () => undefined,
    });

    expect(result).toMatchObject({ updated: false, reason: 'already-present' });
    expect(writes).toEqual([]);
  });

  it('creates the file (and directory) when none exists yet', () => {
    let madeDir = '';
    const writes: string[] = [];
    const result = installGlobalGitignore({
      targetPath: '/home/me/.config/git/ignore',
      existsSync: () => false,
      readFileSync: () => {
        throw new Error('should not read a missing file');
      },
      writeFileSync: (_file, contents) => writes.push(contents),
      mkdirSync: (dir) => {
        madeDir = String(dir);
      },
      log: () => undefined,
      warn: () => undefined,
    });

    expect(result.updated).toBe(true);
    expect(madeDir).toBe(path.dirname('/home/me/.config/git/ignore'));
    expect(writes).toHaveLength(1);
    for (const pattern of MANAGED_PATTERNS) {
      expect(writes[0]).toContain(pattern);
    }
  });

  it('inserts a separating newline when the existing file lacks a trailing newline', () => {
    const writes: string[] = [];
    installGlobalGitignore({
      targetPath: '/home/me/.config/git/ignore',
      existsSync: () => true,
      readFileSync: () => '.DS_Store', // no trailing newline
      writeFileSync: (_file, contents) => writes.push(contents),
      mkdirSync: () => undefined,
      log: () => undefined,
      warn: () => undefined,
    });

    expect(writes[0].startsWith('.DS_Store\n\n')).toBe(true);
  });

  it('reports a failure instead of throwing when the write fails', () => {
    const result = installGlobalGitignore({
      targetPath: '/home/me/.config/git/ignore',
      existsSync: () => false,
      writeFileSync: () => {
        throw new Error('EACCES');
      },
      mkdirSync: () => undefined,
      log: () => undefined,
      warn: () => undefined,
    });

    expect(result).toMatchObject({ updated: false, reason: 'write-failed' });
  });
});
