import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileWatcherCache } from './file-watcher-cache';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('FileWatcherCache', () => {
  let cache: FileWatcherCache<string>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fwc-test-'));
    cache = new FileWatcherCache<string>();
  });

  afterEach(async () => {
    cache.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('caches a value and returns it', async () => {
    const loader = vi.fn(async () => 'hello');
    const result = await cache.get('key1', tmpDir, loader);
    expect(result).toBe('hello');
    expect(loader).toHaveBeenCalledOnce();
  });

  it('returns cached value without re-loading', async () => {
    const loader = vi.fn(async () => 'hello');
    await cache.get('key1', tmpDir, loader);
    const result = await cache.get('key1', tmpDir, loader);
    expect(result).toBe('hello');
    expect(loader).toHaveBeenCalledOnce(); // Not called again
  });

  it('invalidates cache when file changes', async () => {
    const testFile = path.join(tmpDir, 'tool.js');
    await fs.writeFile(testFile, 'v1');

    let version = 1;
    const loader = vi.fn(async () => `version-${version++}`);

    // Initial load
    const r1 = await cache.get('key1', tmpDir, loader);
    expect(r1).toBe('version-1');

    // Trigger file change
    await fs.writeFile(testFile, 'v2');

    // Should reload
    const r2 = await cache.get('key1', tmpDir, loader);
    expect(r2).toBe('version-2');
    expect(loader).toHaveBeenCalledTimes(2);
  }, 10000);

  it('clears cache manually', async () => {
    const loader = vi.fn(async () => 'hello');
    await cache.get('key1', tmpDir, loader);
    cache.invalidate('key1');
    await cache.get('key1', tmpDir, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
