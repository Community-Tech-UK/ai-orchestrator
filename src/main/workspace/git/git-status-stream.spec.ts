import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitStatusParser, readGitStatusPaths } from './git-status-stream';
import { hermeticGitEnv } from './git-env';
import { integrationOwnershipRef, promoteIntegrationBranch } from './worktree-integration';
import { GitWriteQueue } from './git-write-queue';

const spawnMock = vi.hoisted(() => vi.fn());
const nativeSpawn = vi.hoisted(() => ({ value: undefined as typeof childProcess.spawn | undefined }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  nativeSpawn.value = actual.spawn;
  spawnMock.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnMock, default: { ...actual, spawn: spawnMock } };
});
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  nativeSpawn.value = actual.spawn;
  spawnMock.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnMock, default: { ...actual, spawn: spawnMock } };
});

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const execFileAsync = promisify(execFile);
let directory: string;

beforeEach(() => {
  if (!nativeSpawn.value) throw new Error('Native spawn implementation was not loaded');
  spawnMock.mockReset().mockImplementation(nativeSpawn.value);
  directory = mkdtempSync(join(tmpdir(), 'git-status-stream-'));
  GitWriteQueue._resetForTesting();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { force: true, recursive: true });
});

function fakeGit(body: string): void {
  const script = join(directory, 'status-fixture.cjs');
  writeFileSync(script, body);
  const spawn = nativeSpawn.value;
  if (!spawn) throw new Error('Native spawn implementation was not loaded');
  // Retarget only status to a real Node subprocess. Promotion's ordinary Git
  // execFile calls continue to use the installed Git on every platform.
  spawnMock.mockImplementation((command: string, args: readonly string[], options: childProcess.SpawnOptions) =>
    command === 'git' && args[0] === 'status'
      ? spawn(process.execPath, [script, ...args], options)
      : spawn(command, args, options),
  );
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: directory, env: hermeticGitEnv(), encoding: 'utf8',
  });
  return stdout.trim();
}

describe('GitStatusParser', () => {
  it('preserves Unicode, BOM, spaces, newlines and leading/trailing whitespace across byte splits', () => {
    const paths: [string, string][] = [];
    const parser = new GitStatusParser((p, s) => paths.push([p, s]));
    const input = Buffer.from('??  café/🐈\nfile \0 M changed\0R  destination\0\uFEFFsource\0');
    for (const byte of input) parser.write(Buffer.from([byte]));
    parser.finish();
    expect(paths).toEqual([
      [' café/🐈\nfile ', '??'], ['changed', ' M'],
      ['destination', 'R '], ['\uFEFFsource', 'R '],
    ]);
  });

  it.each(['R ', ' R', 'C ', ' C', 'RM', 'MR', 'CM', 'MC'])(
    'includes both rename/copy paths for status %s', (status) => {
      const paths: string[] = [];
      const parser = new GitStatusParser((p) => paths.push(p));
      parser.write(Buffer.from(`${status} new\0old\0?? next\0`));
      parser.finish();
      expect(paths).toEqual(['new', 'old', 'next']);
    },
  );

  it.each(['?? truncated', 'R  target\0', ' R target\0'])('rejects truncated output %j', (input) => {
    const parser = new GitStatusParser(() => undefined);
    parser.write(Buffer.from(input));
    expect(() => parser.finish()).toThrow('ended inside a record');
  });

  it.each(['\0', '?? \0', 'ZZ bad\0', '?M bad\0', '  bad\0', 'R  new\0\0'])(
    'rejects malformed output %j', (input) => {
      expect(() => new GitStatusParser(() => undefined).write(Buffer.from(input))).toThrow();
    },
  );

  it('fails closed on invalid UTF-8 instead of replacing filename bytes', () => {
    const parser = new GitStatusParser(() => undefined);
    expect(() => parser.write(Buffer.from([63, 63, 32, 255, 0]))).toThrow();
  });

  it('bounds an unfinished field without imposing a total stream limit', () => {
    const parser = new GitStatusParser(() => undefined);
    parser.write(Buffer.alloc(1024 * 1024, 120));
    expect(() => parser.write(Buffer.from('x'))).toThrow('path safety limit');
  });
});

