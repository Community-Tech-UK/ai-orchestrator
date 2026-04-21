import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-app-data') },
}));

import { ImageCache } from './image-cache';

describe('ImageCache', () => {
  let cacheDir: string;
  let now = 1000;

  beforeEach(() => {
    ImageCache._resetForTesting();
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-cache-'));
    now = 1000;
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('stores and retrieves a cached image', async () => {
    const cache = ImageCache.getInstance({
      cacheDir,
      now: () => now,
    });

    await cache.set('https://example.com/a.png', 'image/png', Buffer.from('image-a'));
    const cached = await cache.get('https://example.com/a.png');

    expect(cached).not.toBeNull();
    expect(cached?.contentType).toBe('image/png');
    expect(cached?.buffer.equals(Buffer.from('image-a'))).toBe(true);
  });

  it('evicts the oldest cached object when size exceeds the limit', async () => {
    const cache = ImageCache.getInstance({
      cacheDir,
      maxBytes: 6,
      now: () => ++now,
    });

    await cache.set('https://example.com/a.png', 'image/png', Buffer.from('1234'));
    await cache.set('https://example.com/b.png', 'image/png', Buffer.from('5678'));

    expect(await cache.get('https://example.com/a.png')).toBeNull();
    expect(await cache.get('https://example.com/b.png')).not.toBeNull();
  });
});
