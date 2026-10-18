import { hasProviderUsage, markProviderDispatchNotStarted } from '../adapters/provider-dispatch-status';
import type { EventEmitter } from 'node:events';
import type { CliResponse, CliUsage } from '../adapters/base-cli-adapter';

/** Native errors remain observable immediately; a one-shot's bill ends at finality. */
export function waitForWorkerTurn(
  adapter: EventEmitter,
  adapterName: string,
  start: () => Promise<unknown>,
  parseOutput: () => CliResponse,
  hasOutput: () => boolean,
  hasProcess: () => boolean,
  terminate: () => Promise<void>,
  wasDispatched: () => boolean,
): Promise<CliResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let nativeError: (Error & { partialUsage?: CliUsage }) | undefined;
    const cleanup = () => {
      adapter.off('complete', onComplete);
      adapter.off('error', onError);
      adapter.off('exit', onExit);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onComplete = (response: CliResponse) => {
      if (settled) return;
      if (!wasDispatched() && !hasProviderUsage(response.usage)) {
        nativeError = markProviderDispatchNotStarted(nativeError ?? new Error(`${adapterName} stopped before provider dispatch`));
      }
      if (!nativeError && response.metadata?.['turnErrored'] === true) {
        nativeError = new Error(String(response.metadata['claudeResultError'] ?? `${adapterName} reported an error result`));
      }
      if (nativeError) {
        const usage = Object.fromEntries(Object.entries(response.usage ?? {}).filter(([, value]) => value !== undefined));
        nativeError.partialUsage = { ...nativeError.partialUsage, ...usage };
        fail(nativeError);
        return;
      }
      settled = true;
      cleanup();
      resolve(response);
    };
    const onError = (error: Error) => { nativeError ??= error; };
    const onExit = (code: number | null) => {
      if (settled) return;
      if (code === 0 || hasOutput()) onComplete(parseOutput());
      else {
        const error = nativeError ?? new Error(`${adapterName} exited with code ${code}`);
        fail(wasDispatched() ? error : markProviderDispatchNotStarted(error));
      }
    };
    adapter.once('complete', onComplete);
    adapter.on('error', onError);
    adapter.once('exit', onExit);
    const startFailed = (error: Error): void => {
      if (settled) return;
      if (!hasProcess()) {
        if (hasOutput()) { onError(error); onComplete(parseOutput()); }
        else fail(markProviderDispatchNotStarted(error));
        return;
      }
      // An accepted child may already have billed output before a write ACK fails.
      onError(error);
      void terminate().catch(failure => {
        if (settled) return;
        onError(failure); onComplete(parseOutput());
      });
    };
    try { void start().catch(startFailed); } catch (error) {
      startFailed(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
