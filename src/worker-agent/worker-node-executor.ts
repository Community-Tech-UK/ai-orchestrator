import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  NODE_EXEC_MAX_OUTPUT_BYTES,
  type NodeExecParams,
  type NodeExecResult,
} from '../main/remote-node/node-control-rpc-schemas';
import { isPathAllowed } from './path-sandbox';
import {
  createPosixDescendantTracker,
  createPosixOwnershipMarker,
  NODE_EXEC_OWNERSHIP_MARKER_ENV,
  terminatePosixProcessTree,
  type CapturedPosixProcessTree,
  type PosixDescendantTracker,
  type PosixTerminationResult,
} from './worker-node-process-tree';
import {
  ExecFileError,
  type ExecFileOptions,
  type ExecFileResult,
} from './service/exec-file';
import {
  prepareWorkerNodeExec,
  type NodeExecAllowedRoots,
  WorkerNodeExecPolicyError,
} from './worker-node-exec-policy';
import {
  resolveTrustedNodeExecExecutable,
  type TrustedNodeExecExecutableResolver,
} from './worker-node-command-resolver';

const NODE_EXEC_MAX_JSON_STRING_BYTES = 112 * 1024;
const NODE_EXEC_TERMINATION_GRACE_MS = 250;
const NODE_EXEC_INPUT_FAILURE_CAPTURE_GRACE_MS = 50;
const NODE_EXEC_CLEANUP_COMMAND_TIMEOUT_MS = 250;
const NODE_EXEC_CLEANUP_MAX_OUTPUT_BYTES = 512 * 1024;

type BoundedExecFileResult = ExecFileResult & {
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
};
type ExecFileCapture = (
  file: string,
  args: string[],
  options?: ExecFileOptions,
) => Promise<BoundedExecFileResult>;
export interface NodeExecRuntime {
  readonly platform: NodeJS.Platform;
  readonly spawnProcess: typeof spawn;
  readonly execFileProcess: typeof execFile;
  readonly killProcess: (pid: number, signal?: string | number) => boolean;
  readonly createOwnershipMarker?: () => string;
  readonly resolveTrustedExecutable?: TrustedNodeExecExecutableResolver;
}
const DEFAULT_NODE_EXEC_RUNTIME: NodeExecRuntime = {
  get platform() {
    return process.platform;
  },
  spawnProcess: spawn,
  execFileProcess: execFile,
  killProcess: (pid, signal) => process.kill(pid, signal),
  resolveTrustedExecutable: resolveTrustedNodeExecExecutable,
};
export class NodeExecInvalidParamsError extends Error {
  override name = 'NodeExecInvalidParamsError';
}

class NodeExecCaptureError extends ExecFileError {
  constructor(
    file: string,
    args: string[],
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    stdout: string,
    stderr: string,
    public readonly stdoutTruncated: boolean,
    public readonly stderrTruncated: boolean,
  ) {
    super(file, args, exitCode, signal, stdout, stderr);
  }
}

class NodeExecTimeoutError extends NodeExecCaptureError {
  override name = 'NodeExecTimeoutError';

  constructor(
    file: string,
    args: string[],
    signal: NodeJS.Signals,
    stdout: string,
    stderr: string,
    stdoutTruncated: boolean,
    stderrTruncated: boolean,
  ) {
    super(file, args, null, signal, stdout, stderr, stdoutTruncated, stderrTruncated);
  }
}
export class WorkerNodeExecutor {
  private readonly run: ExecFileCapture;
  private readonly resolveTrustedExecutable: TrustedNodeExecExecutableResolver;

  constructor(
    private readonly allowedExecutionRoots: NodeExecAllowedRoots,
    run: ExecFileCapture | undefined = undefined,
    private readonly now: () => number = Date.now,
    runtime: NodeExecRuntime = DEFAULT_NODE_EXEC_RUNTIME,
    private readonly prepare: typeof prepareWorkerNodeExec = prepareWorkerNodeExec,
  ) {
    this.resolveTrustedExecutable = runtime.resolveTrustedExecutable
      ?? resolveTrustedNodeExecExecutable;
    this.run = run ?? ((file, args, options) => (
      execFileCaptureWithBoundedTermination(file, args, options, runtime)
    ));
  }

