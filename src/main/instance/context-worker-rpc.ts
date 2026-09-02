export type RpcTimeoutMode = 'resolve-null' | 'reject';

interface RpcProcessHandle<TMessage> {
  postMessage(message: TMessage): void;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class ContextWorkerRpcTimeoutError extends Error {
  override readonly name = 'ContextWorkerRpcTimeoutError';
}

/** Owns correlation, timeout, and cleanup for the context worker's RPCs. */
export class ContextWorkerRpcTracker {
  private readonly pending = new Map<number, PendingRpc>();

  get size(): number {
    return this.pending.size;
  }

  post<TWorkerMessage, TMessage extends TWorkerMessage & { id: number }>(
    worker: RpcProcessHandle<TWorkerMessage> | null,
    message: TMessage,
    timeoutMs: number,
    timeoutMode: RpcTimeoutMode,
    onDropped: () => void,
  ): Promise<unknown> {
    if (!worker) {
      return timeoutMode === 'reject'
        ? Promise.reject(new Error('Context worker is unavailable'))
        : Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(message.id);
        onDropped();
        if (timeoutMode === 'reject') {
          reject(new ContextWorkerRpcTimeoutError(`Context worker RPC timed out after ${timeoutMs}ms`));
        } else {
          resolve(null);
        }
      }, timeoutMs);
      this.pending.set(message.id, { resolve, reject, timeout });
      try {
        worker.postMessage(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(message.id);
        if (timeoutMode === 'reject') {
          reject(error instanceof Error ? error : new Error(String(error)));
        } else {
          resolve(null);
        }
      }
    });
  }

  settle(id: number, result: unknown, error?: string): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(result);
    }
    return true;
  }

  rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
