import { shortHash } from './short-hash';

describe('shortHash', () => {
  it('returns a stable lowercase hex digest for the same input', () => {
    const first = shortHash('cache-key:workspace:/tmp/project');
    const second = shortHash('cache-key:workspace:/tmp/project');

    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{8}$/);
  });

  it('distinguishes empty input, ordering, and small content changes', () => {
    const values = [
      shortHash(''),
      shortHash('ab'),
      shortHash('ba'),
      shortHash('abc'),
      shortHash('abd'),
    ];

    expect(new Set(values).size).toBe(values.length);
  });

  it('handles unicode input deterministically by hashing UTF-16 code units', () => {
    expect(shortHash('hello')).toBe(shortHash('hello'));
    expect(shortHash('hello')).not.toBe(shortHash('hello!'));
    expect(shortHash('cafe')).not.toBe(shortHash('cafe\u0301'));
  });
});
