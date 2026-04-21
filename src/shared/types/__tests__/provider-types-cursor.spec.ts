import { describe, it, expect } from 'vitest';
import type { ProviderType } from '../provider.types';
import { CURSOR_MODELS, DEFAULT_MODELS, PROVIDER_MODEL_LIST } from '../provider.types';

describe('ProviderType — cursor', () => {
  it('exports CURSOR_MODELS.AUTO sentinel', () => {
    expect(CURSOR_MODELS.AUTO).toBe('auto');
  });
  it('allows cursor as a ProviderType literal', () => {
    const p: ProviderType = 'cursor';
    expect(p).toBe('cursor');
  });
});

describe('Cursor model tables', () => {
  it('DEFAULT_MODELS has cursor entry = auto sentinel', () => {
    expect(DEFAULT_MODELS.cursor).toBe(CURSOR_MODELS.AUTO);
  });
  it('PROVIDER_MODEL_LIST.cursor contains the Auto fallback entry', () => {
    expect(Array.isArray(PROVIDER_MODEL_LIST.cursor)).toBe(true);
    expect(PROVIDER_MODEL_LIST.cursor).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: CURSOR_MODELS.AUTO }),
    ]));
  });
});