  async execute(params: NodeExecParams): Promise<NodeExecResult> {
    const cwd = params.cwd ? await this.resolveAllowedCwd(params.cwd) : undefined;
    let prepared;
    try {
      prepared = await this.prepare(
        params,
        cwd,
        this.allowedExecutionRoots,
        this.resolveTrustedExecutable,
      );
    } catch (error) {
      if (error instanceof WorkerNodeExecPolicyError) {
        throw new NodeExecInvalidParamsError(error.message);
      }
      throw error;
    }

    const startedAt = this.now();
    let exitCode: number | null;
    let stdout: string;
    let stderr: string;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    try {
      const result = await this.run(prepared.executable, prepared.args, {
        ...(cwd ? { cwd } : {}),
        env: prepared.env,
        timeoutMs: params.timeoutMs,
        ...(prepared.input !== undefined ? { input: prepared.input } : {}),
      });
        exitCode = result.exitCode;
        stdout = result.stdout;
        stderr = result.stderr;
        stdoutTruncated = result.stdoutTruncated ?? false;
        stderrTruncated = result.stderrTruncated ?? false;
    } catch (error) {
        if (!(error instanceof ExecFileError)) {
          throw error;
        }
        exitCode = error.exitCode;
        stdout = error.stdout;
        stderr = error.stderr;
        if (error instanceof NodeExecCaptureError) {
          stdoutTruncated = error.stdoutTruncated;
          stderrTruncated = error.stderrTruncated;
        }
    }

    const boundedStdout = boundOutput(stdout);
    const boundedStderr = boundOutput(stderr);
    return {
      exitCode,
      stdout: boundedStdout.value,
      stderr: boundedStderr.value,
      stdoutTruncated: stdoutTruncated || boundedStdout.truncated,
      stderrTruncated: stderrTruncated || boundedStderr.truncated,
      durationMs: Math.max(0, Math.round(this.now() - startedAt)),
    };
  }

  private async resolveAllowedCwd(requestedCwd: string): Promise<string> {
    let resolvedCwd: string;
    try {
      resolvedCwd = await realpath(requestedCwd);
    } catch {
      throw new NodeExecInvalidParamsError('node.exec cwd does not exist or cannot be resolved');
    }
    const roots = typeof this.allowedExecutionRoots === 'function'
      ? this.allowedExecutionRoots()
      : this.allowedExecutionRoots;
    const resolvedRoots = await Promise.all(roots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return resolve(root);
      }
    }));
    if (!isPathAllowed(resolvedCwd, resolvedRoots)) {
      throw new NodeExecInvalidParamsError('node.exec cwd is outside configured worker working directories');
    }
    return resolvedCwd;
  }
}

