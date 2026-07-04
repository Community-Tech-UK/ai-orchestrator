import { describe, expect, it } from 'vitest';
import type { ModelDisplayInfo } from '../../../../shared/types/provider.types';
import { resolveReviewerModels } from './reviewer-model-options';

const fallbackModels: ModelDisplayInfo[] = [
  { id: 'gemini-static', name: 'Gemini Static', tier: 'powerful' },
];

const catalogModels: ModelDisplayInfo[] = [
  { id: 'gemini-future-pro', name: 'Gemini Future Pro', tier: 'powerful' },
];

describe('resolveReviewerModels', () => {
  it('prefers unified catalog rows when present', () => {
    expect(resolveReviewerModels(catalogModels, fallbackModels)).toEqual(catalogModels);
  });

  it('uses static fallback rows before the unified catalog has provider entries', () => {
    expect(resolveReviewerModels([], fallbackModels)).toEqual(fallbackModels);
  });
});
