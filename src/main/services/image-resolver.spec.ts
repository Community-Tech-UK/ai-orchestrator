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
import { ImageResolver } from './image-resolver';

describe('ImageResolver', () => {
  let tmpDir: string;

  beforeEach(() => {
    ImageCache._resetForTesting();
    ImageResolver._resetForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-resolver-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves local images into attachments', async () => {
    const filePath = path.join(tmpDir, 'preview.png');
    fs.writeFileSync(filePath, Buffer.from('png-data'));

    const resolver = ImageResolver.getInstance({
      cache: ImageCache.getInstance({ cacheDir: path.join(tmpDir, 'cache') }),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    const result = await resolver.resolve({
      kind: 'local',
      src: filePath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment.type).toBe('image/png');
    expect(result.attachment.data.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('caches successful remote fetches', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({
      contentType: 'image/png',
      body: Buffer.from('remote-image'),
    }));

    const resolver = ImageResolver.getInstance({
      cache: ImageCache.getInstance({ cacheDir: path.join(tmpDir, 'cache') }),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const first = await resolver.resolve({
      kind: 'remote',
      src: 'https://example.com/image',
    });
    const second = await resolver.resolve({
      kind: 'remote',
      src: 'https://example.com/image',
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed data URIs', async () => {
    const resolver = ImageResolver.getInstance({
      cache: ImageCache.getInstance({ cacheDir: path.join(tmpDir, 'cache') }),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    const result = await resolver.resolve({
      kind: 'data',
      src: 'data:image/png;base64,%%%not-base64%%%',
    });

    expect(result).toEqual({
      ok: false,
      reason: 'invalid_data_uri',
      message: 'Invalid image data URI',
    });
  });

  it('sanitizes svg payloads', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>`;
    const src = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
    const resolver = ImageResolver.getInstance({
      cache: ImageCache.getInstance({ cacheDir: path.join(tmpDir, 'cache') }),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    const result = await resolver.resolve({ kind: 'data', src });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sanitized = Buffer.from(result.attachment.data.split(',', 2)[1], 'base64').toString('utf8');
    expect(sanitized).not.toContain('<script>');
    expect(sanitized).toContain('<rect');
  });
});

function mockResponse(input: {
  contentType: string;
  body: Buffer;
  status?: number;
}): Pick<Response, 'ok' | 'status' | 'headers' | 'arrayBuffer'> {
  return {
    ok: (input.status ?? 200) >= 200 && (input.status ?? 200) < 300,
    status: input.status ?? 200,
    headers: new Headers({
      'content-type': input.contentType,
      'content-length': String(input.body.length),
    }),
    arrayBuffer: async () =>
      input.body.buffer.slice(
        input.body.byteOffset,
        input.body.byteOffset + input.body.byteLength,
      ),
  };
}
