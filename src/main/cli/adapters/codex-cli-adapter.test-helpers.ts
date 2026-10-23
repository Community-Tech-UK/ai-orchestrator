import type { ChildProcess } from 'child_process';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { CodexHomeManager } from './codex/codex-home-manager';

export type MockChildProcess = Omit<ChildProcess, 'killed'> & EventEmitter & {
  emitClose: (code?: number | null, signal?: string | null) => void;
  killed: boolean;
  stderr: PassThrough;
  stdin: PassThrough;
  stdout: PassThrough;
};

export function createMockProcess(): MockChildProcess {
  const proc = new EventEmitter() as MockChildProcess;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.killed = false;
  // Real ChildProcess.exitCode is `null` until exit; not `undefined`.
  // Liveness checks in adapters depend on this distinction.
  (proc as unknown as { exitCode: number | null }).exitCode = null;
  (proc as unknown as { pid: number }).pid = 99999;
  proc.kill = vi.fn().mockImplementation(() => {
    proc.killed = true;
    return true;
  }) as ChildProcess['kill'];
  proc.emitClose = (code = 0, signal = null) => {
    (proc as unknown as { exitCode: number | null }).exitCode = code;
    proc.emit('close', code, signal);
  };
  return proc;
}

export function queueCodexRun(
  spawnSpy: { mockReturnValueOnce(value: ChildProcess): unknown },
  options: {
    code?: number;
    stderrLines?: string[];
    stdoutLines?: string[];
  },
): MockChildProcess {
  const proc = createMockProcess();
  spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);
  setTimeout(() => {
    for (const line of options.stdoutLines || []) {
      proc.stdout.write(`${line}\n`);
    }
    proc.stdout.end();

    for (const line of options.stderrLines || []) {
      proc.stderr.write(`${line}\n`);
    }
    proc.stderr.end();

    proc.emitClose(options.code ?? 0, null);
  }, 0);
  return proc;
}

/** Collect all data written to a PassThrough stream. */
export function collectStdin(proc: MockChildProcess): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    proc.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stdin.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

// Mocked app-server processes may never exit, so adapter termination cannot own
// fixture cleanup. Track the real manager receiver even if a test fails or
// restores its spies before our teardown runs.
const preparedManagers = new Set<CodexHomeManager>();
const preparedDirectories = new Set<string>();
const originalCleanup = CodexHomeManager.prototype.cleanup;
const realPrepare = {
  prepareMcpFreeHome: CodexHomeManager.prototype.prepareMcpFreeHome,
  prepareSessionIsolatedHome: CodexHomeManager.prototype.prepareSessionIsolatedHome,
  prepareHomeWithMcpConfig: CodexHomeManager.prototype.prepareHomeWithMcpConfig,
};

beforeEach(() => {
  vi.spyOn(CodexHomeManager.prototype, 'prepareMcpFreeHome').mockImplementation(function (this: CodexHomeManager) {
    preparedManagers.add(this);
    const directory = realPrepare.prepareMcpFreeHome.call(this);
    if (directory) preparedDirectories.add(directory);
    return directory;
  });
  vi.spyOn(CodexHomeManager.prototype, 'prepareSessionIsolatedHome').mockImplementation(function (this: CodexHomeManager) {
    preparedManagers.add(this);
    const directory = realPrepare.prepareSessionIsolatedHome.call(this);
    if (directory) preparedDirectories.add(directory);
    return directory;
  });
  vi.spyOn(CodexHomeManager.prototype, 'prepareHomeWithMcpConfig').mockImplementation(function (this: CodexHomeManager, config: string) {
    preparedManagers.add(this);
    const directory = realPrepare.prepareHomeWithMcpConfig.call(this, config);
    if (directory) preparedDirectories.add(directory);
    return directory;
  });
});

export function cleanupPreparedCodexHomes(): void {
  try {
    for (const manager of preparedManagers) originalCleanup.call(manager);
  } finally {
    preparedManagers.clear();
    try {
      for (const directory of preparedDirectories) rmSync(directory, { recursive: true, force: true });
    } finally {
      preparedDirectories.clear();
    }
  }
}

afterEach(cleanupPreparedCodexHomes);
