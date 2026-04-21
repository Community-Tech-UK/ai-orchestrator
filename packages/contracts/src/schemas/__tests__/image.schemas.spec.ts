import { describe, expect, it } from 'vitest';
import {
  ImageResolveRequestSchema,
  ImageResolveResponseSchema,
} from '../image.schemas';

describe('ImageResolveRequestSchema', () => {
  it('accepts a valid local request', () => {
    const result = ImageResolveRequestSchema.safeParse({
      kind: 'local',
      src: '/Users/test/foo.png',
    });

    expect(result.success).toBe(true);
  });

  it('accepts optional alt text', () => {
    const result = ImageResolveRequestSchema.safeParse({
      kind: 'remote',
      src: 'https://example.com/foo.png',
      alt: 'Screenshot',
    });

    expect(result.success).toBe(true);
  });

  it('rejects an empty source', () => {
    const result = ImageResolveRequestSchema.safeParse({
      kind: 'data',
      src: '',
    });

    expect(result.success).toBe(false);
  });
});

describe('ImageResolveResponseSchema', () => {
  it('accepts a success response with a data URL attachment', () => {
    const result = ImageResolveResponseSchema.safeParse({
      ok: true,
      attachment: {
        name: 'image.png',
        type: 'image/png',
        size: 123,
        data: 'data:image/png;base64,abc123',
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects a success response without attachment data', () => {
    const result = ImageResolveResponseSchema.safeParse({
      ok: true,
      attachment: {
        name: 'image.png',
        type: 'image/png',
        size: 123,
      },
    });

    expect(result.success).toBe(false);
  });

  it('accepts a structured failure response', () => {
    const result = ImageResolveResponseSchema.safeParse({
      ok: false,
      reason: 'fetch_failed',
      message: 'Remote image fetch returned HTTP 500',
    });

    expect(result.success).toBe(true);
  });
});
