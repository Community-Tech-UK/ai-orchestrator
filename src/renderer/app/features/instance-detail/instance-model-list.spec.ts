import { describe, expect, it } from 'vitest';
import { resolveInstanceHeaderModels } from './instance-model-list';
import type { ModelDisplayInfo } from '../../../../shared/types/provider.types';

const fallbackModels: ModelDisplayInfo[] = [
  { id: 'sonnet', name: 'Sonnet fallback', tier: 'balanced' },
  { id: 'opus', name: 'Opus fallback', tier: 'powerful' },
];

const unifiedModels: ModelDisplayInfo[] = [
  { id: 'sonnet', name: 'Sonnet catalog', tier: 'balanced', family: 'Sonnet' },
  { id: 'models-dev-only', name: 'Models Dev Only', tier: 'fast' },
];

describe('resolveInstanceHeaderModels', () => {
  it('prefers unified catalog rows when the catalog has provider models', () => {
    expect(resolveInstanceHeaderModels(unifiedModels, fallbackModels)).toEqual(unifiedModels);
  });

  it('keeps fallback rows before the unified catalog has loaded', () => {
    expect(resolveInstanceHeaderModels([], fallbackModels)).toEqual(fallbackModels);
  });
});
