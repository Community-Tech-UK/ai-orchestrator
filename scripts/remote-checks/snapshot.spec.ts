import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

interface Snapshot { commit: string; tree: string; env: NodeJS.ProcessEnv; cleanup(): void }
const require = createRequire(import.meta.url);
const { SnapshotRefused, takeSnapshot, takeStagedSnapshot } = require('./snapshot.js') as {
  SnapshotRefused: new (message: string) => Error;
  takeSnapshot(root: string, options?: { maxUntrackedBytes?: number; baseEnv?: NodeJS.ProcessEnv }): Snapshot;
  takeStagedSnapshot(root: string, options?: { baseEnv?: NodeJS.ProcessEnv }): Snapshot;
};

const temps: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-spec-'));
  temps.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();

function repo(): string {
  const dir = temp();
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(dir, 'tracked.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  return dir;
}

/** Every file under `dir`, by content, so any write at all shows up. */
function fingerprint(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else files[relative(dir, full)] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return files;
}

function filesIn(root: string, snapshot: { tree: string; env: NodeJS.ProcessEnv }): string[] {
  return execFileSync('git', ['ls-tree', '-r', '--name-only', snapshot.tree], { cwd: root, env: snapshot.env, encoding: 'utf8' })
    .split('\n').filter(Boolean);
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('takeSnapshot', () => {
  it('leaves the index, refs and object store byte-for-byte as they were', () => {
    const root = repo();
    writeFileSync(join(root, 'tracked.txt'), 'changed\n');
    writeFileSync(join(root, 'new.txt'), 'new\n');
    const before = fingerprint(join(root, '.git'));
    const status = git(root, 'status', '--short');

    const snapshot = takeSnapshot(root);
    snapshot.cleanup();

    expect(fingerprint(join(root, '.git'))).toEqual(before);
    expect(git(root, 'status', '--short')).toBe(status);
  });

  it('does the same in a linked worktree, including the shared repository', () => {
    const root = repo();
    const linked = join(temp(), 'linked');
    git(root, 'worktree', 'add', '-q', '--detach', linked);
    writeFileSync(join(linked, 'new.txt'), 'new\n');
    const before = fingerprint(join(root, '.git'));

    const snapshot = takeSnapshot(linked);
    expect(filesIn(linked, snapshot)).toContain('new.txt');
    snapshot.cleanup();

    expect(fingerprint(join(root, '.git'))).toEqual(before);
  });

  it('captures uncommitted and untracked files, and leaves out ignored ones', () => {
    const root = repo();
    writeFileSync(join(root, 'tracked.txt'), 'changed\n');
    writeFileSync(join(root, 'untracked.txt'), 'new\n');
    writeFileSync(join(root, 'ignored.txt'), 'private\n');

    const snapshot = takeSnapshot(root);

    expect(filesIn(root, snapshot).sort()).toEqual(['.gitignore', 'tracked.txt', 'untracked.txt']);
    expect(execFileSync('git', ['cat-file', 'blob', `${snapshot.tree}:tracked.txt`], { cwd: root, env: snapshot.env, encoding: 'utf8' }))
      .toBe('changed\n');
    snapshot.cleanup();
  });

  it('leaves out secret-looking names, at any depth', () => {
    const root = repo();
    mkdirSync(join(root, 'deep/er'), { recursive: true });
    for (const name of ['.env', '.env.local', 'deep/er/server.pem', 'deep/KEY.PEM', 'deep/private.key', 'deep/id_ed25519',
      'deep/cert.p12', 'deep/.netrc', 'deep/credentials.json']) {
      writeFileSync(join(root, name), 'not for the far machine\n');
    }
    writeFileSync(join(root, 'deep/keep.txt'), 'fine\n');

    const snapshot = takeSnapshot(root);

    expect(filesIn(root, snapshot).sort()).toEqual(['.gitignore', 'deep/keep.txt', 'tracked.txt']);
    snapshot.cleanup();
  });

  it('does not count secret-looking files towards the size limit, since they are not sent', () => {
    const root = repo();
    writeFileSync(join(root, 'huge.key'), Buffer.alloc(4096));
    const snapshot = takeSnapshot(root, { maxUntrackedBytes: 1024 });
    expect(filesIn(root, snapshot)).not.toContain('huge.key');
    snapshot.cleanup();
  });

  it('clears out a snapshot a killed run left behind, and leaves recent ones', () => {
    const root = repo();
    const old = mkdtempSync(join(tmpdir(), 'aio-snapshot-'));
    const recent = mkdtempSync(join(tmpdir(), 'aio-snapshot-'));
    temps.push(recent);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(old, twoDaysAgo, twoDaysAgo);

    takeSnapshot(root).cleanup();

    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it('refuses an embedded repository rather than silently emptying it', () => {
    const root = repo();
    const nested = join(root, 'nested');
    mkdirSync(nested);
    git(nested, 'init', '-q');
    writeFileSync(join(nested, 'work.txt'), 'real work\n');
    git(nested, 'add', '-A');
    git(nested, 'commit', '-qm', 'nested');

    expect(() => takeSnapshot(root)).toThrow(SnapshotRefused);
  });

  it('refuses oversized untracked files before hashing them', () => {
    const root = repo();
    writeFileSync(join(root, 'big.bin'), Buffer.alloc(4096));
    const before = fingerprint(join(root, '.git'));

    expect(() => takeSnapshot(root, { maxUntrackedBytes: 1024 })).toThrow(/over/);
    expect(fingerprint(join(root, '.git'))).toEqual(before);
  });

  it('ignores git settings a hook exported, which would aim it at the real index', () => {
    const root = repo();
    writeFileSync(join(root, 'new.txt'), 'new\n');
    const before = fingerprint(join(root, '.git'));

    const snapshot = takeSnapshot(root, {
      baseEnv: { ...process.env, GIT_DIR: join(root, '.git'), GIT_INDEX_FILE: join(root, '.git', 'index') },
    });
    snapshot.cleanup();

    expect(fingerprint(join(root, '.git'))).toEqual(before);
  });

  it('stays a complete, valid tree while a file is being replaced', async () => {
    const root = repo();
    const version = (i: number): string => `version ${i}\n`.repeat(2000);
    const versions = Array.from({ length: 40 }, (_, i) => version(i));
    const writer = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      let i = 0;
      const timer = setInterval(() => {
        fs.writeFileSync('racing.tmp', \`version \${i++ % ${versions.length}}\\n\`.repeat(2000));
        fs.renameSync('racing.tmp', 'racing.txt');
      }, 1);
      setTimeout(() => { clearInterval(timer); process.exit(0); }, 1500);
    `], { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, 'racing.txt'), versions[0]);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      let snapshot: Snapshot;
      try {
        snapshot = takeSnapshot(root);
      } catch {
        // git refusing a file that vanished under it is a safe outcome: the run falls back.
        continue;
      }
      execFileSync('git', ['fsck', '--no-dangling', snapshot.commit], { cwd: root, env: snapshot.env, stdio: 'ignore' });
      const content = execFileSync('git', ['cat-file', 'blob', `${snapshot.tree}:racing.txt`], { cwd: root, env: snapshot.env, encoding: 'utf8' });
      expect(versions).toContain(content);
      snapshot.cleanup();
    }
    await new Promise(resolve => writer.on('close', resolve));
    renameSync(join(root, 'racing.txt'), join(root, 'done.txt'));
  }, 30_000);
});

describe('takeStagedSnapshot', () => {
  const fileIn = (root: string, snapshot: Snapshot, name: string): string =>
    execFileSync('git', ['cat-file', 'blob', `${snapshot.tree}:${name}`], { cwd: root, env: snapshot.env, encoding: 'utf8' });

  it('captures what is staged, not what is on disk', () => {
    const root = repo();
    writeFileSync(join(root, 'tracked.txt'), 'staged\n');
    writeFileSync(join(root, 'staged-new.txt'), 'staged new\n');
    git(root, 'add', 'tracked.txt', 'staged-new.txt');
    writeFileSync(join(root, 'tracked.txt'), 'another session is editing this\n');
    writeFileSync(join(root, 'untracked.txt'), 'not part of this commit\n');

    const snapshot = takeStagedSnapshot(root);

    expect(fileIn(root, snapshot, 'tracked.txt')).toBe('staged\n');
    expect(filesIn(root, snapshot)).toEqual(['.gitignore', 'staged-new.txt', 'tracked.txt']);
    snapshot.cleanup();
  });

  it('matches the tree a commit of the index would make', () => {
    const root = repo();
    writeFileSync(join(root, 'tracked.txt'), 'staged\n');
    git(root, 'add', 'tracked.txt');
    writeFileSync(join(root, 'tracked.txt'), 'later edit\n');

    const snapshot = takeStagedSnapshot(root);
    snapshot.cleanup();
    git(root, 'commit', '-qm', 'next');

    expect(snapshot.tree).toBe(git(root, 'rev-parse', 'HEAD^{tree}'));
  });

  it('leaves the index, refs and object store byte-for-byte as they were', () => {
    const root = repo();
    writeFileSync(join(root, 'tracked.txt'), 'staged\n');
    git(root, 'add', 'tracked.txt');
    const before = fingerprint(join(root, '.git'));

    takeStagedSnapshot(root).cleanup();

    expect(fingerprint(join(root, '.git'))).toEqual(before);
  });

  it('reads the index a hook was given, relative or absolute, over the real one', () => {
    const root = repo();
    writeFileSync(join(root, 'tracked.txt'), 'in the real index\n');
    git(root, 'add', 'tracked.txt');
    const other = join(root, '.git', 'next-index-1.lock');
    const env = { ...process.env, GIT_INDEX_FILE: other };
    execFileSync('git', ['read-tree', 'HEAD'], { cwd: root, env });

    for (const named of [other, relative(root, other)]) {
      const snapshot = takeStagedSnapshot(root, { baseEnv: { ...process.env, GIT_INDEX_FILE: named } });
      expect(fileIn(root, snapshot, 'tracked.txt')).toBe('one\n');
      snapshot.cleanup();
    }
  });

  it('refuses a staged file with a secret-looking name rather than sending it', () => {
    const root = repo();
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config/.ENV'), 'SETTING=placeholder\n');
    git(root, 'add', 'config/.ENV');
    expect(() => takeStagedSnapshot(root)).toThrow(SnapshotRefused);
    expect(() => takeStagedSnapshot(root)).toThrow(/config\/\.ENV/);
  });

  it('ignores a secret-looking file that is only on disk, or is being deleted', () => {
    const root = repo();
    writeFileSync(join(root, 'old.key'), 'placeholder\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'tracked key');
    git(root, 'rm', '-q', 'old.key');
    writeFileSync(join(root, '.env'), 'SETTING=placeholder\n');

    const snapshot = takeStagedSnapshot(root);

    expect(filesIn(root, snapshot)).not.toContain('.env');
    snapshot.cleanup();
  });

  it('works in a linked worktree', () => {
    const root = repo();
    const linked = join(temp(), 'linked');
    git(root, 'worktree', 'add', '-q', '--detach', linked);
    writeFileSync(join(linked, 'tracked.txt'), 'staged in the worktree\n');
    git(linked, 'add', 'tracked.txt');
    writeFileSync(join(linked, 'tracked.txt'), 'later\n');

    const snapshot = takeStagedSnapshot(linked);

    expect(fileIn(linked, snapshot, 'tracked.txt')).toBe('staged in the worktree\n');
    snapshot.cleanup();
  });
});