/** @internal Exported for process-level lifecycle verification. */
export function execFileCaptureWithBoundedTermination(
  file: string,
  args: string[],
  opts: ExecFileOptions = {},
  runtime: NodeExecRuntime = DEFAULT_NODE_EXEC_RUNTIME,
): Promise<BoundedExecFileResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminationStarted = false;
    let inputFinished = opts.input === undefined;
    let timeoutSignal: NodeJS.Signals = 'SIGTERM';
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const capturedStdout: Buffer[] = [];
    const capturedStderr: Buffer[] = [];
    let capturedStdoutBytes = 0;
    let capturedStderrBytes = 0;
    let capturedStdoutTruncated = false;
    let capturedStderrTruncated = false;
    const cleanupFailures: string[] = [];
    let descendantTracker: PosixDescendantTracker | undefined;
    let posixIdentityProven = false;
    let windowsRootExited = false;
    const finish = (result: BoundedExecFileResult | ExecFileError): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      descendantTracker?.dispose();
      if (result instanceof ExecFileError) {
        reject(result);
        return;
      }
      resolve(result);
    };
    const timeoutError = (
      stdout: string,
      stderr: string,
      stdoutTruncated = false,
      stderrTruncated = false,
    ) => new NodeExecTimeoutError(
      file,
      args,
      timeoutSignal,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
    );
    const ownershipMarker = runtime.platform === 'win32'
      ? undefined
      : (runtime.createOwnershipMarker?.() ?? createPosixOwnershipMarker());
    const child = runtime.spawnProcess(
      file,
      args,
      {
        cwd: opts.cwd,
        env: ownershipMarker
          ? { ...(opts.env ?? process.env), [NODE_EXEC_OWNERSHIP_MARKER_ENV]: ownershipMarker }
          : opts.env,
        detached: runtime.platform !== 'win32',
        windowsHide: true,
      },
    );
    const startDescendantTracker = (): void => {
      if (runtime.platform === 'win32' || descendantTracker || !isSafeProcessId(child.pid)) return;
      descendantTracker = createPosixDescendantTracker(child.pid, runtime);
      void descendantTracker.sample();
    };
    const beginTermination = (reason: 'timeout' | 'input', detail?: string): void => {
      if (settled || terminationStarted) return;
      terminationStarted = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      void (async () => {
        let capturedTree: CapturedPosixProcessTree | undefined;
        try {
          if (reason === 'input' && descendantTracker) {
            await new Promise<void>((captureGraceElapsed) => {
              setTimeout(captureGraceElapsed, NODE_EXEC_INPUT_FAILURE_CAPTURE_GRACE_MS);
            });
          }
          descendantTracker?.pause();
          if (descendantTracker) {
            await descendantTracker.sample();
            capturedTree = descendantTracker.snapshot();
          } else if (runtime.platform !== 'win32') {
            capturedTree = {
              targets: [],
              rootPid: child.pid ?? 0,
              rootExited: false,
              failure: '[node.exec cleanupIncomplete: POSIX ownership identity could not be proven]',
            };
          }
          const termResult = await terminateProcessTree(
            child,
            'SIGTERM',
            runtime,
            capturedTree,
            ownershipMarker,
            false,
            () => windowsRootExited,
          );
          posixIdentityProven ||= termResult.identityProven;
          cleanupFailures.push(...termResult.failures);
          await new Promise<void>((graceElapsed) => {
            forceKillTimer = setTimeout(graceElapsed, NODE_EXEC_TERMINATION_GRACE_MS);
          });
          timeoutSignal = 'SIGKILL';
          const killResult = await terminateProcessTree(
            child,
            'SIGKILL',
            runtime,
            capturedTree,
            ownershipMarker,
            posixIdentityProven,
            () => windowsRootExited,
          );
          cleanupFailures.push(...killResult.failures);
        } catch {
          timeoutSignal = 'SIGKILL';
          cleanupFailures.push('[node.exec cleanup: termination sequence failed (INTERNAL)]');
          try {
            const emergencyResult = await terminateProcessTree(
              child,
              'SIGKILL',
              runtime,
              capturedTree,
              ownershipMarker,
              posixIdentityProven,
              () => windowsRootExited,
            );
            cleanupFailures.push(...emergencyResult.failures);
          } catch {
            cleanupFailures.push('[node.exec cleanup: emergency SIGKILL fallback failed]');
          }
        } finally {
          disposeChildProcess(child);
          const stdout = Buffer.concat(capturedStdout).toString('utf8');
          const processStderr = Buffer.concat(capturedStderr).toString('utf8');
          const failureStderr = reason === 'input'
            ? `node.exec could not deliver verified script input: ${detail ?? 'input failed'}`
            : processStderr;
          const stderr = prependCleanupFailures(
            reason === 'input' && processStderr
              ? `${failureStderr}\n${processStderr}`
              : failureStderr,
            cleanupFailures,
          );
          if (reason === 'timeout') {
            finish(timeoutError(
              stdout,
              stderr,
              capturedStdoutTruncated,
              capturedStderrTruncated,
            ));
          } else {
            finish(new NodeExecCaptureError(
              file,
              args,
              null,
              timeoutSignal,
              stdout,
              stderr,
              capturedStdoutTruncated,
              capturedStderrTruncated,
            ));
          }
        }
      })();
    };
    startDescendantTracker();
    child.once('spawn', () => {
      startDescendantTracker();
      void descendantTracker?.sample();
    });
    child.once('exit', () => {
      windowsRootExited = true;
      descendantTracker?.pause(true);
      void descendantTracker?.sample();
    });
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const capture = captureOutputChunk(capturedStdout, capturedStdoutBytes, chunk);
      capturedStdoutBytes = capture.capturedBytes;
      capturedStdoutTruncated ||= capture.truncated;
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const capture = captureOutputChunk(capturedStderr, capturedStderrBytes, chunk);
      capturedStderrBytes = capture.capturedBytes;
      capturedStderrTruncated ||= capture.truncated;
    });
    child.on('error', (error) => {
      if (terminationStarted) return;
      finish(new ExecFileError(file, args, null, null, '', error.message));
    });
    child.on('close', (exitCode, signal) => {
      if (terminationStarted) return;
      if (!inputFinished) {
        beginTermination('input', 'child closed before stdin finished');
        return;
      }
      const stdout = Buffer.concat(capturedStdout).toString('utf8');
      const stderr = Buffer.concat(capturedStderr).toString('utf8');
      if (exitCode === 0) {
        finish({
          stdout,
          stderr,
          exitCode,
          stdoutTruncated: capturedStdoutTruncated,
          stderrTruncated: capturedStderrTruncated,
        });
        return;
      }
      finish(new NodeExecCaptureError(
        file,
        args,
        exitCode,
        signal,
        stdout,
        stderr,
        capturedStdoutTruncated,
        capturedStderrTruncated,
      ));
    });
    timeoutTimer = opts.timeoutMs === undefined
      ? undefined
      : setTimeout(() => beginTermination('timeout'), opts.timeoutMs);
    if (opts.input !== undefined) {
      const failInput = (error: Error): void => {
        beginTermination('input', error.message);
      };
      if (!child.stdin) {
        failInput(new Error('child stdin is unavailable'));
      } else {
        child.stdin.once('error', failInput);
        child.stdin.once('finish', () => {
          inputFinished = true;
        });
        child.stdin.once('close', () => {
          if (!inputFinished) failInput(new Error('stdin closed before write completion'));
        });
        try {
          child.stdin.end(opts.input);
        } catch (error) {
          failInput(error instanceof Error ? error : new Error('stdin write failed'));
        }
      }
    }
  });
}

