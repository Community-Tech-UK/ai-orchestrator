import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  describeLockHolder,
  FileDesktopSessionLock,
} from './desktop-session-lock';

function makeLock(): FileDesktopSessionLock {
  const dir = mkdtempSync(join(tmpdir(), 'aio-desktop-lock-spec-'));
  return new FileDesktopSessionLock(join(dir, 'computer-use.lock'));
}

describe('FileDesktopSessionLock', () => {
  const releases: (() => Promise<void>)[] = [];

  afterEach(async () => {
    while (releases.length > 0) {
      const release = releases.pop();
      if (release) {
        await release();
      }
    }
  });

  it('acquires a free lock and reports the sanitized holder via inspect', async () => {
    const lock = makeLock();
    const result = await lock.acquire({
      instanceId: 'inst-1',
      provider: 'claude',
      appId: 'darwin-app:com.apple.Preview',
    });
    expect(result.kind).toBe('acquired');
    if (result.kind === 'acquired') {
      releases.push(result.release);
    }

    const holder = await lock.inspect();
    expect(holder).not.toBeNull();
    const described = describeLockHolder(holder!);
    expect(described).toMatchObject({
      instanceId: 'inst-1',
      provider: 'claude',
      appId: 'darwin-app:com.apple.Preview',
      purpose: 'computer-use',
    });
  });

  it('blocks a second acquisition while held and names the current holder', async () => {
    const lock = makeLock();
    const first = await lock.acquire({ instanceId: 'inst-1', appId: 'app-a' });
    expect(first.kind).toBe('acquired');
    if (first.kind === 'acquired') {
      releases.push(first.release);
    }

    const second = await lock.acquire({ instanceId: 'inst-2', appId: 'app-a' });
    expect(second.kind).toBe('blocked');
    if (second.kind === 'blocked') {
      expect(second.holder.purpose).toContain('computer-use');
      expect(second.holder.purpose).toContain('inst-1');
    }
  });

  it('frees the lock after release so inspect reports no holder', async () => {
    const lock = makeLock();
    const result = await lock.acquire({ instanceId: 'inst-1', appId: 'app-a' });
    expect(result.kind).toBe('acquired');
    if (result.kind === 'acquired') {
      await result.release();
    }

    expect(await lock.inspect()).toBeNull();
  });

  it('reports no holder for a never-acquired lock', async () => {
    const lock = makeLock();
    expect(await lock.inspect()).toBeNull();
  });
});
