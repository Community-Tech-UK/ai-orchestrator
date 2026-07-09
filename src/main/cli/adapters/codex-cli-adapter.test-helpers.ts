import type { ChildProcess } from 'child_process';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import { vi } from 'vitest';

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
