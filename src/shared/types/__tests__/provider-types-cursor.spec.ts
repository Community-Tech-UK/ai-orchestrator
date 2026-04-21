import { describe, it, expect } from 'vitest';
import type { ProviderType } from '../provider.types';
import { CURSOR_MODELS } from '../provider.types';

describe('ProviderType — cursor', () => {
  it('exports CURSOR_MODELS.AUTO sentinel', () => {
    expect(CURSOR_MODELS.AUTO).toBe('auto');
  });
  it('allows cursor as a ProviderType literal', () => {
    const p: ProviderType = 'cursor';
    expect(p).toBe('cursor');
  });
});
