/**
 * LF-1 (loopfixex.md) — tool-result clearing: offload oversized iteration
 * output to the cache (compact preview) when clearToolResults is enabled.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  LOOP_OUTPUT_EXTERNALIZE_THRESHOLD,
  maybeExternalizeLoopOutput,
} from './loop-output-externalize';

describe('maybeExternalizeLoopOutput (LF-1)', () => {
  const externalize = vi.fn(async (_tool: string, out: string) => `PREVIEW[head…tail] (${out.length} chars cached)`);

  it('returns the output unchanged when clearToolResults is disabled', async () => {
    const big = 'x'.repeat(LOOP_OUTPUT_EXTERNALIZE_THRESHOLD + 100);
    await expect(maybeExternalizeLoopOutput(big, false, externalize)).resolves.toBe(big);
    expect(externalize).not.toHaveBeenCalled();
  });

  it('returns the output unchanged when it is at/under the threshold', async () => {
    const small = 'x'.repeat(LOOP_OUTPUT_EXTERNALIZE_THRESHOLD);
    await expect(maybeExternalizeLoopOutput(small, true, externalize)).resolves.toBe(small);
    expect(externalize).not.toHaveBeenCalled();
  });

  it('offloads an oversized output and returns the compact preview', async () => {
    const big = 'y'.repeat(LOOP_OUTPUT_EXTERNALIZE_THRESHOLD + 1);
    const result = await maybeExternalizeLoopOutput(big, true, externalize);
    expect(externalize).toHaveBeenCalledWith('loop-iteration-output', big, undefined);
    expect(result).toContain('cached');
    expect(result.length).toBeLessThan(big.length);
  });

  it('passes the delegate-inspection hint flag to the output externalizer', async () => {
    const big = 'y'.repeat(LOOP_OUTPUT_EXTERNALIZE_THRESHOLD + 1);
    await maybeExternalizeLoopOutput(big, true, externalize, { delegateInspectionHint: true });

    expect(externalize).toHaveBeenCalledWith(
      'loop-iteration-output',
      big,
      { delegateInspectionHint: true },
    );
  });

  it('degrades to the full output when the externalizer throws', async () => {
    const boom = vi.fn(async () => { throw new Error('cache write failed'); });
    const big = 'z'.repeat(LOOP_OUTPUT_EXTERNALIZE_THRESHOLD + 1);
    await expect(maybeExternalizeLoopOutput(big, true, boom)).resolves.toBe(big);
  });
});