describe('readGitStatusPaths subprocess completion', () => {
  it.each(['reentrant-error', 'cannot-kill', 'throwing-kill'])(
    'settles timeout failure without waiting indefinitely when signalling fails: %s', async (mode) => {
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), { stdout, kill: vi.fn() });
      child.kill.mockImplementation(() => {
        if (mode === 'reentrant-error') child.emit('error', new Error('kill failed'));
        if (mode === 'throwing-kill') throw new Error('kill failed');
        return false;
      });
      spawnMock.mockReturnValueOnce(child as unknown as ReturnType<typeof childProcess.spawn>);
      const inspection = readGitStatusPaths(directory, () => undefined, 20);
      expect(spawnMock).toHaveBeenCalledWith('git', expect.any(Array), expect.any(Object));
      await expect(inspection).rejects.toThrow('timed out');
      expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
      expect(stdout.destroyed).toBe(true);
      // A later process error/close cannot recursively kill or change the failure.
      child.emit('error', new Error('late process error'));
      child.emit('close', 0, null);
      expect(child.kill).toHaveBeenCalledTimes(1);
    },
  );

  it('uses explicit NUL porcelain arguments and removes inherited repository-scoping env', async () => {
    vi.stubEnv('GIT_DIR', 'inherited-repository-placeholder');
    vi.stubEnv('GIT_INDEX_FILE', 'inherited-index-placeholder');
    fakeGit(`
      const correct = JSON.stringify(process.argv.slice(2)) === JSON.stringify(
        ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
      if (!correct || process.env.GIT_DIR || process.env.GIT_INDEX_FILE) process.exit(42);
      process.stdout.write('?? ordinary\\0');
    `);
    const paths: string[] = [];
    await readGitStatusPaths(directory, (p) => paths.push(p));
    expect(paths).toEqual(['ordinary']);
  });

  it('waits for the complete stream and successful exit after the first match', async () => {
    fakeGit(`
      process.stdout.write('?? first\\0');
      setTimeout(() => process.stdout.write('?? last\\0'), 40);
    `);
    const paths: string[] = [];
    await readGitStatusPaths(directory, (p) => paths.push(p));
    expect(paths).toEqual(['first', 'last']);
  });

  it('rejects a nonzero exit even after valid records were delivered', async () => {
    fakeGit("process.stdout.write('?? first\\0', () => process.exit(42));");
    const paths: string[] = [];
    await expect(readGitStatusPaths(directory, (p) => paths.push(p))).rejects.toThrow('inspection failed');
    expect(paths).toEqual(['first']);
  });

  it.each(['?? truncated', 'R  target\0', 'ZZ bad\0'])(
    'rejects a successful process with incomplete/malformed output %j', async (input) => {
      fakeGit(`process.stdout.write(${JSON.stringify(input)});`);
      await expect(readGitStatusPaths(directory, () => undefined)).rejects.toThrow();
    },
  );

  it('rejects signal termination', async () => {
    fakeGit("process.kill(process.pid, 'SIGTERM');");
    await expect(readGitStatusPaths(directory, () => undefined)).rejects.toThrow('inspection failed');
  });

  it('kills a stalled process and rejects on timeout', async () => {
    fakeGit("process.stdout.write('?? first\\0'); setInterval(() => {}, 1000);");
    await expect(readGitStatusPaths(directory, () => undefined, 250)).rejects.toThrow('timed out');
  });

  it('rejects spawn errors', async () => {
    const spawn = nativeSpawn.value;
    if (!spawn) throw new Error('Native spawn implementation was not loaded');
    spawnMock.mockImplementation((_command: string, args: readonly string[], options: childProcess.SpawnOptions) =>
      spawn(join(directory, 'absent-git-executable'), args, options),
    );
    await expect(readGitStatusPaths(directory, () => undefined)).rejects.toThrow();
  });

  it('rejects a path visitor error rather than treating partial inspection as success', async () => {
    fakeGit("process.stdout.write('?? first\\0'); setInterval(() => {}, 1000);");
    await expect(readGitStatusPaths(directory, () => { throw new Error('visitor failed'); }))
      .rejects.toThrow('visitor failed');
  });
});

