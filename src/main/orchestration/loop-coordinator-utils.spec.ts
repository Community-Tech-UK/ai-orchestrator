import { describe, expect, it } from 'vitest';
import {
  boundFullOutput,
  excerpt,
  MAX_LOOP_OUTPUT_FULL_CHARS,
} from './loop-coordinator-utils';

describe('boundFullOutput', () => {
  it('returns the empty string unchanged', () => {
    expect(boundFullOutput('')).toBe('');
  });

  it('returns a normal-sized closing message verbatim (no truncation)', () => {
    const msg = 'Implemented the change.\n\nFinding 1 (valid): ...\nFinding 2: ...';
    expect(boundFullOutput(msg)).toBe(msg);
  });

  it('keeps everything right up to the safety cap untouched', () => {
    const atCap = 'x'.repeat(MAX_LOOP_OUTPUT_FULL_CHARS);
    expect(boundFullOutput(atCap)).toBe(atCap);
  });

  it('truncates only when the message exceeds the safety cap, with a clear marker', () => {
    const tooBig = 'y'.repeat(MAX_LOOP_OUTPUT_FULL_CHARS + 5_000);
    const bounded = boundFullOutput(tooBig);
    expect(bounded.length).toBeLessThan(tooBig.length);
    expect(bounded).toContain('(truncated');
    // The head is preserved (not a head+tail slice like excerpt()).
    expect(bounded.startsWith('y'.repeat(1_000))).toBe(true);
  });

  it('is far more generous than the detection excerpt', () => {
    // The detection excerpt keeps a tiny head+tail; outputFull keeps the
    // whole realistic message. This guards the two-cap design.
    const msg = 'z'.repeat(20_000);
    expect(excerpt(msg).length).toBeLessThan(boundFullOutput(msg).length);
    expect(boundFullOutput(msg)).toBe(msg);
  });
});
