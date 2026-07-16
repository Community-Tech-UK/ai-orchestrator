import { spawn, type SpawnOptions } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getFilesystemPolicy } from '../security/filesystem-policy';
import { hermeticGitEnv } from '../workspace/git/git-env';
import {
  sameLocalReviewGitMetadata,
  validateLocalReviewGitMetadataLayout,
  withLocalReviewGitIndexSnapshot,
  type LocalReviewGitMetadata,
} from './local-review-git-metadata';
import {
  LOCAL_REVIEW_ARGUMENT_SCHEMAS,
  LOCAL_REVIEW_TOOL_NAMES,
  type LocalReviewToolCall,
  type LocalReviewToolErrorCode,
  type LocalReviewToolName,
  type LocalReviewToolResult,
} from './local-review.types';
const DEFAULT_LIST_ENTRIES = 200, DEFAULT_SEARCH_MATCHES = 100, DEFAULT_READ_LINES = 400;
const DEFAULT_RESULT_BYTES = 64 * 1024, DEFAULT_SESSION_BYTES = 256 * 1024;
const DEFAULT_PROCESS_TIMEOUT_MS = 10_000, DEFAULT_KILL_GRACE_MS = 250;
const MAX_INSPECTED_PATHS = 400, MAX_FILE_INPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_SEARCH_INPUT_BYTES = 8 * 1024 * 1024, ERROR_NAME = 'unknown';
const GIT_SAFE_PATHS = [
  '--', '.',
  ':(exclude,icase,glob)**/.env', ':(exclude,icase,glob)**/.env[._-]*',
  ':(exclude,icase,glob)**/*.env', ':(exclude,icase,glob)**/*.env[._-]*',
  ':(exclude,icase,glob)**/.envrc', ':(exclude,icase,glob)**/.envrc[._-]*', ':(exclude,icase,glob)**/.direnv', ':(exclude,icase,glob)**/.direnv/**',
  ':(exclude,icase,glob)**/.aio-loop-control', ':(exclude,icase,glob)**/.aio-loop-control/**', ':(exclude,icase,glob)**/.aio-loop-state',
  ':(exclude,icase,glob)**/.aio-loop-state/**', ':(exclude,icase,glob)**/.aio-loop-attachments', ':(exclude,icase,glob)**/.aio-loop-attachments/**',
  ':(exclude,icase,glob)**/*credential*', ':(exclude,icase,glob)**/*secret*',
  ':(exclude,icase,glob)**/.netrc', ':(exclude,icase,glob)**/.npmrc', ':(exclude,icase,glob)**/.yarnrc',
  ':(exclude,icase,glob)**/id_rsa*', ':(exclude,icase,glob)**/id_dsa*',
  ':(exclude,icase,glob)**/id_ecdsa*', ':(exclude,icase,glob)**/id_ed25519*',
  ':(exclude,icase,glob)**/*private*', ':(exclude,icase,glob)**/*.key', ':(exclude,icase,glob)**/*.pem',
  ':(exclude,icase,glob)**/*.p12', ':(exclude,icase,glob)**/*.pfx',
] as const;
export type LocalReviewSpawn = (executable: string, args: string[], options: SpawnOptions) => ReturnType<typeof spawn>;
export interface LocalReviewPathHookEvent {
  operation: 'read' | 'list' | 'search';
  phase: 'validated' | 'before-release';
  path: string;
}
export interface LocalReviewPrimitiveHookEvent {
  path: string;
  phase: 'after-realpath' | 'after-lstat';
}
export interface LocalReviewRootHookEvent { phase: 'before-operation' | 'before-release' }
export interface LocalReviewGitHookEvent { phase: 'before-spawn' | 'before-release' }
export interface LocalReviewToolRunnerOptions {
  maxResultBytes?: number;
  maxSessionBytes?: number;
  processTimeoutMs?: number;
  killGraceMs?: number;
  spawnProcess?: LocalReviewSpawn;
  executables?: { git: string; rg: string };
  maxSearchInputBytes?: number;
  operationTimeoutMs?: number;
  /** Test seam for coordinated mutation checks; production leaves it unset. */
  pathOperationHook?: (event: LocalReviewPathHookEvent) => void | Promise<void>;
  pathPrimitiveHook?: (event: LocalReviewPrimitiveHookEvent) => void | Promise<void>;
  rootOperationHook?: (event: LocalReviewRootHookEvent) => void | Promise<void>;
  gitOperationHook?: (event: LocalReviewGitHookEvent) => void | Promise<void>;
}
interface FileIdentity { dev: number; ino: number }
interface ValidatedPath { absolutePath: string; relativePath: string; identity: FileIdentity }
interface ToolOutput { content: string; truncated: boolean }
interface CapturedProcess extends ToolOutput { ok: boolean; stderr: string }
interface RootState { absolutePath: string; identity: FileIdentity }
interface ExecutableState { absolutePath: string; identity: FileIdentity }
interface OperationContext { deadline: number; signal?: AbortSignal }
class ToolResultError extends Error {
  constructor(readonly code: LocalReviewToolErrorCode, message: string) {
    super(message);
  }
}
export class LocalReviewToolRunner {
  private readonly maxResultBytes: number;
  private readonly maxSessionBytes: number;
  private readonly processTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly spawnProcess: LocalReviewSpawn;
  private readonly executables: { git: string; rg: string };
  private readonly pathOperationHook?: LocalReviewToolRunnerOptions['pathOperationHook'];
  private readonly pathPrimitiveHook?: LocalReviewToolRunnerOptions['pathPrimitiveHook'];
  private readonly rootOperationHook?: LocalReviewToolRunnerOptions['rootOperationHook'];
  private readonly gitOperationHook?: LocalReviewToolRunnerOptions['gitOperationHook'];
  private readonly maxSearchInputBytes: number;
  private readonly operationTimeoutMs: number;
  private readonly initialPath: string;
  private rootStatePromise: Promise<RootState> | null = null;
  private readonly executablePromises: Record<'git' | 'rg', Promise<ExecutableState> | null> = { git: null, rg: null };
  private readonly approvedExecutables = new Map<string, FileIdentity>();
  private readonly terminalResult = withResultBytes({
    ok: false, name: ERROR_NAME, code: 'session-limit', message: 'Tool result budget exhausted.',
    bytes: 0, terminal: true,
  } as LocalReviewToolResult);
  private sessionBytes = 0;
  private sessionExhausted = false;
  constructor(private readonly workspaceRoot: string, options: LocalReviewToolRunnerOptions = {}) {
    this.maxResultBytes = Math.max(192, options.maxResultBytes ?? DEFAULT_RESULT_BYTES);
    this.maxSessionBytes = Math.max(this.maxResultBytes, options.maxSessionBytes ?? DEFAULT_SESSION_BYTES);
    this.processTimeoutMs = options.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.spawnProcess = options.spawnProcess ?? (spawn as LocalReviewSpawn);
    this.executables = options.executables ?? { git: 'git', rg: 'rg' };
    this.pathOperationHook = options.pathOperationHook;
    this.pathPrimitiveHook = options.pathPrimitiveHook;
    this.rootOperationHook = options.rootOperationHook;
    this.gitOperationHook = options.gitOperationHook;
    this.maxSearchInputBytes = options.maxSearchInputBytes ?? DEFAULT_SEARCH_INPUT_BYTES;
    this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
    this.initialPath = process.env['PATH'] ?? '';
  }
  async execute(call: LocalReviewToolCall, signal?: AbortSignal): Promise<LocalReviewToolResult> {
    if (this.sessionExhausted) return this.terminalResult;
    const rawName = (call as { name?: unknown } | null)?.name;
    if (typeof rawName !== 'string' || rawName.length > 64 || !this.isToolName(rawName)) {
      return this.emitError('unknown-tool', 'Unknown local review tool.');
    }
    const parsed = LOCAL_REVIEW_ARGUMENT_SCHEMAS[rawName].safeParse((call as { arguments?: unknown }).arguments);
    if (!parsed.success) return this.emitError('invalid-arguments', 'Invalid local review tool arguments.', rawName);
    try {
      const context = { deadline: Date.now() + this.operationTimeoutMs, signal };
      this.assertContext(context);
      const root = await this.assertRootIdentity();
      await this.rootOperationHook?.({ phase: 'before-operation' });
      this.assertContext(context);
      let output: ToolOutput;
      switch (rawName) {
        case 'workspace_list':
          output = await this.list(parsed.data as { path?: string; limit?: number }, context);
          break;
        case 'workspace_search':
          output = await this.search(parsed.data as {
            query: string; path?: string; glob?: string; maxMatches?: number;
          }, context);
          break;
        case 'workspace_read':
          output = await this.read(parsed.data as { path: string; startLine?: number; endLine?: number });
          break;
        case 'workspace_diff':
          output = await this.gitReview([
            '-c', 'core.fsmonitor=false', '-c', 'diff.external=',
            'diff', '--no-ext-diff', '--no-textconv', '--no-color', ...GIT_SAFE_PATHS,
          ], context);
          break;
        case 'workspace_status':
          output = await this.gitReview([
            '-c', 'core.fsmonitor=false',
            'status', '--porcelain=v1', '--untracked-files=all', ...GIT_SAFE_PATHS,
          ], context);
          break;
      }
      await this.rootOperationHook?.({ phase: 'before-release' });
      await this.assertRootIdentity(root);
      this.assertContext(context);
      return this.emitSuccess(rawName, output);
    } catch (error) {
      if (error instanceof ToolResultError) return this.emitError(error.code, error.message, rawName);
      return this.emitError('process-error', 'Repository operation failed safely.', rawName);
    }
  }
  private async list(args: { path?: string; limit?: number }, context: OperationContext): Promise<ToolOutput> {
    const requestedPath = args.path ?? '.';
    const target = await this.validatePath(requestedPath);
    const targetStats = await lstat(target.absolutePath);
    if (!targetStats.isDirectory()) throw new ToolResultError('not-directory', 'Requested path is not a directory.');
    await this.runPathHook('list', 'validated', requestedPath);
    const listed = await this.listRepositoryPaths(context);
    const limit = Math.min(args.limit ?? DEFAULT_LIST_ENTRIES, DEFAULT_LIST_ENTRIES);
    const entries = new Map<string, 'file' | 'directory'>();
    let inspected = 0;
    let truncated = listed.truncated;
    for (const candidate of listed.paths) {
      inspected += 1;
      if (inspected > MAX_INSPECTED_PATHS) { truncated = true; break; }
      const entry = directChild(target.relativePath, candidate);
      if (!entry || this.isSensitivePath(candidate, path.join(await this.rootRealPath(), candidate))) continue;
      if (!entries.has(entry.path)) entries.set(entry.path, entry.kind);
      if (entries.size > limit) { truncated = true; break; }
    }
    await this.runPathHook('list', 'before-release', requestedPath);
    await this.assertPathUnchanged(requestedPath, target);
    const selected = [...entries].slice(0, limit);
    return {
      content: selected.map(([entryPath, kind]) => JSON.stringify({ type: kind, path: entryPath })).join('\n')
        + (selected.length > 0 ? '\n' : ''),
      truncated,
    };
  }
  private async search(args: {
    query: string; path?: string; glob?: string; maxMatches?: number;
  }, context: OperationContext): Promise<ToolOutput> {
    const requestedPath = args.path ?? '.';
    const target = await this.validatePath(requestedPath);
    const targetStats = await lstat(target.absolutePath);
    if (!targetStats.isDirectory()) throw new ToolResultError('not-directory', 'Search path is not a directory.');
    await this.runPathHook('search', 'validated', requestedPath);
    const snapshot = await mkdtemp(path.join(tmpdir(), 'aio-review-search-'));
    try {
      const listed = await this.listRepositoryPaths(context);
      const copied = new Set<string>();
      let inspected = 0;
      let totalBytes = 0;
      let truncated = listed.truncated;
      for (const candidate of listed.paths) {
        if (!isWithinRelative(target.relativePath, candidate)) continue;
        this.assertContext(context);
        inspected += 1;
        if (inspected > MAX_INSPECTED_PATHS || totalBytes >= this.maxSearchInputBytes) { truncated = true; break; }
        if (this.isSensitivePath(candidate, path.join(await this.rootRealPath(), candidate))) continue;
        try {
          const remaining = Math.min(MAX_FILE_INPUT_BYTES, this.maxSearchInputBytes - totalBytes);
          const input = await this.withGuardedFile(candidate, (handle) => readHandleBounded(handle, remaining));
          const snapshotPath = path.join(snapshot, candidate);
          await mkdir(path.dirname(snapshotPath), { recursive: true });
          await writeFile(snapshotPath, input.data);
          copied.add(candidate.replace(/\\/gu, '/'));
          totalBytes += input.data.length;
          truncated ||= input.truncated;
        } catch (error) {
          if (!(error instanceof ToolResultError) || !['path-denied', 'not-found', 'not-file'].includes(error.code)) throw error;
        }
      }
      this.assertContext(context);
      const executable = (await this.getExecutable('rg')).absolutePath;
      const rgArgs = ['--no-config', '--no-follow', '--json', '--color', 'never'];
      if (args.glob) rgArgs.push('--glob', args.glob);
      rgArgs.push('--', args.query, '.');
      const capture = await this.captureProcess(
        executable,
        rgArgs,
        snapshot,
        await this.safeSubprocessEnv(process.env),
        undefined,
        [0, 1],
        Math.max(1, context.deadline - Date.now()),
        context.signal,
      );
      if (!capture.ok) throw new ToolResultError('process-error', 'Repository search failed.');
      const maxMatches = Math.min(args.maxMatches ?? DEFAULT_SEARCH_MATCHES, DEFAULT_SEARCH_MATCHES);
      const matches = parseRipgrepJson(capture.content, copied).slice(0, maxMatches);
      truncated ||= capture.truncated || parseRipgrepJson(capture.content, copied).length > matches.length;
      await this.runPathHook('search', 'before-release', requestedPath);
      await this.assertPathUnchanged(requestedPath, target);
      return { content: matches.map((match) => JSON.stringify(match)).join('\n') + (matches.length ? '\n' : ''), truncated };
    } finally {
      await rm(snapshot, { recursive: true, force: true });
    }
  }
  private async read(args: { path: string; startLine?: number; endLine?: number }): Promise<ToolOutput> {
    const target = await this.validatePath(args.path);
    await this.runPathHook('read', 'validated', args.path);
    return await this.withValidatedFile(args.path, target, async (handle) => {
      const input = await readHandleBounded(handle, MAX_FILE_INPUT_BYTES);
      const startLine = args.startLine ?? 1;
      const requestedEnd = args.endLine ?? Number.MAX_SAFE_INTEGER;
      const endLine = Math.min(requestedEnd, startLine + DEFAULT_READ_LINES - 1);
      const selected = selectLineRange(input.data, startLine, endLine, this.contentBudget());
      await this.runPathHook('read', 'before-release', args.path);
      return {
        content: selected.content,
        truncated: input.truncated || selected.truncated || (args.endLine !== undefined && requestedEnd > endLine),
      };
    });
  }
  private async withGuardedFile<T>(requestedPath: string, fn: (handle: FileHandle) => Promise<T>): Promise<T> {
    const target = await this.validatePath(requestedPath);
    return await this.withValidatedFile(requestedPath, target, fn);
  }
  private async withValidatedFile<T>(
    requestedPath: string,
    target: ValidatedPath,
    fn: (handle: FileHandle) => Promise<T>,
  ): Promise<T> {
    let handle: FileHandle | null = null;
    try {
      const currentStats = await lstat(target.absolutePath);
      if (!currentStats.isFile()) throw new ToolResultError('not-file', 'Requested path is not a regular file.');
      if (!sameIdentity(target.identity, currentStats)) {
        throw new ToolResultError('path-denied', 'Workspace path changed during access.');
      }
      handle = await open(
        target.absolutePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      const openedStats = await handle.stat();
      if (!openedStats.isFile()) throw new ToolResultError('not-file', 'Requested path is not a regular file.');
      if (!sameIdentity(target.identity, openedStats)) throw new ToolResultError('path-denied', 'Workspace path changed during access.');
      const result = await fn(handle);
      const finalHandleStats = await handle.stat();
      if (!sameIdentity(target.identity, finalHandleStats)) throw new ToolResultError('path-denied', 'Workspace path changed during access.');
      await this.assertPathUnchanged(requestedPath, target);
      return result;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  private async listRepositoryPaths(context: OperationContext): Promise<{ paths: string[]; truncated: boolean }> {
    const captured = await this.gitRaw(
      ['-c', 'core.fsmonitor=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
      context,
    );
    const rawPaths = captured.content.split('\0');
    if (captured.truncated) rawPaths.pop();
    const paths = rawPaths.filter((candidate) => isSafeRepositoryRelativePath(candidate)).sort();
    return { paths, truncated: captured.truncated };
  }
  private async gitReview(args: string[], context: OperationContext): Promise<ToolOutput> {
    const captured = await this.gitRaw(args, context);
    return { content: captured.content, truncated: captured.truncated };
  }
  private async gitRaw(args: string[], context: OperationContext): Promise<CapturedProcess> {
    const initialMetadata = await this.validateGitMetadata(context);
    await this.gitOperationHook?.({ phase: 'before-spawn' });
    const metadata = await this.validateGitMetadata(context);
    if (!sameLocalReviewGitMetadata(initialMetadata, metadata)) throw new ToolResultError('process-error', 'Git metadata changed before spawn.');
    return await withLocalReviewGitIndexSnapshot(metadata.index, async (temporaryIndex) => {
      const env = await this.safeSubprocessEnv({
        ...hermeticGitEnv(), GIT_OPTIONAL_LOCKS: '0',
        GIT_DIR: metadata.gitDir, GIT_WORK_TREE: metadata.workTree, GIT_INDEX_FILE: temporaryIndex,
      });
      const captured = await this.captureProcess(
        (await this.getExecutable('git')).absolutePath,
        ['--no-optional-locks', ...args],
        await this.rootRealPath(),
        env,
        undefined,
        [0],
        this.remainingMs(context),
        context.signal,
      );
      if (!captured.ok) throw new ToolResultError('process-error', 'Git repository operation failed.');
      await this.gitOperationHook?.({ phase: 'before-release' });
      if (!sameLocalReviewGitMetadata(metadata, await this.validateGitMetadata(context))) {
        throw new ToolResultError('process-error', 'Git metadata changed during operation.');
      }
      return captured;
    });
  }
  private async validateGitMetadata(context: OperationContext): Promise<LocalReviewGitMetadata> {
    if (process.env['GIT_DIR'] || process.env['GIT_WORK_TREE'] || process.env['GIT_INDEX_FILE']) {
      throw new ToolResultError('process-error', 'External Git metadata redirection denied.');
    }
    const root = await this.assertRootIdentity();
    const git = (await this.getExecutable('git')).absolutePath;
    const env = await this.safeSubprocessEnv({ ...hermeticGitEnv(), GIT_OPTIONAL_LOCKS: '0' });
    const probe = async (args: string[]): Promise<string> => {
      this.assertContext(context);
      const result = await this.captureProcess(
        git, ['--no-optional-locks', 'rev-parse', ...args], root.absolutePath, env,
        undefined, [0], this.remainingMs(context), context.signal,
      );
      if (!result.ok) throw new ToolResultError('process-error', 'Git metadata validation failed.');
      return result.content.trim();
    };
    try {
      const metadata = await validateLocalReviewGitMetadataLayout(root.absolutePath, probe);
      await this.assertRootIdentity(root);
      return metadata;
    } catch (error) {
      throw new ToolResultError(
        'process-error',
        error instanceof Error ? error.message : 'Git metadata validation failed.',
      );
    }
  }
  private async captureProcess(
    executable: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    input?: Buffer,
    acceptedExitCodes: readonly number[] = [0],
    timeoutMs = this.processTimeoutMs,
    signal?: AbortSignal,
  ): Promise<CapturedProcess> {
    await this.assertApprovedExecutable(executable);
    return await new Promise((resolve) => {
      const child = this.spawnProcess(executable, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let truncated = false;
      let timedOut = false;
      let stoppedForOutput = false;
      let settled = false;
      let forceTimer: NodeJS.Timeout | undefined;
      let settleTimer: NodeJS.Timeout | undefined;
      const limit = this.maxResultBytes + 1;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceTimer) clearTimeout(forceTimer);
        if (settleTimer) clearTimeout(settleTimer);
        signal?.removeEventListener('abort', abort);
        resolve({
          ok,
          content: decodeUtf8Prefix(stdout, this.maxResultBytes),
          stderr: decodeUtf8Prefix(stderr, 4_096),
          truncated,
        });
      };
      const terminate = (): void => {
        child.kill('SIGTERM');
        forceTimer ??= setTimeout(() => {
          child.kill('SIGKILL');
          settleTimer = setTimeout(() => finish(false), this.killGraceMs);
          settleTimer.unref?.();
        }, this.killGraceMs);
        forceTimer.unref?.();
      };
      const abort = (): void => { timedOut = true; terminate(); };
      const timeout = setTimeout(abort, timeoutMs);
      timeout.unref?.();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length >= limit) return;
        stdout = Buffer.concat([stdout, chunk.subarray(0, limit - stdout.length)]);
        if (stdout.length >= limit) { truncated = true; stoppedForOutput = true; terminate(); }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 4_096) stderr = Buffer.concat([stderr, chunk.subarray(0, 4_096 - stderr.length)]);
      });
      child.once('error', () => finish(false));
      child.once('close', (code) => finish(!timedOut && (stoppedForOutput || (code !== null && acceptedExitCodes.includes(code)))));
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input);
    });
  }
  private async validatePath(requestedPath: string): Promise<ValidatedPath> {
    const root = await this.rootRealPath();
    const candidate = path.resolve(root, requestedPath);
    let first: ValidatedPath;
    let second: ValidatedPath;
    try {
      first = await this.pathSnapshot(root, candidate, requestedPath);
      second = await this.pathSnapshot(root, candidate, requestedPath);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const missingPath = await this.resolveMissingPath(candidate);
      if (!this.isContained(root, missingPath)) throw new ToolResultError('path-denied', 'Requested path escapes the workspace.');
      const relativePath = path.relative(root, missingPath) || '.';
      if (this.isSensitivePath(relativePath, missingPath)) throw new ToolResultError('sensitive-path', 'Sensitive repository path denied.');
      throw new ToolResultError('not-found', 'Requested workspace path does not exist.');
    }
    if (first.absolutePath !== second.absolutePath || !sameIdentity(first.identity, second.identity)) {
      throw new ToolResultError('path-denied', 'Workspace path changed during validation.');
    }
    return second;
  }
  private async pathSnapshot(root: string, candidate: string, requestedPath: string): Promise<ValidatedPath> {
    // Report the caller's raw requested path (POSIX-style, as received) to the
    // hook — matching pathOperationHook's contract. `path.relative` would emit
    // native separators and break the seam on Windows.
    const hookPath = requestedPath || '.';
    const absolutePath = await realpath(candidate);
    await this.pathPrimitiveHook?.({ path: hookPath, phase: 'after-realpath' });
    if (!this.isContained(root, absolutePath)) throw new ToolResultError('path-denied', 'Requested path escapes the workspace.');
    const relativePath = path.relative(root, absolutePath) || '.';
    if (this.isSensitivePath(relativePath, absolutePath)) throw new ToolResultError('sensitive-path', 'Sensitive repository path denied.');
    const stats = await lstat(absolutePath);
    await this.pathPrimitiveHook?.({ path: hookPath, phase: 'after-lstat' });
    if (await realpath(candidate) !== absolutePath) throw new ToolResultError('path-denied', 'Workspace path changed during validation.');
    return { absolutePath, relativePath, identity: { dev: stats.dev, ino: stats.ino } };
  }
  private async assertPathUnchanged(requestedPath: string, expected: ValidatedPath): Promise<void> {
    const actual = await this.validatePath(requestedPath);
    if (actual.absolutePath !== expected.absolutePath || !sameIdentity(actual.identity, expected.identity)) {
      throw new ToolResultError('path-denied', 'Workspace path changed during access.');
    }
  }
  private async resolveMissingPath(candidate: string): Promise<string> {
    const missing: string[] = [];
    let parent = candidate;
    while (true) {
      try { return path.join(await realpath(parent), ...missing.reverse()); }
      catch (error) {
        if (!isMissingPathError(error)) throw error;
        const next = path.dirname(parent);
        if (next === parent) throw error;
        missing.push(path.basename(parent));
        parent = next;
      }
    }
  }
  private async safeSubprocessEnv(base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    const root = await this.rootRealPath();
    const safePathEntries: string[] = [];
    for (const entry of (base['PATH'] ?? '').split(path.delimiter)) {
      if (!path.isAbsolute(entry)) continue;
      if (this.isContained(path.resolve(this.workspaceRoot), path.resolve(entry))) continue;
      try {
        const canonicalEntry = await realpath(entry);
        if (!this.isContained(root, canonicalEntry)) safePathEntries.push(entry);
      } catch { /* Missing PATH entries cannot resolve an executable. */ }
    }
    const env: NodeJS.ProcessEnv = { ...base, PATH: safePathEntries.join(path.delimiter) };
    delete env['RIPGREP_CONFIG_PATH'];
    return env;
  }
  private getExecutable(name: 'git' | 'rg'): Promise<ExecutableState> {
    this.executablePromises[name] ??= this.resolveExecutable(this.executables[name]);
    return this.executablePromises[name];
  }
  private async resolveExecutable(configured: string): Promise<ExecutableState> {
    const root = await this.rootRealPath();
    const lexicalRoot = path.resolve(this.workspaceRoot);
    // On Windows a bare `git`/`rg` never resolves on disk — the real binary is
    // `git.exe`. Expand each trusted PATH entry across the platform's executable
    // extensions so the identity-pinned lookup finds the actual file.
    const names = path.isAbsolute(configured) || path.extname(configured)
      ? [configured]
      : [configured, ...executableExtensions().map((ext) => `${configured}${ext}`)];
    const candidates = path.isAbsolute(configured)
      ? [configured]
      : this.initialPath.split(path.delimiter).filter(path.isAbsolute)
          .flatMap((entry) => names.map((name) => path.join(entry, name)));
    for (const candidate of candidates) {
      const lexical = path.resolve(candidate);
      if (this.isContained(root, lexical) || this.isContained(lexicalRoot, lexical)) continue;
      try {
        const absolutePath = await realpath(lexical);
        const stats = await lstat(absolutePath);
        if (!stats.isFile() || this.isContained(root, absolutePath)) continue;
        const state = { absolutePath, identity: { dev: stats.dev, ino: stats.ino } };
        this.approvedExecutables.set(absolutePath, state.identity);
        return state;
      } catch { /* Try the next trusted absolute PATH candidate. */ }
    }
    throw new ToolResultError('process-error', 'Approved repository executable unavailable.');
  }
  private async assertApprovedExecutable(executable: string): Promise<void> {
    if (!path.isAbsolute(executable)) throw new ToolResultError('process-error', 'Unapproved repository executable.');
    const expected = this.approvedExecutables.get(executable);
    const stats = await lstat(executable).catch(() => null);
    if (!expected || !stats?.isFile() || !sameIdentity(expected, stats)) {
      throw new ToolResultError('process-error', 'Repository executable identity changed.');
    }
  }
  private async assertRootIdentity(expected?: RootState): Promise<RootState> {
    const baseline = expected ?? await this.getRootState();
    const current = await this.snapshotRoot();
    if (current.absolutePath !== baseline.absolutePath || !sameIdentity(current.identity, baseline.identity)) {
      throw new ToolResultError('path-denied', 'Workspace root changed during access.');
    }
    return baseline;
  }
  private getRootState(): Promise<RootState> {
    this.rootStatePromise ??= this.snapshotRoot().then(async (first) => {
      const second = await this.snapshotRoot();
      if (first.absolutePath !== second.absolutePath || !sameIdentity(first.identity, second.identity)) {
        throw new ToolResultError('path-denied', 'Workspace root changed during validation.');
      }
      return second;
    });
    return this.rootStatePromise;
  }
  private async snapshotRoot(): Promise<RootState> {
    const absolutePath = await realpath(path.resolve(this.workspaceRoot));
    const stats = await lstat(absolutePath);
    if (!stats.isDirectory()) throw new ToolResultError('path-denied', 'Workspace root is not a directory.');
    return { absolutePath, identity: { dev: stats.dev, ino: stats.ino } };
  }
  private assertContext(context: OperationContext): void {
    if (context.signal?.aborted || Date.now() > context.deadline) {
      throw new ToolResultError('process-error', 'Repository operation cancelled or timed out.');
    }
  }
  private remainingMs(context: OperationContext): number {
    this.assertContext(context);
    return Math.max(1, context.deadline - Date.now());
  }
  private isSensitivePath(relativePath: string, absolutePath: string): boolean {
    if (getFilesystemPolicy().isBlocked(absolutePath)) return true;
    return relativePath.split(/[\\/]+/u).some((rawSegment) => {
      const segment = rawSegment.toLowerCase();
      return segment === '.git' || segment === '.netrc' || segment === '.npmrc' || segment === '.yarnrc'
        || segment === '.git-credentials' || /^\.envrc(?:[._-]|$)/u.test(segment) || segment === '.direnv'
        || segment === '.aio-loop-control' || segment === '.aio-loop-state'
        || segment === '.aio-loop-attachments' || /(?:^|\.)env(?:[._-]|$)/u.test(segment)
        || segment.includes('credential') || segment.includes('secret')
        || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?$/u.test(segment)
        || /(?:^|[-_.])private(?:[-_.]|$)/u.test(segment) || /\.(?:key|pem|p12|pfx)$/u.test(segment);
    });
  }
  private emitSuccess(name: LocalReviewToolName, output: ToolOutput): LocalReviewToolResult {
    const capped = capText(output.content, this.contentBudget());
    return this.account({ ok: true, name, content: capped.text, truncated: output.truncated || capped.truncated, bytes: 0, terminal: false });
  }
  private emitError(code: LocalReviewToolErrorCode, message: string, name = ERROR_NAME): LocalReviewToolResult {
    return this.account({ ok: false, name: this.isToolName(name) ? name : ERROR_NAME, code, message, bytes: 0, terminal: false });
  }
  private account(draft: LocalReviewToolResult): LocalReviewToolResult {
    if (this.sessionExhausted) return this.terminalResult;
    const result = withResultBytes(draft);
    const normalBudget = Math.max(0, this.maxSessionBytes - this.terminalResult.bytes);
    if (result.bytes > this.maxResultBytes || this.sessionBytes + result.bytes > normalBudget) {
      this.sessionExhausted = true;
      return this.terminalResult;
    }
    this.sessionBytes += result.bytes;
    return result;
  }
  private contentBudget(): number { return Math.max(0, this.maxResultBytes - 192); }
  private async runPathHook(operation: LocalReviewPathHookEvent['operation'], phase: LocalReviewPathHookEvent['phase'], requestedPath: string): Promise<void> {
    await this.pathOperationHook?.({ operation, phase, path: requestedPath });
  }
  private isContained(root: string, candidate: string): boolean { return candidate === root || candidate.startsWith(`${root}${path.sep}`); }
  private async rootRealPath(): Promise<string> { return (await this.getRootState()).absolutePath; }
  private isToolName(name: string): name is LocalReviewToolName { return (LOCAL_REVIEW_TOOL_NAMES as readonly string[]).includes(name); }
}
async function readHandleBounded(handle: FileHandle, maxBytes: number): Promise<{ data: Buffer; truncated: boolean }> {
  const output = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < output.length) {
    const { bytesRead } = await handle.read(output, offset, output.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return { data: output.subarray(0, Math.min(offset, maxBytes)), truncated: offset > maxBytes };
}
function selectLineRange(data: Buffer, startLine: number, endLine: number, maxBytes: number): ToolOutput {
  let line = 1;
  let start = startLine === 1 ? 0 : data.length;
  let end = data.length;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] !== 0x0a) continue;
    if (line + 1 === startLine) start = index + 1;
    if (line === endLine) { end = index + 1; break; }
    line += 1;
  }
  const selected = data.subarray(start, Math.min(end, start + maxBytes));
  return { content: decodeUtf8Prefix(selected, selected.length), truncated: end < data.length || end - start > maxBytes };
}
function parseRipgrepJson(content: string, allowedPaths: ReadonlySet<string>): { path: string; line: number; text: string }[] {
  const matches: { path: string; line: number; text: string }[] = [];
  for (const rawLine of content.split('\n')) {
    if (!rawLine) continue;
    try {
      const event = JSON.parse(rawLine) as {
        type?: string;
        data?: { line_number?: number; lines?: { text?: string }; path?: { text?: string } };
      };
      const line = event.data?.line_number;
      const text = event.data?.lines?.text;
      const relativePath = event.data?.path?.text?.replace(/^\.\//u, '').replace(/\\/gu, '/');
      if (event.type === 'match' && typeof line === 'number' && typeof text === 'string'
        && relativePath && allowedPaths.has(relativePath)) {
        matches.push({ path: relativePath, line, text: text.replace(/\r?\n$/u, '') });
      }
    } catch { /* A capped trailing JSON event is deliberately ignored. */ }
  }
  return matches;
}
function directChild(directory: string, candidate: string): { path: string; kind: 'file' | 'directory' } | null {
  const prefix = directory === '.' ? '' : `${directory.replace(/\\/gu, '/')}/`;
  const normalized = candidate.replace(/\\/gu, '/');
  if (!normalized.startsWith(prefix)) return null;
  const remainder = normalized.slice(prefix.length);
  if (!remainder) return null;
  const slash = remainder.indexOf('/');
  return slash < 0 ? { path: normalized, kind: 'file' } : { path: `${prefix}${remainder.slice(0, slash)}`, kind: 'directory' };
}
function isWithinRelative(directory: string, candidate: string): boolean {
  if (directory === '.') return true;
  const normalizedDirectory = directory.replace(/\\/gu, '/');
  return candidate === normalizedDirectory || candidate.startsWith(`${normalizedDirectory}/`);
}
function isSafeRepositoryRelativePath(candidate: string): boolean {
  if (!candidate || path.isAbsolute(candidate)) return false;
  const normalized = path.normalize(candidate);
  return normalized !== '..' && !normalized.startsWith(`..${path.sep}`);
}
function sameIdentity(expected: FileIdentity, actual: FileIdentity): boolean { return expected.dev === actual.dev && expected.ino === actual.ino; }
function executableExtensions(): string[] {
  if (process.platform !== 'win32') return [];
  return (process.env['PATHEXT'] ?? '.EXE;.COM;.BAT;.CMD').split(';').map((ext) => ext.trim()).filter(Boolean);
}
function capText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const data = Buffer.from(value, 'utf8');
  if (data.length <= maxBytes) return { text: value, truncated: false };
  return { text: decodeUtf8Prefix(data, maxBytes), truncated: true };
}
function decodeUtf8Prefix(data: Buffer, maxBytes: number): string {
  let end = Math.min(data.length, maxBytes);
  if (end < data.length || end > 0) {
    let lead = end - 1;
    while (lead >= 0 && (data[lead] & 0xc0) === 0x80) lead -= 1;
    if (lead >= 0) {
      const byte = data[lead];
      const expected = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      if (end - lead < expected) end = lead;
    }
  }
  return data.subarray(0, end).toString('utf8');
}
function withResultBytes<T extends LocalReviewToolResult>(result: T): T {
  let bytes = 0;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const next = Buffer.byteLength(JSON.stringify({ ...result, bytes }), 'utf8');
    if (next === bytes) break;
    bytes = next;
  }
  return { ...result, bytes };
}
function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
