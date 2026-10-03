import type { ChildProcess } from 'child_process';
import type { Writable } from 'stream';

const activeWrites = new WeakMap<Writable, number>();
const processErrors = new WeakSet<Error>();

export class StdinWriteProcessExitError extends Error {
  readonly code = 'EPIPE';
  constructor(readonly exitCode: number | null, readonly signal: NodeJS.Signals | null) {
    super('process exited before stdin write completed');
  }
}

/** The adapter's permanent process error listener already reported this failure. */
export function isStdinWriteProcessError(error: Error): boolean {
  return processErrors.has(error);
}

/** The awaiting writer owns stream failures; the adapter's permanent listener must not emit twice. */
export function hasActiveStdinWrite(stdin: Writable): boolean {
  return (activeWrites.get(stdin) ?? 0) > 0;
}

function closedPipe(message: string): Error {
  return Object.assign(new Error(message), { code: 'EPIPE' });
}

/** Buffer capacity (write's boolean or drain) is not acknowledgement of the submitted bytes. */
export function writeChildStdin(
  proc: ChildProcess | null,
  data: string,
  onAccepted?: () => void,
  timeoutMs = 5_000,
): Promise<void> {
  const stdin = proc?.stdin;
  if (!proc || !stdin?.writable || stdin.destroyed || proc.killed
    || proc.exitCode != null || proc.signalCode != null) {
    return Promise.reject(closedPipe('stdin closed before input could be written'));
  }

  return new Promise<void>((resolve, reject) => {
    let writing = true;
    let callbackComplete = false;
    let failure: Error | undefined;
    let settled = false;
    let errorListenerRemoved = false;
    let delayedCleanup: ReturnType<typeof setImmediate> | undefined;
    activeWrites.set(stdin, (activeWrites.get(stdin) ?? 0) + 1);

    const removeErrorListener = (): void => {
      if (errorListenerRemoved) return;
      errorListenerRemoved = true;
      if (delayedCleanup) clearImmediate(delayedCleanup);
      stdin.off('error', onError);
      const remaining = (activeWrites.get(stdin) ?? 1) - 1;
      if (remaining) activeWrites.set(stdin, remaining);
      else activeWrites.delete(stdin);
    };
    const cleanup = (failed: boolean): void => {
      clearTimeout(timer);
      proc.off('exit', onExit);
      proc.off('close', onExit);
      proc.off('error', onProcessError);
      stdin.off('close', onClose);
      // Node may emit error on nextTick AFTER invoking a failed write callback.
      // Keep that error owned through its emission, with a bounded fallback.
      if (failed) delayedCleanup = setImmediate(removeErrorListener);
      else removeErrorListener();
    };
    const settle = (): void => {
      if (writing || settled || (!failure && !callbackComplete)) return;
      settled = true;
      cleanup(Boolean(failure));
      if (failure) {
        const error = failure;
        // Let Node publish the matching stream error before the caller settles
        // its receipt or tears down the process and stream listeners.
        setImmediate(() => reject(error));
      }
      else { onAccepted?.(); resolve(); }
    };
    const fail = (error: Error): void => {
      failure ??= error;
      settle();
    };
    const onError = (error: Error): void => {
      if (!settled) fail(error);
      if (settled) removeErrorListener();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (!callbackComplete) fail(new StdinWriteProcessExitError(code, signal));
    };
    const onProcessError = (error: Error): void => {
      processErrors.add(error);
      fail(error);
    };
    const onClose = (): void => {
      if (!callbackComplete) fail(closedPipe('stdin closed before write completed'));
    };
    const timer = setTimeout(() => fail(new Error(`stdin write timeout after ${timeoutMs}ms — process may be stuck`)), timeoutMs);
    proc.once('exit', onExit);
    proc.once('close', onExit);
    proc.once('error', onProcessError);
    stdin.once('close', onClose);
    stdin.on('error', onError);
    try {
      stdin.write(data, (error?: Error | null) => {
        if (settled) return;
        if (error) failure ??= error;
        callbackComplete = true;
        settle();
      });
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error));
    } finally {
      // A synchronous callback cannot accept a write that subsequently throws.
      writing = false;
      settle();
    }
  });
}
