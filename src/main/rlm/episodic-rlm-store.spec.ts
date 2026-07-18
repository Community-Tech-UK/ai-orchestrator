import { describe, expect, it, vi } from 'vitest';
import type { RLMDatabase } from '../persistence/rlm-database';
import { EpisodicRLMStore } from './episodic-rlm-store';

function makeStore(getSections: ReturnType<typeof vi.fn>): EpisodicRLMStore {
  const store = Object.create(EpisodicRLMStore.prototype) as EpisodicRLMStore;
  Reflect.set(store, 'db', { getSections } as unknown as RLMDatabase);
  return store;
}

describe('EpisodicRLMStore bounded scans', () => {
  it('bounds persisted session queries even without a caller limit', () => {
    const getSections = vi.fn(() => []);
    const store = makeStore(getSections);

    expect(store.querySessions({})).toEqual([]);
    expect(getSections).toHaveBeenCalledWith('episodic-unified-store', {
      type: 'episode',
      limit: 10_000,
    });
  });

  it('bounds persisted pattern queries even without a caller limit', () => {
    const getSections = vi.fn(() => []);
    const store = makeStore(getSections);

    expect(store.queryPatterns({})).toEqual([]);
    expect(getSections).toHaveBeenCalledWith('episodic-unified-store', {
      type: 'pattern',
      limit: 10_000,
    });
  });
});