function disposeChildProcess(child: ChildProcess): void {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try {
      stream?.destroy();
    } catch {
      // Cleanup continues so timeout settlement cannot be blocked by a stream.
    }
  }
  try {
    child.unref();
  } catch {
    // Timeout result settlement does not depend on handle unref support.
  }
}

async function terminateProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  runtime: NodeExecRuntime,
  capturedTree: CapturedPosixProcessTree | undefined,
  ownershipMarker: string | undefined,
  emptyIsComplete: boolean,
  hasRootExited: () => boolean,
): Promise<PosixTerminationResult> {
  const pid = child.pid;
  if (!isSafeProcessId(pid)) {
    return {
      failures: [`[node.exec cleanup: invalid direct-child pid at ${signal}]`],
      identityProven: false,
    };
  }

  if (runtime.platform === 'win32') {
    if (hasRootExited()) {
      return {
        failures: [windowsExitedRootFailure(signal)],
        identityProven: false,
      };
    }
    const args = ['/PID', String(pid), '/T'];
    if (signal === 'SIGKILL') args.push('/F');
    let taskkillPath: string;
    try {
      taskkillPath = await (runtime.resolveTrustedExecutable
        ?? resolveTrustedNodeExecExecutable)('taskkill.exe');
    } catch {
      taskkillPath = '';
    }
    const taskkill = taskkillPath
      ? await runBoundedCleanupCommand(runtime, taskkillPath, args)
      : { ok: false as const, reason: 'UNTRUSTED_PATH' };
    if (taskkill.ok) return { failures: [], identityProven: true };
    if (hasRootExited()) {
      return {
        failures: [windowsExitedRootFailure(signal)],
        identityProven: false,
      };
    }
    const fallback = signalProcess(pid, signal, runtime);
    return {
      failures: [
        `[node.exec cleanup: taskkill ${signal} failed (${taskkill.reason}); direct-child fallback ${fallback}]`,
      ],
      identityProven: fallback === 'sent',
    };
  }
  if (!capturedTree || !ownershipMarker) {
    return {
      failures: ['[node.exec cleanupIncomplete: POSIX ownership identity could not be proven]'],
      identityProven: false,
    };
  }
  return terminatePosixProcessTree(capturedTree, ownershipMarker, signal, runtime, emptyIsComplete);
}

