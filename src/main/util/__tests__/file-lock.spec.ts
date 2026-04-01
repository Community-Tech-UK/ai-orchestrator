import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { acquireLock, withLock } from '../file-lock';

describe('file-lock', () => {
  let tmpDir: string;
  let lockPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
    lockPath = path.join(tmpDir, 'test.lock');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  describe('acquireLock', () => {
    it('acquires lock on fresh path', async () => {
      const result = await acquireLock(lockPath, { purpose: 'test' });
      expect(result.kind).toBe('acquired');
      if (result.kind === 'acquired') {
        await result.release();
      }
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('returns blocked when lock already held', async () => {
      const first = await acquireLock(lockPath);
      expect(first.kind).toBe('acquired');

      const second = await acquireLock(lockPath);
      expect(second.kind).toBe('blocked');
      if (second.kind === 'blocked') {
        expect(second.holder.pid).toBe(process.pid);
      }

      if (first.kind === 'acquired') await first.release();
    });

    it('recovers stale lock from dead process', async () => {
      const staleLock = {
        pid: 999999,
        sessionId: 'dead-session',
        acquiredAt: Date.now() - 60000,
        purpose: 'stale',
      };
      fs.writeFileSync(lockPath, JSON.stringify(staleLock));

      const result = await acquireLock(lockPath, { purpose: 'recovery' });
      expect(result.kind).toBe('acquired');
      if (result.kind === 'acquired') {
        await result.release();
      }
    });

    it('lock file contains correct holder info', async () => {
      const result = await acquireLock(lockPath, { purpose: 'info-check' });
      expect(result.kind).toBe('acquired');

      const content = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      expect(content.pid).toBe(process.pid);
      expect(content.purpose).toBe('info-check');
      expect(typeof content.acquiredAt).toBe('number');

      if (result.kind === 'acquired') await result.release();
    });

    it('release is idempotent', async () => {
      const result = await acquireLock(lockPath);
      expect(result.kind).toBe('acquired');
      if (result.kind === 'acquired') {
        await result.release();
        await result.release();
      }
    });
  });

  describe('withLock', () => {
    it('acquires lock, runs fn, releases', async () => {
      let insideLock = false;
      await withLock(lockPath, async () => {
        insideLock = true;
        expect(fs.existsSync(lockPath)).toBe(true);
      });
      expect(insideLock).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('releases lock even if fn throws', async () => {
      await expect(withLock(lockPath, async () => {
        throw new Error('boom');
      })).rejects.toThrow('boom');
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('throws when lock is blocked and no timeout', async () => {
      const first = await acquireLock(lockPath);
      await expect(withLock(lockPath, async () => {})).rejects.toThrow(/blocked/i);
      if (first.kind === 'acquired') await first.release();
    });
  });
});