describe('promotion with streamed status', () => {
  async function preparePromotion(): Promise<string> {
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.name', 'Test']);
    await git(['config', 'user.email', 'test@example.com']);
    writeFileSync(join(directory, 'base.txt'), 'base\n');
    await git(['add', 'base.txt']);
    await git(['commit', '-q', '--no-gpg-sign', '-m', 'base']);
    const before = await git(['rev-parse', 'HEAD']);
    await git(['checkout', '-q', '-b', 'integration/main']);
    writeFileSync(join(directory, 'promoted.txt'), 'new work\n');
    await git(['add', 'promoted.txt']);
    await git(['commit', '-q', '--no-gpg-sign', '-m', 'promotion']);
    await git(['update-ref', integrationOwnershipRef('integration/main'), 'HEAD']);
    await git(['checkout', '-q', 'main']);
    return before;
  }

  function largeStatus(lastRecord: string): void {
    fakeGit(`
      const record = '?? unrelated/' + 'x'.repeat(240) + '\\0';
      const block = record.repeat(256);
      // More than 10 MiB before the last record, exceeding the old ceiling.
      for (let i = 0; i < 192; i++) process.stdout.write(block);
      process.stdout.write(${JSON.stringify(lastRecord)});
    `);
  }

  it('blocks a final overlapping path after more than 10 MiB and preserves operator work', async () => {
    const before = await preparePromotion();
    writeFileSync(join(directory, 'promoted.txt'), 'operator version\n');
    largeStatus('?? promoted.txt\0');
    const result = await promoteIntegrationBranch(directory, 'main', 'integration/main', undefined, {
      dirtyRootPolicy: 'block-overlap',
    });
    expect(result).toEqual({ status: 'blocked',
      reason: 'root checkout has uncommitted changes to a promoted path: promoted.txt' });
    expect(await git(['rev-parse', 'HEAD'])).toBe(before);
    expect(readFileSync(join(directory, 'promoted.txt'), 'utf8')).toBe('operator version\n');
  });

  it('allows a large nonoverlapping status under block-overlap without touching operator files', async () => {
    await preparePromotion();
    writeFileSync(join(directory, 'operator.txt'), 'operator work\n');
    largeStatus('?? operator.txt\0');
    const result = await promoteIntegrationBranch(directory, 'main', 'integration/main', undefined, {
      dirtyRootPolicy: 'block-overlap',
    });
    expect(result.status).toBe('promoted');
    expect(readFileSync(join(directory, 'operator.txt'), 'utf8')).toBe('operator work\n');
    expect(readFileSync(join(directory, 'promoted.txt'), 'utf8')).toBe('new work\n');
  });

  it('still blocks unrelated large status under block-any', async () => {
    const before = await preparePromotion();
    largeStatus('?? operator.txt\0');
    await expect(promoteIntegrationBranch(directory, 'main', 'integration/main')).resolves.toEqual({
      status: 'blocked', reason: 'root checkout has uncommitted changes',
    });
    expect(await git(['rev-parse', 'HEAD'])).toBe(before);
  });

  it('excludes an untracked nested worktree under block-any without touching its files', async () => {
    await preparePromotion();
    const nested = join(directory, '.worktrees', 'nested with spaces');
    await git(['worktree', 'add', '--detach', nested, 'main']);
    writeFileSync(join(nested, 'operator.txt'), 'nested operator work\n');
    await expect(promoteIntegrationBranch(directory, 'main', 'integration/main'))
      .resolves.toMatchObject({ status: 'promoted' });
    expect(readFileSync(join(nested, 'operator.txt'), 'utf8')).toBe('nested operator work\n');
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: nested, env: hermeticGitEnv(), encoding: 'utf8',
    });
    expect(stdout.trim()).not.toBe(await git(['rev-parse', 'HEAD']));
  });

  it('preserves real unusual filenames during nonoverlapping promotion', async () => {
    await preparePromotion();
    const file = process.platform === 'win32' ? '猫 operator .txt' : '猫\n operator .txt';
    writeFileSync(join(directory, file), 'operator work\n');
    const paths: string[] = [];
    await readGitStatusPaths(directory, (p) => paths.push(p));
    expect(paths).toContain(file);
    await expect(promoteIntegrationBranch(directory, 'main', 'integration/main', undefined, {
      dirtyRootPolicy: 'block-overlap',
    })).resolves.toMatchObject({ status: 'promoted' });
    expect(readFileSync(join(directory, file), 'utf8')).toBe('operator work\n');
  });

  it.each(['R ', ' R', 'C ', ' C'])(
    'blocks an overlapping source path in status %s', async (status) => {
      const before = await preparePromotion();
      largeStatus(`${status} other.txt\0promoted.txt\0`);
      await expect(promoteIntegrationBranch(directory, 'main', 'integration/main', undefined, {
        dirtyRootPolicy: 'block-overlap',
      })).resolves.toEqual({ status: 'blocked',
        reason: 'root checkout has uncommitted changes to a promoted path: promoted.txt' });
      expect(await git(['rev-parse', 'HEAD'])).toBe(before);
    },
  );

  it('fails closed without moving HEAD when root status exits nonzero', async () => {
    const before = await preparePromotion();
    fakeGit("process.stdout.write('?? unrelated\\0', () => process.exit(42));");
    await expect(promoteIntegrationBranch(directory, 'main', 'integration/main')).resolves.toEqual({
      status: 'blocked', reason: 'unable to inspect root checkout status',
    });
    expect(await git(['rev-parse', 'HEAD'])).toBe(before);
  });

  it('fails closed without moving HEAD when the second status inspection fails', async () => {
    const before = await preparePromotion();
    const counter = join(directory, 'status-call-counter');
    fakeGit(`
      const {existsSync, writeFileSync} = require('node:fs');
      if (existsSync(${JSON.stringify(counter)})) process.exit(42);
      writeFileSync(${JSON.stringify(counter)}, 'first completed');
      process.stdout.write('?? unrelated\\0');
    `);
    await expect(promoteIntegrationBranch(directory, 'main', 'integration/main', undefined, {
      dirtyRootPolicy: 'block-overlap',
    })).resolves.toEqual({ status: 'blocked', reason: 'unable to compare root changes with the promotion' });
    expect(await git(['rev-parse', 'HEAD'])).toBe(before);
  });
});