function windowsExitedRootFailure(signal: NodeJS.Signals): string {
  return `[node.exec cleanupIncomplete: Windows root exited before ${signal}; descendant ownership could not be proven]`;
}

type CleanupCommandResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: string };
function runBoundedCleanupCommand(
  runtime: NodeExecRuntime,
  file: string,
  args: string[],
): Promise<CleanupCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let command: ChildProcess | undefined;
    const finish = (result: CleanupCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        command?.kill('SIGKILL');
      } catch {
        // The bounded cleanup command may already have exited.
      }
      if (command) disposeChildProcess(command);
      finish({ ok: false, reason: 'TIMEOUT' });
    }, NODE_EXEC_CLEANUP_COMMAND_TIMEOUT_MS);

    try {
      command = runtime.execFileProcess(
        file,
        args,
        {
          encoding: 'utf8',
          killSignal: 'SIGKILL',
          maxBuffer: NODE_EXEC_CLEANUP_MAX_OUTPUT_BYTES,
          timeout: NODE_EXEC_CLEANUP_COMMAND_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            finish({ ok: false, reason: cleanupFailureReason(error) });
            return;
          }
          finish({ ok: true, stdout });
        },
      );
    } catch (error) {
      finish({ ok: false, reason: cleanupFailureReason(error) });
    }
  });
}

function cleanupFailureReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return 'ENOENT';
  if (code === 'ETIMEDOUT') return 'TIMEOUT';
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'OUTPUT_LIMIT';
  return 'FAILED';
}

function signalProcess(
  pid: number,
  signal: NodeJS.Signals,
  runtime: NodeExecRuntime,
): 'sent' | 'not-running' | 'failed' {
  const resolvedPid = Math.abs(pid);
  if (!isSafeProcessId(resolvedPid)) return 'failed';
  try {
    return runtime.killProcess(pid, signal) ? 'sent' : 'failed';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'not-running' : 'failed';
  }
}

function isSafeProcessId(pid: number | undefined): pid is number {
  return pid !== undefined
    && Number.isSafeInteger(pid)
    && pid > 1
    && pid !== process.pid;
}

function prependCleanupFailures(stderr: string, failures: string[]): string {
  if (failures.length === 0) return stderr;
  return stderr.length > 0 ? `${failures.join('\n')}\n${stderr}` : failures.join('\n');
}

function captureOutputChunk(
  chunks: Buffer[],
  capturedBytes: number,
  chunk: Buffer | string,
): { capturedBytes: number; truncated: boolean } {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
  const remaining = NODE_EXEC_MAX_OUTPUT_BYTES - capturedBytes;
  if (remaining <= 0) {
    return { capturedBytes, truncated: buffer.length > 0 };
  }
  const captured = buffer.subarray(0, remaining);
  chunks.push(captured);
  return {
    capturedBytes: capturedBytes + captured.length,
    truncated: captured.length < buffer.length,
  };
}

function boundOutput(value: string): { value: string; truncated: boolean } {
  const rawBounded = truncateUtf8(value, NODE_EXEC_MAX_OUTPUT_BYTES);
  if (Buffer.byteLength(JSON.stringify(rawBounded), 'utf8') <= NODE_EXEC_MAX_JSON_STRING_BYTES) {
    return { value: rawBounded, truncated: rawBounded !== value };
  }

  let low = 0;
  let high = Buffer.byteLength(rawBounded, 'utf8');
  let best = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = truncateUtf8(rawBounded, middle);
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= NODE_EXEC_MAX_JSON_STRING_BYTES) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { value: best, truncated: true };
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) {
    return value;
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString('utf8');
}
