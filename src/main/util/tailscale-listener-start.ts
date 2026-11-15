import { networkInterfaces } from 'os';
import { isTailscaleIpv4Address, isTailscaleIpv6Address } from './network-addresses';

export function isMissingTailscaleHost(host: string): boolean {
  const address = host.trim().replace(/^\[|\]$/g, '');
  if (!isTailscaleIpv4Address(address) && !isTailscaleIpv6Address(address)) return false;
  return !Object.values(networkInterfaces()).some(entries => entries?.some(entry => entry.address === address));
}

/** Owns a cancellable, shared start while a private interface is coming up. */
export class TailscaleListenerStart<T> {
  private controller: AbortController | null = null;
  private pending: Promise<T> | null = null;

  run(resolveHost: () => string | null, listen: (host: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.pending) {
      const signal = this.controller?.signal;
      if (!signal?.aborted) return this.pending;
      // A stop and a start can arrive in the same turn. Let the cancelled
      // attempt finish cleaning up before the new listener touches its fields.
      return this.pending.then(() => this.run(resolveHost, listen), error => {
        if (error !== signal.reason) throw error;
        return this.run(resolveHost, listen);
      });
    }
    const controller = new AbortController();
    this.controller = controller;
    const pending = this.wait(resolveHost, controller.signal).then(async host => {
      controller.signal.throwIfAborted();
      const result = await listen(host, controller.signal);
      controller.signal.throwIfAborted();
      return result;
    }).finally(() => {
      if (this.controller === controller) {
        this.controller = null;
        this.pending = null;
      }
    });
    this.pending = pending;
    return pending;
  }

  cancel(): void {
    this.controller?.abort();
  }

  private async wait(resolveHost: () => string | null, signal: AbortSignal): Promise<string> {
    for (;;) {
      signal.throwIfAborted();
      const host = resolveHost();
      if (host) return host;
      await new Promise<void>((resolve, reject) => {
        const aborted = (): void => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', aborted);
          resolve();
        }, 1000);
        timer.unref?.();
        signal.addEventListener('abort', aborted, { once: true });
      });
    }
  }
}
