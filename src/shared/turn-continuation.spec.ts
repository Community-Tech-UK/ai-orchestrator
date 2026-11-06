import { describe, expect, it, vi } from 'vitest';
import { buildInterruptedContext, SAFE_CONTINUATION } from './turn-continuation';

describe('interrupted turn context', () => {
  it('keeps the original request and partial output separate from the new continuation', () => {
    const result = buildInterruptedContext([
      { type: 'user', content: 'Inspect the local files' },
      { type: 'assistant', content: 'Read two files. Next: check imports.' },
    ]);
    expect(result).toContain('Inspect the local files');
    expect(result).toContain('Read two files. Next: check imports.');
    expect(SAFE_CONTINUATION).toBe('Continue from where you stopped. Check which actions already completed before retrying anything.');
  });

  it('takes only the latest turn and the last eight KiB of partial output, preserving UTF-8 characters', () => {
    const result = JSON.parse(buildInterruptedContext([
      { type: 'user', content: 'Old request' }, { type: 'assistant', content: 'OLD_PARTIAL' },
      { type: 'user', content: 'Current request' }, { type: 'assistant', content: 'prefix' + '界'.repeat(5000) + 'latest' },
    ]).split('\n').at(-1)!);
    expect(result.originalRequest).toBe('Current request');
    expect(result.partialOutput).not.toContain('OLD_PARTIAL');
    expect(result.partialOutput).not.toContain('prefix');
    expect(result.partialOutput.endsWith('latest')).toBe(true);
    expect(new TextEncoder().encode(result.partialOutput).length).toBeLessThanOrEqual(8192);
    expect(result.partialOutput).not.toContain('\uFFFD');
  });

  it('uses retained prompts if the original request has scrolled out of the live buffer', () => {
    expect(buildInterruptedContext([{ type: 'assistant', content: 'Partial reply' }], 'Original retained request'))
      .toContain('Original retained request');
  });

  it('bounds encoding work while retaining the exact UTF-8 suffix across messages', () => {
    const chunks = ['older'.repeat(20_000), '🙂'.repeat(3_000), 'latest'];
    const expected = new TextEncoder().encode(chunks.join('\n'));
    let offset = Math.max(0, expected.length - 8192);
    while (offset < expected.length && (expected[offset] & 0xc0) === 0x80) offset++;
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    try {
      const result = JSON.parse(buildInterruptedContext([
        { type: 'user', content: 'Continue the current work' },
        ...chunks.map(content => ({ type: 'assistant', content })),
      ]).split('\n').at(-1)!);
      expect(result.partialOutput).toBe(new TextDecoder().decode(expected.subarray(offset)));
      expect(encode).toHaveBeenCalledOnce();
      expect(encode.mock.calls[0][0]!.length).toBeLessThanOrEqual(8192);
    } finally {
      encode.mockRestore();
    }
  });
});
