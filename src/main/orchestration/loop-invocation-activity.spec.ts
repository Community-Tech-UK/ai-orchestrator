import { describe, it, expect } from 'vitest';
import { boundActivityDetail } from './loop-invocation-activity';

/**
 * LT-021 follow-up. Widening the renderer-boundary schema means `tool_use` and
 * `tool_result` details cross IPC for the first time, and those carry raw tool
 * input and results. This bounds them; only the IPC copy is truncated, never
 * the record kept for the loop's own evidence.
 */
describe('boundActivityDetail', () => {
  it('passes short strings and non-string scalars through unchanged', () => {
    const detail = {
      name: 'Read',
      count: 42,
      ok: true,
      missing: null,
      absent: undefined,
    };
    expect(boundActivityDetail(detail)).toEqual(detail);
  });

  it('truncates a long string and says how much was dropped', () => {
    const long = 'x'.repeat(2500);
    const out = boundActivityDetail({ result: long });
    const result = out['result'] as string;

    expect(result.startsWith('x'.repeat(2000))).toBe(true);
    expect(result).toContain('[truncated 500 chars]');
    expect(result.length).toBeLessThan(long.length);
  });

  it('keeps a small object as an object, but truncates a large one to a string', () => {
    const small = { a: 1, b: 'two' };
    expect(boundActivityDetail({ input: small })['input']).toEqual(small);

    const large = { blob: 'y'.repeat(4000) };
    const out = boundActivityDetail({ input: large })['input'];
    expect(typeof out).toBe('string');
    expect(out as string).toContain('[truncated');
  });

  it('does not throw on a circular structure', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;

    const out = boundActivityDetail({ input: circular });
    expect(out['input']).toBe('[unserializable]');
  });

  it('replaces a function rather than letting structured clone throw', () => {
    const out = boundActivityDetail({ cb: () => 'nope' });
    expect(out['cb']).toBe('[function]');
  });

  it('bounds every key, not just the first', () => {
    const out = boundActivityDetail({
      a: 'a'.repeat(2500),
      b: 'b'.repeat(2500),
    });
    expect(out['a'] as string).toContain('[truncated');
    expect(out['b'] as string).toContain('[truncated');
  });

  it('does not mutate the caller\'s object — the evidence record keeps the full detail', () => {
    const original = { result: 'z'.repeat(2500) };
    const snapshot = original.result;
    boundActivityDetail(original);
    expect(original.result).toBe(snapshot);
    expect(original.result.length).toBe(2500);
  });
});
