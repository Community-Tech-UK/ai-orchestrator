import { describe, expect, it, vi } from 'vitest';

import { loadOlderUntilFindMatch } from './transcript-find-load';

describe('loadOlderUntilFindMatch', () => {
  it('loads older transcript chunks until a match exists', async () => {
    let loadedChunks = 0;
    const loadOlder = vi.fn(async () => {
      loadedChunks += 1;
    });

    const loads = await loadOlderUntilFindMatch({
      hasMatches: () => loadedChunks >= 2,
      hasOlderMessages: () => true,
      loadOlderMessages: loadOlder,
      afterLoad: vi.fn(),
    });

    expect(loads).toBe(2);
    expect(loadOlder).toHaveBeenCalledTimes(2);
  });

  it('stops when there are no older messages left', async () => {
    let loadedChunks = 0;

    const loads = await loadOlderUntilFindMatch({
      hasMatches: () => false,
      hasOlderMessages: () => loadedChunks < 1,
      loadOlderMessages: async () => {
        loadedChunks += 1;
      },
    });

    expect(loads).toBe(1);
    expect(loadedChunks).toBe(1);
  });

  it('caps loading to avoid an infinite loop if the source keeps reporting older messages', async () => {
    const loadOlder = vi.fn(async () => undefined);

    const loads = await loadOlderUntilFindMatch({
      hasMatches: () => false,
      hasOlderMessages: () => true,
      loadOlderMessages: loadOlder,
      maxLoads: 3,
    });

    expect(loads).toBe(3);
    expect(loadOlder).toHaveBeenCalledTimes(3);
  });
});
