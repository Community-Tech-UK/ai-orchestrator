import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnifiedCatalogStore } from './unified-catalog.store';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';
import type { UnifiedModelEntry } from '../../../../shared/types/unified-model-catalog.types';

function entry(partial: Partial<UnifiedModelEntry> & Pick<UnifiedModelEntry, 'id' | 'provider'>): UnifiedModelEntry {
  return {
    tier: 'balanced',
    source: 'static',
    discoveredAt: 0,
    ...partial,
  };
}

const SAMPLE: UnifiedModelEntry[] = [
  entry({ id: 'opus', provider: 'claude', tier: 'powerful', family: 'Opus' }),
  entry({ id: 'haiku', provider: 'claude', tier: 'fast' }),
  entry({ id: 'gpt-x', provider: 'codex', tier: 'balanced' }),
];

function makeIpc(models: UnifiedModelEntry[]) {
  let pushCb: ((p: { totalEntries: number; sources: string[] }) => void) | null = null;
  return {
    getUnifiedModelCatalog: vi.fn(async () => ({
      success: true,
      data: {
        models,
        status: {
          modelsDevLastRefreshedAt: 111,
          cliDiscoveryLastRefreshedAt: {},
          catalogLastBuiltAt: 222,
        },
      },
    })),
    onModelsCatalogUpdated: vi.fn((cb: (p: { totalEntries: number; sources: string[] }) => void) => {
      pushCb = cb;
      return () => { pushCb = null; };
    }),
    firePush: () => pushCb?.({ totalEntries: 3, sources: ['models-dev'] }),
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('UnifiedCatalogStore', () => {
  let ipc: ReturnType<typeof makeIpc>;

  function setup(): UnifiedCatalogStore {
    TestBed.configureTestingModule({
      providers: [
        UnifiedCatalogStore,
        { provide: ProviderIpcService, useValue: ipc },
      ],
    });
    return TestBed.inject(UnifiedCatalogStore);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.resetTestingModule();
    ipc = makeIpc(SAMPLE);
  });

  it('is empty before loading', () => {
    const store = setup();
    expect(store.models()).toEqual([]);
    expect(store.lastBuiltAt()).toBeNull();
  });

  it('ensureLoaded fetches and populates models + status', async () => {
    const store = setup();
    store.ensureLoaded();
    await flush();
    expect(store.models()).toHaveLength(3);
    expect(store.lastBuiltAt()).toBe(222);
    expect(ipc.getUnifiedModelCatalog).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent loads', async () => {
    const store = setup();
    store.ensureLoaded();
    store.ensureLoaded();
    await flush();
    store.ensureLoaded(); // already loaded
    expect(ipc.getUnifiedModelCatalog).toHaveBeenCalledTimes(1);
  });

  it('filters models by normalised provider', async () => {
    const store = setup();
    await store.refresh();
    expect(store.modelsForProvider('claude').map((m) => m.id)).toEqual(['opus', 'haiku']);
    expect(store.modelsForProvider('  CLAUDE ').map((m) => m.id)).toEqual(['opus', 'haiku']);
    expect(store.modelsForProvider('codex').map((m) => m.id)).toEqual(['gpt-x']);
  });

  it('maps to picker display rows (name falls back to id, family preserved)', async () => {
    const store = setup();
    await store.refresh();
    expect(store.displayModelsForProvider('claude')).toEqual([
      { id: 'opus', name: 'opus', tier: 'powerful', family: 'Opus' },
      { id: 'haiku', name: 'haiku', tier: 'fast' },
    ]);
  });

  it('live-refreshes when the main process pushes catalog-updated', async () => {
    const store = setup();
    await store.refresh();
    expect(ipc.getUnifiedModelCatalog).toHaveBeenCalledTimes(1);

    ipc.firePush();
    await flush();
    expect(ipc.getUnifiedModelCatalog).toHaveBeenCalledTimes(2);
  });
});
