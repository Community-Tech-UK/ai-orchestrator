import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
  },
}));

import { normalizeToolResultPayload } from './tool-result-normalizer';

describe('normalizeToolResultPayload', () => {
  it('preserves structured outputs and emits structured telemetry', () => {
    const normalized = normalizeToolResultPayload({ ok: true, files: 3 }, 'success');

    expect(normalized.output).toEqual({ ok: true, files: 3 });
    expect(normalized.outputMetadata).toEqual(expect.objectContaining({
      kind: 'structured',
      truncated: false,
    }));
    expect(normalized.telemetry).toEqual(expect.objectContaining({
      status: 'success',
      outputKind: 'structured',
      truncated: false,
    }));
  });

  it('truncates oversized text output and exposes metadata', () => {
    const largeOutput = Array.from({ length: 2_500 }, (_, index) => `line-${index}`).join('\n');

    const normalized = normalizeToolResultPayload(largeOutput, 'success');

    expect(normalized.outputMetadata).toEqual(expect.objectContaining({
      kind: 'text',
      truncated: true,
    }));
    expect(normalized.telemetry).toEqual(expect.objectContaining({
      status: 'success',
      outputKind: 'text',
      truncated: true,
    }));
    expect(typeof normalized.output).toBe('string');
    expect(normalized.output).toContain('[Output truncated.');
  });

  it('emits empty metadata for missing output', () => {
    const normalized = normalizeToolResultPayload(undefined, 'error');

    expect(normalized.output).toBeUndefined();
    expect(normalized.outputMetadata).toEqual({
      kind: 'empty',
      truncated: false,
      byteCount: 0,
      lineCount: 0,
    });
    expect(normalized.telemetry).toEqual({
      status: 'error',
      outputKind: 'empty',
      truncated: false,
      byteCount: 0,
      lineCount: 0,
    });
  });
});
