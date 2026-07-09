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
}
