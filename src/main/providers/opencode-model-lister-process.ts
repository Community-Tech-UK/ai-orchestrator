import type { ChildProcess } from 'node:child_process';
import { killProcessGroup } from '../cli/adapters/base-cli-process-utils';

// Windows taskkill can block for 5 seconds per signal. Arm escalation before
// SIGTERM so both attempts finish by 18 + max(2, 5) + 5 = 28 seconds, below
// the shared OpenCode process gate's 30-second maximum hold.
const MODEL_LIST_TIMEOUT_MS = 18_000;
const KILL_GRACE_MS = 2_000;

/** The caller owns the database gate; failure retains it until the child closes. */
export function captureOpenCodeModelList(
  spawnLister: () => ChildProcess,
  errors: { timeout: string; process: string },
): Promise<{ output: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try { proc = spawnLister(); }
    catch { reject(new Error(errors.process)); return; }
    let output = '';
    let failure: Error | undefined;
    let settled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const signal = (value: NodeJS.Signals): void => {
      if (!killProcessGroup(proc.pid, value)) {
        try { proc.kill(value); } catch { /* The close event still owns release. */ }
      }
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      clearTimeout(escalation);
      proc.removeListener('close', onClose);
      proc.removeListener('error', onError);
      proc.stdout?.removeListener('data', onData);
      proc.stdout?.removeListener('error', onStreamError);
      proc.stderr?.removeListener('data', discardStderr);
      proc.stderr?.removeListener('error', onStreamError);
      output = '';
    };
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      const captured = output;
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(errors.process));
      else resolve({ output: captured, code });
    };
    const stop = (error: Error): void => {
      if (settled || failure) return;
      failure = error;
      output = '';
      clearTimeout(timer);
      // Never settle on a kill request. Arm this before the Windows helper,
      // which can synchronously block; close alone proves release is safe.
      escalation = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS);
      signal('SIGTERM');
    };
    const onData = (data: Buffer): void => { if (!failure) output += data.toString(); };
    const discardStderr = (): void => { /* Drain without retaining native diagnostics. */ };
    const onClose = (code: number | null): void => finish(code);
    const onStreamError = (): void => stop(new Error(errors.process));
    const onError = (): void => {
      const error = new Error(errors.process);
      // A failed spawn never acquired a pid; there is no live database opener.
      if (proc.pid === undefined) { failure = error; finish(null); }
      else stop(error);
    };
    const timer = setTimeout(() => stop(new Error(errors.timeout)), MODEL_LIST_TIMEOUT_MS);
    proc.stdout?.on('data', onData);
    proc.stdout?.on('error', onStreamError);
    proc.stderr?.on('data', discardStderr);
    proc.stderr?.on('error', onStreamError);
    proc.on('close', onClose);
    proc.on('error', onError);
  });
}
