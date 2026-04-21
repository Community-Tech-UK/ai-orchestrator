import { describe, it, expect } from 'vitest';
import type { CanonicalCliType } from '../settings.types';

describe('CanonicalCliType — cursor', () => {
  it('allows cursor literal', () => {
    const t: CanonicalCliType = 'cursor';
    expect(t).toBe('cursor');
  });
});
