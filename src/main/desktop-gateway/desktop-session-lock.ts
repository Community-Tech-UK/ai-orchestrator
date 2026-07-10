import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  acquireLock,
  type LockHolder,
} from '../util/file-lock';

export interface DesktopSessionLockAcquireRequest {
  instanceId: string;
  provider?: string;
  appId: string;
}

export type DesktopSessionLockResult =
  | { kind: 'acquired'; release: () => Promise<void> }
  | { kind: 'blocked'; holder: LockHolder };

export interface DesktopSessionLock {
  acquire(request: DesktopSessionLockAcquireRequest): Promise<DesktopSessionLockResult>;
  /** Reads the current holder without acquiring, or null when free/stale. */
  inspect(): Promise<LockHolder | null>;
}

function parsePurpose(purpose: string | undefined): {
  instanceId?: string;
  provider?: string;
  appId?: string;
} {
  if (!purpose) {
    return {};
  }
  // appId can itself contain colons (e.g. `darwin-app:com.apple.Preview`), so
  // only split off the first three fixed fields and rejoin the remainder.
  const [kind, instanceId, provider, ...appIdParts] = purpose.split(':');
  if (kind !== 'computer-use') {
    return {};
  }
  const appId = appIdParts.join(':');
  return {
    ...(instanceId ? { instanceId } : {}),
    ...(provider && provider !== 'unknown-provider' ? { provider } : {}),
    ...(appId ? { appId } : {}),
  };
}

export function describeLockHolder(holder: LockHolder): {
  instanceId?: string;
  provider?: string;
  appId?: string;
  startedAt?: number;
  purpose?: string;
} {
  return {
    ...parsePurpose(holder.purpose),
    startedAt: holder.acquiredAt,
    purpose: 'computer-use',
  };
}

export class FileDesktopSessionLock implements DesktopSessionLock {
  constructor(private readonly lockPath: string) {}

  async acquire(request: DesktopSessionLockAcquireRequest): Promise<DesktopSessionLockResult> {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    return acquireLock(this.lockPath, {
      purpose: [
        'computer-use',
        request.instanceId,
        request.provider ?? 'unknown-provider',
        request.appId,
      ].join(':'),
    });
  }

  async inspect(): Promise<LockHolder | null> {
    try {
      const content = await fs.promises.readFile(this.lockPath, 'utf-8');
      const holder = JSON.parse(content) as LockHolder;
      if (!isProcessAlive(holder.pid)) {
        return null;
      }
      return holder;
    } catch {
      return null;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
