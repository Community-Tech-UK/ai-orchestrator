export type ToolRwLockMode = 'read' | 'write';

export interface ToolRwLockRequest {
  mode: ToolRwLockMode;
  paths: string[];
}

interface ActiveLock {
  mode: ToolRwLockMode;
  paths: string[];
}

interface PendingLock extends ActiveLock {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

function normalizePathScope(path: string): string {
  const cleaned = path.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  return cleaned || '.';
}

function overlaps(a: string, b: string): boolean {
  const left = normalizePathScope(a);
  const right = normalizePathScope(b);
  if (left === '.' || right === '.') return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function pathSetsOverlap(left: string[], right: string[]): boolean {
  return left.some((a) => right.some((b) => overlaps(a, b)));
}

export class ToolRwLock {
  private active: ActiveLock[] = [];
  private pending: PendingLock[] = [];

  async runRead<T>(paths: string[], fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.run({ mode: 'read', paths }, fn, signal);
  }

  async runWrite<T>(paths: string[], fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.run({ mode: 'write', paths }, fn, signal);
  }

  async run<T>(request: ToolRwLockRequest, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(request, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private acquire(request: ToolRwLockRequest, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new Error('lock acquisition aborted'));
    }
    const lock = {
      mode: request.mode,
      paths: request.paths.length ? request.paths.map(normalizePathScope) : ['.'],
    };

    if (this.canAcquire(lock)) {
      return Promise.resolve(this.activate(lock));
    }

    return new Promise((resolve, reject) => {
      const pending: PendingLock = {
        ...lock,
        resolve: (release) => {
          this.cleanupPendingAbort(pending);
          resolve(release);
        },
        reject,
        signal,
      };
      if (signal) {
        pending.abortListener = () => {
          const index = this.pending.indexOf(pending);
          if (index >= 0) this.pending.splice(index, 1);
          this.cleanupPendingAbort(pending);
          reject(new Error('lock acquisition aborted'));
        };
        signal.addEventListener('abort', pending.abortListener, { once: true });
      }
      this.pending.push(pending);
    });
  }

  private canAcquire(lock: ActiveLock): boolean {
    return !this.active.some((active) => {
      if (!pathSetsOverlap(active.paths, lock.paths)) return false;
      return active.mode === 'write' || lock.mode === 'write';
    });
  }

  private activate(lock: ActiveLock): () => void {
    this.active.push(lock);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const index = this.active.indexOf(lock);
      if (index >= 0) this.active.splice(index, 1);
      this.drain();
    };
  }

  private drain(): void {
    for (let index = 0; index < this.pending.length;) {
      const pending = this.pending[index];
      if (!this.canAcquire(pending)) {
        index++;
        continue;
      }
      this.pending.splice(index, 1);
      pending.resolve(this.activate(pending));
    }
  }

  private cleanupPendingAbort(pending: PendingLock): void {
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener('abort', pending.abortListener);
    }
    pending.abortListener = undefined;
    pending.signal = undefined;
  }
}
