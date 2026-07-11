import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hermeticGitEnv } from '../workspace/git/git-env';
import {
  LOCAL_REVIEW_TOOL_DEFINITIONS,
  type LocalReviewToolCall,
} from './local-review.types';
import { LocalReviewToolRunner } from './local-review-tool-runner';

const execFileAsync = promisify(execFile);

describe('LocalReviewToolRunner', () => {
  let sandboxPath: string;
  let workspacePath: string;
  let runner: LocalReviewToolRunner;

  beforeEach(async () => {
    sandboxPath = await mkdtemp(path.join(tmpdir(), 'aio-local-review-'));
    workspacePath = path.join(sandboxPath, 'workspace');
    const outsidePath = path.join(sandboxPath, 'outside');
    await mkdir(path.join(workspacePath, 'src'), { recursive: true });
    await mkdir(outsidePath);
    await writeFile(path.join(workspacePath, 'src', 'a.ts'), 'export const value = 1;\n');
    await writeFile(path.join(workspacePath, '.env'), 'API_KEY=do-not-read\n');
    await writeFile(path.join(workspacePath, 'credentials.json'), '{"token":"do-not-read"}\n');
    await writeFile(path.join(outsidePath, 'secret.txt'), 'outside secret\n');
    await writeFile(path.join(outsidePath, 'public.txt'), 'symlink-escape-marker\n');
    await symlink(outsidePath, path.join(workspacePath, 'escape'), 'dir');

    await git(['init']);
    await git(['config', 'user.email', 'review-tests@example.invalid']);
    await git(['config', 'user.name', 'Review Tests']);
    await git(['add', '-f', 'src/a.ts', '.env', 'credentials.json']);
    await git(['commit', '-m', 'fixture baseline']);
    runner = new LocalReviewToolRunner(workspacePath);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(sandboxPath, { recursive: true, force: true });
  });

  it('defines exactly the five read-only repository tools with closed input schemas', () => {
    expect(LOCAL_REVIEW_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'workspace_list',
      'workspace_search',
      'workspace_read',
      'workspace_diff',
      'workspace_status',
    ]);
    for (const definition of LOCAL_REVIEW_TOOL_DEFINITIONS) {
      expect(definition.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      expect(definition).not.toHaveProperty('command');
      expect(definition).not.toHaveProperty('handler');
    }
    const listSchema = LOCAL_REVIEW_TOOL_DEFINITIONS[0].inputSchema;
    const searchSchema = LOCAL_REVIEW_TOOL_DEFINITIONS[1].inputSchema;
    const readSchema = LOCAL_REVIEW_TOOL_DEFINITIONS[2].inputSchema;
    expect(listSchema).toMatchObject({ properties: { path: { maxLength: 4_096 } } });
    expect(searchSchema).toMatchObject({
      properties: {
        path: { maxLength: 4_096 },
        glob: { maxLength: 1_024 },
      },
    });
    expect(readSchema).toMatchObject({
      properties: {
        path: { maxLength: 4_096 },
        endLine: { description: expect.stringContaining('400') },
      },
    });
  });

  it('reads a normal workspace-relative file', async () => {
    await expect(runner.execute({
      name: 'workspace_read',
      arguments: { path: 'src/a.ts' },
    })).resolves.toMatchObject({ ok: true, content: 'export const value = 1;\n' });
  });

  it.each(['workspace_read', 'workspace_search'] as const)(
    'rejects a repository FIFO promptly during %s',
    async (toolName) => {
      if (process.platform === 'win32') return;
      const fifoPath = path.join(workspacePath, 'src', `${toolName}.fifo`);
      await execFileAsync('mkfifo', [fifoPath]);
      const fifoRunner = new LocalReviewToolRunner(workspacePath, { operationTimeoutMs: 2_000 });
      const pending = fifoRunner.execute(toolName === 'workspace_read'
        ? { name: toolName, arguments: { path: path.relative(workspacePath, fifoPath) } }
        : { name: toolName, arguments: { path: 'src', query: 'needle' } });

      const result = await Promise.race([
        pending,
        delay(250).then(() => 'still-pending' as const),
      ]);
      if (result === 'still-pending') {
        await writeFile(fifoPath, '');
        await pending;
      }

      expect(result).toMatchObject(toolName === 'workspace_read'
        ? { ok: false, code: 'not-file' }
        : { ok: true, content: '' });
    },
  );

  it.each(['workspace_read', 'workspace_list', 'workspace_search'] as const)(
    'does not release output when %s has a coordinated directory symlink swap',
    async (toolName) => {
      const racePath = path.join(workspacePath, 'race');
      const savedPath = path.join(workspacePath, 'race-saved');
      const outsidePath = path.join(sandboxPath, 'race-outside');
      await mkdir(racePath);
      await mkdir(outsidePath);
      await writeFile(path.join(racePath, 'inside.txt'), 'inside-marker\n');
      await writeFile(path.join(outsidePath, 'outside.txt'), 'outside-race-marker\n');
      await writeFile(path.join(outsidePath, 'inside.txt'), 'outside-race-marker\n');
      await git(['add', 'race/inside.txt']);
      await git(['commit', '-m', 'race fixture']);
      let swapped = false;
      let restored = false;
      const raceRunner = new LocalReviewToolRunner(workspacePath, {
        pathOperationHook: async ({ operation, phase }) => {
          if (operation !== toolName.replace('workspace_', '') || phase === 'validated' && swapped) return;
          if (phase === 'validated') {
            await rename(racePath, savedPath);
            await symlink(outsidePath, racePath, 'dir');
            swapped = true;
          } else if (phase === 'before-release' && swapped && !restored) {
            await unlink(racePath);
            await rename(savedPath, racePath);
            restored = true;
          }
        },
      });
      const call: LocalReviewToolCall = toolName === 'workspace_read'
        ? { name: toolName, arguments: { path: 'race/inside.txt' } }
        : toolName === 'workspace_list'
          ? { name: toolName, arguments: { path: 'race' } }
          : { name: toolName, arguments: { path: 'race', query: 'marker' } };

      const result = await raceRunner.execute(call);

      expect(swapped).toBe(true);
      expect(JSON.stringify(result)).not.toContain('outside-race-marker');
      expect(JSON.stringify(result)).not.toContain('outside.txt');
      if (swapped && !restored) {
        await unlink(racePath);
        await rename(savedPath, racePath);
      }
    },
  );

  it('denies a coordinated workspace-root swap and withholds outside output', async () => {
    const savedRoot = `${workspacePath}-saved`;
    const outsideRoot = path.join(sandboxPath, 'outside-root');
    await mkdir(path.join(outsideRoot, 'src'), { recursive: true });
    await writeFile(path.join(outsideRoot, 'src', 'a.ts'), 'outside-root-marker\n');
    let swapped = false;
    const rootRaceRunner = new LocalReviewToolRunner(workspacePath, {
      rootOperationHook: async ({ phase }) => {
        if (phase === 'before-operation' && !swapped) {
          await rename(workspacePath, savedRoot);
          await symlink(outsideRoot, workspacePath, 'dir');
          swapped = true;
        } else if (phase === 'before-release' && swapped) {
          await unlink(workspacePath);
          await rename(savedRoot, workspacePath);
        }
      },
    });

    const result = await rootRaceRunner.execute({ name: 'workspace_read', arguments: { path: 'src/a.ts' } });

    expect(swapped).toBe(true);
    expect(result).toMatchObject({ ok: false, code: 'path-denied' });
    expect(JSON.stringify(result)).not.toContain('outside-root-marker');
    if (await lstat(workspacePath).then((value) => value.isSymbolicLink()).catch(() => false)) {
      await unlink(workspacePath);
      await rename(savedRoot, workspacePath);
    }
  });

  it('detects a swap between realpath and lstat path primitives', async () => {
    const gapPath = path.join(workspacePath, 'gap');
    const savedPath = path.join(workspacePath, 'gap-saved');
    const outsidePath = path.join(sandboxPath, 'gap-outside');
    await mkdir(gapPath);
    await mkdir(outsidePath);
    await writeFile(path.join(gapPath, 'file.txt'), 'inside-gap\n');
    await writeFile(path.join(outsidePath, 'file.txt'), 'outside-gap-marker\n');
    let swapped = false;
    let restored = false;
    const gapRunner = new LocalReviewToolRunner(workspacePath, {
      pathPrimitiveHook: async ({ path: requestedPath, phase }) => {
        if (requestedPath !== 'gap/file.txt') return;
        if (phase === 'after-realpath' && !swapped) {
          await rename(gapPath, savedPath);
          await symlink(outsidePath, gapPath, 'dir');
          swapped = true;
        } else if (phase === 'after-lstat' && swapped && !restored) {
          await unlink(gapPath);
          await rename(savedPath, gapPath);
          restored = true;
        }
      },
    });

    const result = await gapRunner.execute({ name: 'workspace_read', arguments: { path: 'gap/file.txt' } });

    expect(swapped).toBe(true);
    expect(result).toMatchObject({ ok: false, code: 'path-denied' });
    expect(JSON.stringify(result)).not.toContain('outside-gap-marker');
  });

  it.each([
    '../outside/secret.txt',
    'escape/secret.txt',
    'escape/missing.txt',
  ])('denies traversal or symlink escape through %s', async (requestedPath) => {
    await expect(runner.execute({
      name: 'workspace_read',
      arguments: { path: requestedPath },
    })).resolves.toMatchObject({ ok: false, code: 'path-denied' });
  });

  it.each([
    '.env',
    '.env.local',
    '.env-prod',
    '.env_test',
    '.envrc',
    '.envrc.local',
    '.direnv/allow',
    'config/production.env',
    '.aio-loop-control/run/control.json',
    '.aio-loop-state/run/AUDIT.md',
    '.aio-loop-attachments/run/input.txt',
    'credentials.json',
    '.git/config',
    'id_rsa',
    'signing-private.key',
    'certificate.pem',
  ])('denies sensitive path %s before reading it', async (requestedPath) => {
    await expect(runner.execute({
      name: 'workspace_read',
      arguments: { path: requestedPath },
    })).resolves.toMatchObject({ ok: false, code: 'sensitive-path' });
  });

  it('withholds loop-private directories from every repository tool', async () => {
    const privatePaths = [
      '.aio-loop-control/run/control.json',
      '.aio-loop-state/run/AUDIT.md',
      '.aio-loop-attachments/run/input.txt',
      '.AIO-LOOP-CONTROL/other/control.json',
    ];
    for (const privatePath of privatePaths) {
      await mkdir(path.dirname(path.join(workspacePath, privatePath)), { recursive: true });
      await writeFile(path.join(workspacePath, privatePath), 'loop-private-marker\n');
    }
    await git(['add', '-f', ...privatePaths]);
    await git(['commit', '-m', 'loop-private fixture']);
    for (const privatePath of privatePaths) {
      await writeFile(path.join(workspacePath, privatePath), 'changed-loop-private-marker\n');
    }

    const [read, list, search, statusResult, diffResult] = await Promise.all([
      runner.execute({ name: 'workspace_read', arguments: { path: privatePaths[0] } }),
      runner.execute({ name: 'workspace_list', arguments: {} }),
      runner.execute({ name: 'workspace_search', arguments: { query: 'loop-private-marker' } }),
      runner.execute({ name: 'workspace_status', arguments: {} }),
      runner.execute({ name: 'workspace_diff', arguments: {} }),
    ]);

    expect(read).toMatchObject({ ok: false, code: 'sensitive-path' });
    for (const result of [list, search, statusResult, diffResult]) {
      expect(result).toMatchObject({ ok: true });
      expect(JSON.stringify(result)).not.toContain('loop-private-marker');
      for (const privatePath of privatePaths) {
        expect(JSON.stringify(result)).not.toContain(privatePath.split('/')[0]);
      }
    }
  });

  it('returns not-found only after validating the real parent containment', async () => {
    await expect(runner.execute({
      name: 'workspace_read',
      arguments: { path: 'src/missing.ts' },
    })).resolves.toMatchObject({ ok: false, code: 'not-found' });
  });

  it('caps list output at 200 entries', async () => {
    await Promise.all(Array.from({ length: 210 }, (_, index) => (
      writeFile(path.join(workspacePath, 'src', `generated-${index}.ts`), '')
    )));

    const result = await runner.execute({ name: 'workspace_list', arguments: { path: 'src' } });

    expect(result).toMatchObject({ ok: true, truncated: true });
    if (result.ok) {
      expect(result.content.split('\n').filter(Boolean)).toHaveLength(200);
    }
  });

  it('caps directory entries inspected even when sensitive entries are filtered', async () => {
    await Promise.all(Array.from({ length: 450 }, (_, index) => (
      writeFile(path.join(workspacePath, `secret-${String(index).padStart(3, '0')}.txt`), '')
    )));
    await writeFile(path.join(workspacePath, 'zz-visible.txt'), 'visible\n');

    const result = await runner.execute({ name: 'workspace_list', arguments: {} });

    expect(result).toMatchObject({ ok: true, truncated: true });
    if (result.ok) expect(result.content).not.toContain('zz-visible.txt');
  });

  it('caps repository search at 100 matches', async () => {
    const matches = Array.from({ length: 120 }, (_, index) => `needle ${index}`).join('\n');
    await writeFile(path.join(workspacePath, 'src', 'matches.txt'), `${matches}\n`);

    const result = await runner.execute({
      name: 'workspace_search',
      arguments: { query: 'needle', path: 'src' },
    });

    expect(result).toMatchObject({ ok: true, truncated: true });
    if (result.ok) {
      expect(result.content.split('\n').filter(Boolean)).toHaveLength(100);
    }
  });

  it('uses one rg process for a bounded multi-file search snapshot', async () => {
    await writeFile(path.join(workspacePath, 'src', 'one.txt'), 'single-rg-marker\n');
    await writeFile(path.join(workspacePath, 'src', 'two.txt'), 'single-rg-marker\n');
    const calls: string[] = [];
    const snapshotRunner = new LocalReviewToolRunner(workspacePath, {
      spawnProcess: (executable, args, options) => {
        if (path.basename(executable) === 'rg') calls.push(executable);
        return spawn(executable, args, options);
      },
    });

    const result = await snapshotRunner.execute({
      name: 'workspace_search',
      arguments: { query: 'single-rg-marker', path: 'src' },
    });

    expect(result).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it.each(['abort', 'expiry'] as const)(
    'terminates stuck Git enumeration promptly on aggregate %s',
    async (mode) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: PassThrough;
        kill: (signal?: NodeJS.Signals) => boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      const signals: (NodeJS.Signals | undefined)[] = [];
      child.kill = (signal) => {
        signals.push(signal);
        if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, signal));
        return true;
      };
      const controller = new AbortController();
      let signalEnumeration: (() => void) | undefined;
      const enumerationStarted = new Promise<void>((resolve) => { signalEnumeration = resolve; });
      const stuckRunner = new LocalReviewToolRunner(workspacePath, {
        operationTimeoutMs: mode === 'expiry' ? 250 : 2_000,
        killGraceMs: 5,
        spawnProcess: (executable, args, options) => {
          if (args.includes('ls-files')) {
            signalEnumeration?.();
            return child;
          }
          return spawn(executable, args, options);
        },
      });
      const startedAt = Date.now();
      const pending = stuckRunner.execute(
        { name: 'workspace_list', arguments: {} },
        controller.signal,
      );
      await enumerationStarted;
      if (mode === 'abort') controller.abort();

      await expect(pending).resolves.toMatchObject({ ok: false, code: 'process-error' });
      expect(Date.now() - startedAt).toBeLessThan(1_500);
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    },
  );

  it('caps aggregate search snapshot input bytes', async () => {
    await writeFile(path.join(workspacePath, 'src', 'a-input.txt'), 'first-input-marker\n');
    await writeFile(path.join(workspacePath, 'src', 'b-input.txt'), 'second-input-marker\n');
    const boundedSearchRunner = new LocalReviewToolRunner(workspacePath, { maxSearchInputBytes: 24 });

    const result = await boundedSearchRunner.execute({
      name: 'workspace_search',
      arguments: { query: 'input-marker', path: 'src' },
    });

    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(JSON.stringify(result)).not.toContain('second-input-marker');
  });

  it('honours pre-aborted search cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runner.execute(
      { name: 'workspace_search', arguments: { query: 'value' } },
      controller.signal,
    );

    expect(result).toMatchObject({ ok: false, code: 'process-error' });
  });

  it('enforces one aggregate operation deadline', async () => {
    const deadlineRunner = new LocalReviewToolRunner(workspacePath, {
      operationTimeoutMs: 1,
      rootOperationHook: async ({ phase }) => {
        if (phase === 'before-operation') await delay(10);
      },
    });

    const result = await deadlineRunner.execute({ name: 'workspace_search', arguments: { query: 'value' } });

    expect(result).toMatchObject({ ok: false, code: 'process-error' });
  });

  it('passes adversarial wildcard globs to rg instead of compiling a JavaScript regex', async () => {
    const glob = `${'*a'.repeat(400)}*.ts`;
    const rgArgs: string[][] = [];
    const globRunner = new LocalReviewToolRunner(workspacePath, {
      spawnProcess: (executable, args, options) => {
        if (path.basename(executable) === 'rg') rgArgs.push([...args]);
        return spawn(executable, args, options);
      },
    });

    await globRunner.execute({ name: 'workspace_search', arguments: { query: 'value', glob } });

    expect(rgArgs).toHaveLength(1);
    expect(rgArgs[0]).toEqual(expect.arrayContaining(['--glob', glob]));
  });

  it('ignores inherited ripgrep configuration that would follow escaping symlinks', async () => {
    const ripgrepConfigPath = path.join(sandboxPath, 'ripgrep.conf');
    await writeFile(ripgrepConfigPath, '--follow\n');
    const previousConfig = process.env['RIPGREP_CONFIG_PATH'];
    process.env['RIPGREP_CONFIG_PATH'] = ripgrepConfigPath;
    try {
      const result = await runner.execute({
        name: 'workspace_search',
        arguments: { query: 'symlink-escape-marker' },
      });

      expect(result).toMatchObject({ ok: true, content: '' });
    } finally {
      if (previousConfig === undefined) delete process.env['RIPGREP_CONFIG_PATH'];
      else process.env['RIPGREP_CONFIG_PATH'] = previousConfig;
    }
  });

  it('uses rg JSON so delimiter-bearing paths are formatted safely and sensitive case variants are filtered', async () => {
    if (process.platform === 'win32') return;
    const delimiterPath = path.join(workspacePath, 'src', 'colon:name\nbreak.txt');
    await writeFile(delimiterPath, 'structured-search-marker\n');
    await writeFile(path.join(workspacePath, 'src', '.ENV'), 'structured-search-marker\n');

    const result = await runner.execute({
      name: 'workspace_search',
      arguments: { query: 'structured-search-marker', path: 'src' },
    });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      const matches = result.content.split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
        path: string;
        line: number;
        text: string;
      });
      expect(matches).toEqual([{
        path: 'src/colon:name\nbreak.txt',
        line: 1,
        text: 'structured-search-marker',
      }]);
    }
  });

  it('caps one result at 64 KiB and the session at 256 KiB', async () => {
    await writeFile(path.join(workspacePath, 'src', 'large.txt'), `${'x'.repeat(70 * 1024)}\n`);

    for (let index = 0; index < 4; index += 1) {
      const result = await runner.execute({
        name: 'workspace_read',
        arguments: { path: 'src/large.txt' },
      });
      expect(result).toMatchObject({ ok: true, truncated: true });
      if (result.ok) {
        expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(64 * 1024);
      }
    }
    await expect(runner.execute({
      name: 'workspace_read',
      arguments: { path: 'src/large.txt' },
    })).resolves.toMatchObject({ ok: false, code: 'session-limit' });
  });

  it('does not emit a replacement character when UTF-8 truncation crosses a chunk boundary', async () => {
    await writeFile(path.join(workspacePath, 'src', 'utf8.txt'), `${'a'.repeat(65_535)}😀tail\n`);

    const result = await runner.execute({
      name: 'workspace_read',
      arguments: { path: 'src/utf8.txt' },
    });

    expect(result).toMatchObject({ ok: true, truncated: true });
    if (result.ok) {
      expect(result.content).not.toContain('�');
      expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    }
  });

  it('reads no more than 400 lines', async () => {
    const lines = Array.from({ length: 450 }, (_, index) => `line ${index + 1}`).join('\n');
    await writeFile(path.join(workspacePath, 'src', 'lines.txt'), `${lines}\n`);

    const result = await runner.execute({
      name: 'workspace_read',
      arguments: { path: 'src/lines.txt' },
    });

    expect(result).toMatchObject({ ok: true, truncated: true });
    if (result.ok) {
      expect(result.content.split('\n').filter(Boolean)).toHaveLength(400);
    }
  });

  it('uses fixed Git status and working-tree diff operations', async () => {
    await writeFile(path.join(workspacePath, 'src', 'a.ts'), 'export const value = 2;\n');
    await writeFile(path.join(workspacePath, '.env'), 'API_KEY=changed-but-still-denied\n');
    await writeFile(path.join(workspacePath, 'credentials.json'), '{"token":"changed-but-still-denied"}\n');

    const [status, diff] = await Promise.all([
      runner.execute({ name: 'workspace_status', arguments: {} }),
      runner.execute({ name: 'workspace_diff', arguments: {} }),
    ]);

    expect(status).toMatchObject({ ok: true });
    expect(diff).toMatchObject({ ok: true });
    if (status.ok) expect(status.content).toContain('src/a.ts');
    if (diff.ok) {
      expect(diff.content).toContain('diff --git a/src/a.ts b/src/a.ts');
      expect(diff.content).toContain('+export const value = 2;');
    }
    if (status.ok) {
      expect(status.content).not.toContain('.env');
      expect(status.content).not.toContain('credentials.json');
    }
    if (diff.ok) {
      expect(diff.content).not.toContain('.env');
      expect(diff.content).not.toContain('credentials.json');
      expect(diff.content).not.toContain('changed-but-still-denied');
    }
  });

  it('rejects a .git file that redirects metadata outside the workspace', async () => {
    const externalGitDir = path.join(sandboxPath, 'external-git-dir');
    await rename(path.join(workspacePath, '.git'), externalGitDir);
    await writeFile(path.join(workspacePath, '.git'), `gitdir: ${externalGitDir}\n`);

    await expect(runner.execute({ name: 'workspace_status', arguments: {} })).resolves.toMatchObject({
      ok: false,
      code: 'process-error',
    });
  });

  it('supports status, diff, list, and search in a canonical linked worktree', async () => {
    const linkedPath = path.join(sandboxPath, 'linked-worktree');
    await git(['worktree', 'add', '-b', 'linked-review-test', linkedPath]);
    await writeFile(path.join(linkedPath, 'src', 'a.ts'), 'export const linkedMarker = 2;\n');
    const linkedRunner = new LocalReviewToolRunner(linkedPath);

    const [status, diff, list, search] = await Promise.all([
      linkedRunner.execute({ name: 'workspace_status', arguments: {} }),
      linkedRunner.execute({ name: 'workspace_diff', arguments: {} }),
      linkedRunner.execute({ name: 'workspace_list', arguments: { path: 'src' } }),
      linkedRunner.execute({ name: 'workspace_search', arguments: { query: 'linkedMarker', path: 'src' } }),
    ]);

    expect(status).toMatchObject({ ok: true, content: expect.stringContaining('src/a.ts') });
    expect(diff).toMatchObject({ ok: true, content: expect.stringContaining('linkedMarker') });
    expect(list).toMatchObject({ ok: true, content: expect.stringContaining('src/a.ts') });
    expect(search).toMatchObject({ ok: true, content: expect.stringContaining('linkedMarker') });
  });

  it('rejects core.worktree redirection outside the approved workspace', async () => {
    const externalWorktree = path.join(sandboxPath, 'external-worktree');
    await mkdir(externalWorktree);
    await git(['config', 'core.worktree', externalWorktree]);

    await expect(runner.execute({ name: 'workspace_diff', arguments: {} })).resolves.toMatchObject({
      ok: false,
      code: 'process-error',
    });
  });

  it('rejects inherited external index redirection instead of silently accepting it', async () => {
    const externalIndex = path.join(sandboxPath, 'external-index');
    await writeFile(externalIndex, 'external index placeholder\n');
    const previous = process.env['GIT_INDEX_FILE'];
    process.env['GIT_INDEX_FILE'] = externalIndex;
    try {
      await expect(runner.execute({ name: 'workspace_status', arguments: {} })).resolves.toMatchObject({
        ok: false,
        code: 'process-error',
      });
    } finally {
      if (previous === undefined) delete process.env['GIT_INDEX_FILE'];
      else process.env['GIT_INDEX_FILE'] = previous;
    }
  });

  it('rejects a workspace index symlink that redirects to an external file', async () => {
    const indexPath = path.join(workspacePath, '.git', 'index');
    const externalIndex = path.join(sandboxPath, 'symlinked-external-index');
    await rename(indexPath, externalIndex);
    await symlink(externalIndex, indexPath, 'file');

    await expect(runner.execute({ name: 'workspace_status', arguments: {} })).resolves.toMatchObject({
      ok: false,
      code: 'process-error',
    });
  });

  it('revalidates Git metadata at the actual spawn boundary', async () => {
    const localGit = path.join(workspacePath, '.git');
    const savedGit = path.join(workspacePath, '.git-saved');
    const externalGit = path.join(sandboxPath, 'spawn-race-git');
    await execFileAsync('git', ['init', '--bare', externalGit], { env: hermeticGitEnv(), encoding: 'utf8' });
    let swapped = false;
    const gitRaceRunner = new LocalReviewToolRunner(workspacePath, {
      gitOperationHook: async ({ phase }) => {
        if (phase === 'before-spawn' && !swapped) {
          await rename(localGit, savedGit);
          await symlink(externalGit, localGit, 'dir');
          swapped = true;
        }
      },
    });

    const result = await gitRaceRunner.execute({ name: 'workspace_status', arguments: {} });

    expect(swapped).toBe(true);
    expect(result).toMatchObject({ ok: false, code: 'process-error' });
    if (await lstat(localGit).then((value) => value.isSymbolicLink()).catch(() => false)) {
      await unlink(localGit);
      await rename(savedGit, localGit);
    }
  });

  it('filters mixed-case sensitive paths from Git status and diff', async () => {
    const sensitiveNames = ['.ENV', 'CREDENTIALS.JSON', 'SIGNING-PRIVATE.KEY'];
    for (const name of sensitiveNames) await writeFile(path.join(workspacePath, name), 'baseline\n');
    await git(['add', '-f', ...sensitiveNames]);
    await git(['commit', '-m', 'mixed-case sensitive fixture']);
    for (const name of sensitiveNames) await writeFile(path.join(workspacePath, name), 'changed-sensitive-value\n');

    const [statusResult, diffResult] = await Promise.all([
      runner.execute({ name: 'workspace_status', arguments: {} }),
      runner.execute({ name: 'workspace_diff', arguments: {} }),
    ]);

    for (const result of [statusResult, diffResult]) {
      expect(result).toMatchObject({ ok: true });
      expect(JSON.stringify(result)).not.toContain('changed-sensitive-value');
      for (const name of sensitiveNames) expect(JSON.stringify(result)).not.toContain(name);
    }
  });

  it('filters environment-file variants from Git status and diff', async () => {
    await mkdir(path.join(workspacePath, 'config'));
    await mkdir(path.join(workspacePath, '.direnv'));
    const sensitiveNames = [
      '.env-prod', '.env_test', '.envrc', '.envrc.local',
      '.direnv/allow', 'config/production.env',
    ];
    for (const name of sensitiveNames) await writeFile(path.join(workspacePath, name), 'baseline\n');
    await git(['add', '-f', ...sensitiveNames]);
    await git(['commit', '-m', 'environment variants fixture']);
    for (const name of sensitiveNames) await writeFile(path.join(workspacePath, name), 'changed-environment-value\n');

    const [statusResult, diffResult] = await Promise.all([
      runner.execute({ name: 'workspace_status', arguments: {} }),
      runner.execute({ name: 'workspace_diff', arguments: {} }),
    ]);

    for (const result of [statusResult, diffResult]) {
      expect(result).toMatchObject({ ok: true });
      expect(JSON.stringify(result)).not.toContain('changed-environment-value');
      for (const name of sensitiveNames) expect(JSON.stringify(result)).not.toContain(name);
    }
  });

  it('runs Git review operations without changing index bytes or metadata', async () => {
    await writeFile(path.join(workspacePath, 'src', 'a.ts'), 'export const value = 1;\n');
    const indexPath = path.join(workspacePath, '.git', 'index');
    const canonicalIndexPath = await realpath(indexPath);
    const beforeBytes = await readFile(indexPath);
    const before = await stat(indexPath);
    const operationalIndexPaths: string[] = [];
    const isolatedIndexRunner = new LocalReviewToolRunner(workspacePath, {
      spawnProcess: (executable, args, options) => {
        if (!args.includes('rev-parse')) {
          operationalIndexPaths.push(String(options.env?.['GIT_INDEX_FILE'] ?? ''));
        }
        return spawn(executable, args, options);
      },
    });

    await isolatedIndexRunner.execute({ name: 'workspace_status', arguments: {} });
    await isolatedIndexRunner.execute({ name: 'workspace_diff', arguments: {} });

    const afterBytes = await readFile(indexPath);
    const after = await stat(indexPath);
    expect(operationalIndexPaths).toHaveLength(2);
    expect(operationalIndexPaths).not.toContain(canonicalIndexPath);
    for (const temporaryIndexPath of operationalIndexPaths) {
      await expect(lstat(temporaryIndexPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(afterBytes.equals(beforeBytes)).toBe(true);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ctimeMs).toBe(before.ctimeMs);
  });

  it('does not execute hostile fsmonitor, external diff, or textconv commands', async () => {
    const sentinelPath = path.join(sandboxPath, 'git-command-executed');
    const hookPath = path.join(sandboxPath, 'hostile-git-hook.sh');
    await writeFile(hookPath, `#!/bin/sh\ntouch ${JSON.stringify(sentinelPath)}\nexit 0\n`);
    await chmod(hookPath, 0o700);
    await writeFile(path.join(workspacePath, '.gitattributes'), 'src/a.ts diff=hostile\n');
    await git(['config', 'core.fsmonitor', hookPath]);
    await git(['config', 'diff.external', hookPath]);
    await git(['config', 'diff.hostile.textconv', hookPath]);
    await writeFile(path.join(workspacePath, 'src', 'a.ts'), 'export const value = 3;\n');

    await runner.execute({ name: 'workspace_status', arguments: {} });
    await runner.execute({ name: 'workspace_diff', arguments: {} });

    await expect(lstat(sentinelPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('passes exact no-lock Git hardening and structured stdin-only rg arguments', async () => {
    const calls: { executable: string; args: string[]; options: SpawnOptions }[] = [];
    const recordingRunner = new LocalReviewToolRunner(workspacePath, {
      spawnProcess: (executable, args, options) => {
        calls.push({ executable, args: [...args], options });
        return spawn(executable, args, options);
      },
    });
    await recordingRunner.execute({ name: 'workspace_status', arguments: {} });
    await recordingRunner.execute({ name: 'workspace_diff', arguments: {} });
    await recordingRunner.execute({ name: 'workspace_search', arguments: { query: 'value', path: 'src' } });

    const gitCalls = calls.filter((call) => path.basename(call.executable) === 'git');
    expect(gitCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of gitCalls) {
      expect(call.args[0]).toBe('--no-optional-locks');
      expect(call.options).toMatchObject({ shell: false, env: { GIT_OPTIONAL_LOCKS: '0' } });
    }
    expect(gitCalls.some((call) => call.args.includes('--no-textconv') && call.args.includes('--no-ext-diff'))).toBe(true);
    const operationalGitCalls = gitCalls.filter((call) => !call.args.includes('rev-parse'));
    expect(operationalGitCalls.every((call) => {
      const configIndex = call.args.indexOf('core.fsmonitor=false');
      return configIndex > 0 && call.args[configIndex - 1] === '-c';
    })).toBe(true);
    const rgCall = calls.find((call) => path.basename(call.executable) === 'rg');
    expect(rgCall?.args).toEqual(expect.arrayContaining(['--no-config', '--no-follow', '--json']));
    expect(rgCall?.args).not.toContain(workspacePath);
  });

  it('does not resolve repository tools from workspace-controlled PATH entries', async () => {
    if (process.platform === 'win32') return;
    const binPath = path.join(workspacePath, 'hostile-bin');
    const sentinelPath = path.join(sandboxPath, 'hostile-rg-executed');
    await mkdir(binPath);
    await writeFile(path.join(binPath, 'rg'), `#!/bin/sh\ntouch ${JSON.stringify(sentinelPath)}\nexit 0\n`);
    await chmod(path.join(binPath, 'rg'), 0o700);
    const previousPath = process.env['PATH'];
    process.env['PATH'] = `${binPath}${path.delimiter}${previousPath ?? ''}`;
    try {
      await runner.execute({ name: 'workspace_search', arguments: { query: 'value', path: 'src' } });
    } finally {
      if (previousPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = previousPath;
    }

    await expect(lstat(sentinelPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects workspace symlink PATH entries and spawns a canonical absolute rg executable', async () => {
    if (process.platform === 'win32') return;
    const { stdout } = await execFileAsync('which', ['rg'], { encoding: 'utf8' });
    const realRgDirectory = path.dirname(String(stdout).trim());
    const workspaceLink = path.join(workspacePath, 'linked-tool-bin');
    await symlink(realRgDirectory, workspaceLink, 'dir');
    const previousPath = process.env['PATH'];
    process.env['PATH'] = `${workspaceLink}${path.delimiter}${previousPath ?? ''}`;
    const spawnedExecutables: string[] = [];
    try {
      const executableRunner = new LocalReviewToolRunner(workspacePath, {
        spawnProcess: (executable, args, options) => {
          spawnedExecutables.push(executable);
          return spawn(executable, args, options);
        },
      });
      await executableRunner.execute({ name: 'workspace_search', arguments: { query: 'value', path: 'src' } });
    } finally {
      if (previousPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = previousPath;
    }

    expect(spawnedExecutables.length).toBeGreaterThan(0);
    for (const executable of spawnedExecutables) {
      expect(path.isAbsolute(executable)).toBe(true);
      expect(executable.startsWith(workspacePath)).toBe(false);
    }
  });

  it('bounds non-reflective error results and accounts them against the session budget', async () => {
    const boundedRunner = new LocalReviewToolRunner(workspacePath, {
      maxResultBytes: 256,
      maxSessionBytes: 512,
    });
    const hugeName = 'x'.repeat(100_000);
    const first = await boundedRunner.execute({ name: hugeName, arguments: {} });

    expect(first).toMatchObject({
      ok: false,
      name: 'unknown',
      code: 'unknown-tool',
      message: 'Unknown local review tool.',
      terminal: false,
    });
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(256);
    const results = [];
    for (let index = 0; index < 10; index += 1) {
      results.push(await boundedRunner.execute({ name: 'workspace_status', arguments: { extra: index } }));
    }
    expect(results.some((result) => !result.ok && result.code === 'session-limit')).toBe(true);
    for (const result of results) {
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(256);
    }
  });

  it('publishes terminal state and returns one constant envelope after exhaustion', async () => {
    const terminalRunner = new LocalReviewToolRunner(workspacePath, {
      maxResultBytes: 256,
      maxSessionBytes: 256,
    });
    let terminalResult = await terminalRunner.execute({ name: 'workspace_status', arguments: { invalid: true } });
    while (!terminalResult.terminal) {
      terminalResult = await terminalRunner.execute({ name: 'workspace_status', arguments: { invalid: true } });
    }
    expect(terminalResult).toMatchObject({ ok: false, code: 'session-limit', terminal: true });
    for (let index = 0; index < 100; index += 1) {
      await expect(terminalRunner.execute({ name: 'x'.repeat(10_000), arguments: {} })).resolves.toEqual(terminalResult);
    }
  });

  it('short-circuits valid calls after terminal exhaustion without filesystem or subprocess work', async () => {
    const rootOperationHook = vi.fn();
    const spawnProcess = vi.fn((executable: string, args: string[], options: SpawnOptions) => (
      spawn(executable, args, options)
    ));
    const terminalRunner = new LocalReviewToolRunner(workspacePath, {
      maxResultBytes: 256,
      maxSessionBytes: 256,
      rootOperationHook,
      spawnProcess,
    });
    let terminal = await terminalRunner.execute({ name: 'workspace_status', arguments: { invalid: true } });
    while (!terminal.terminal) {
      terminal = await terminalRunner.execute({ name: 'workspace_status', arguments: { invalid: true } });
    }
    rootOperationHook.mockClear();
    spawnProcess.mockClear();

    const afterTerminal = await terminalRunner.execute({ name: 'workspace_status', arguments: {} });

    expect(afterTerminal).toEqual(terminal);
    expect(rootOperationHook).not.toHaveBeenCalled();
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('supports status, diff, list, and search in a fresh Git repo with no index', async () => {
    const freshPath = path.join(sandboxPath, 'fresh-repo');
    await mkdir(freshPath);
    await execFileAsync('git', ['init'], { cwd: freshPath, env: hermeticGitEnv(), encoding: 'utf8' });
    await expect(lstat(path.join(freshPath, '.git', 'index'))).rejects.toMatchObject({ code: 'ENOENT' });
    const freshRunner = new LocalReviewToolRunner(freshPath);

    const results = await Promise.all([
      freshRunner.execute({ name: 'workspace_status', arguments: {} }),
      freshRunner.execute({ name: 'workspace_diff', arguments: {} }),
      freshRunner.execute({ name: 'workspace_list', arguments: {} }),
      freshRunner.execute({ name: 'workspace_search', arguments: { query: 'anything' } }),
    ]);

    for (const result of results) expect(result).toMatchObject({ ok: true });
  });

  it('escalates a stuck child from SIGTERM to SIGKILL and settles once', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      kill: (signal?: NodeJS.Signals) => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    const signals: (NodeJS.Signals | undefined)[] = [];
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, signal));
      return true;
    };
    let signalSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => { signalSpawned = resolve; });
    const spawnProcess = vi.fn((executable: string, args: string[], options: SpawnOptions) => {
      if (!args.includes('diff')) return spawn(executable, args, options);
      signalSpawned?.();
      return child;
    });
    const controller = new AbortController();
    const terminatingRunner = new LocalReviewToolRunner(workspacePath, {
      operationTimeoutMs: 30_000,
      killGraceMs: 5,
      spawnProcess,
      executables: { git: 'git', rg: 'aio-deliberately-missing-rg' },
    });
    let settlementCount = 0;
    const pending = terminatingRunner.execute(
      { name: 'workspace_diff', arguments: {} },
      controller.signal,
    ).then((result) => {
      settlementCount += 1;
      return result;
    });
    const spawnOutcome = await Promise.race([
      spawned.then(() => ({ spawned: true as const })),
      pending.then((result) => ({ spawned: false as const, result })),
    ]);
    if (!spawnOutcome.spawned) {
      throw new Error(`Diff child was not spawned: ${JSON.stringify(spawnOutcome.result)}`);
    }

    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'process-error' });
    child.emit('close', 0, null);
    await Promise.resolve();

    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(settlementCount).toBe(1);
  }, 15_000);

  it('returns typed errors for unknown tools and invalid or extra arguments', async () => {
    const calls: LocalReviewToolCall[] = [
      { name: 'workspace_shell', arguments: { command: 'cat .env' } },
      { name: 'workspace_read', arguments: { path: 42 } },
      { name: 'workspace_status', arguments: { command: 'status; cat .env' } },
      { name: 'workspace_diff', arguments: { path: '../outside' } },
    ];

    await expect(runner.execute(calls[0])).resolves.toMatchObject({
      ok: false,
      code: 'unknown-tool',
    });
    for (const call of calls.slice(1)) {
      await expect(runner.execute(call)).resolves.toMatchObject({
        ok: false,
        code: 'invalid-arguments',
      });
    }
  });

  async function git(args: string[]): Promise<void> {
    await execFileAsync('git', args, {
      cwd: workspacePath,
      env: hermeticGitEnv(),
      encoding: 'utf8',
    });
  }
});
