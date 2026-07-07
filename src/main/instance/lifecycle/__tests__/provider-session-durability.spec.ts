import { describe, expect, it } from 'vitest';
import type { Instance } from '../../../../shared/types/instance.types';
import { applyProviderSessionDurability, shouldPersistProviderSession } from '../provider-session-durability';

const rootInstance = {
  depth: 0,
  parentId: null,
} as Pick<Instance, 'depth' | 'parentId'>;

const childInstance = {
  depth: 1,
  parentId: 'parent-1',
} as Pick<Instance, 'depth' | 'parentId'>;

describe('provider session durability', () => {
  it('persists root Codex provider sessions', () => {
    expect(shouldPersistProviderSession('codex', rootInstance)).toBe(true);
    expect(applyProviderSessionDurability('codex', rootInstance, {})).toEqual({
      ephemeral: false,
    });
  });

  it('keeps child Codex sessions on the adapter default', () => {
    expect(shouldPersistProviderSession('codex', childInstance)).toBe(false);
    expect(applyProviderSessionDurability('codex', childInstance, {})).toEqual({});
  });

  it('leaves non-Codex providers unchanged', () => {
    expect(shouldPersistProviderSession('claude', rootInstance)).toBe(false);
    expect(applyProviderSessionDurability('claude', rootInstance, {})).toEqual({});
  });

  it('does not override an explicit caller choice', () => {
    expect(applyProviderSessionDurability('codex', rootInstance, { ephemeral: true })).toEqual({
      ephemeral: true,
    });
  });
});
