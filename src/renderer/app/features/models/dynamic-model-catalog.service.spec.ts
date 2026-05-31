import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DynamicModelCatalogService } from './dynamic-model-catalog.service';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';
import { getModelsForProvider, type ModelDisplayInfo } from '../../../../shared/types/provider.types';

function makeIpc(data: ModelDisplayInfo[] | null) {
  return {
    listModelsForProvider: vi.fn(async () =>
      data ? { success: true, data } : { success: false, error: { message: 'nope' } },
    ),
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('DynamicModelCatalogService', () => {
  function setup(ipc: { listModelsForProvider: ReturnType<typeof vi.fn> }) {
    TestBed.configureTestingModule({
      providers: [
        DynamicModelCatalogService,
        { provide: ProviderIpcService, useValue: ipc },
      ],
    });
    return TestBed.inject(DynamicModelCatalogService);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.resetTestingModule();
  });

  it('returns the static catalog before anything is loaded', () => {
    const svc = setup(makeIpc(null));
    expect(svc.modelsFor('cursor')).toEqual(getModelsForProvider('cursor'));
  });

  it('does not query the CLI for static providers', () => {
    const ipc = makeIpc([{ id: 'x', name: 'X', tier: 'balanced' }]);
    const svc = setup(ipc);
    svc.ensureLoaded('claude');
    svc.ensureLoaded('codex');
    svc.ensureLoaded('gemini');
    expect(ipc.listModelsForProvider).not.toHaveBeenCalled();
  });

  it('prefers the live list and overlays curated pinned/family/tier by id', async () => {
    const ipc = makeIpc([
      // Known id (present in static cursor catalog) — should inherit static metadata.
      { id: 'composer-2.5', name: 'Composer 2.5 (fresh)', tier: 'fast', family: 'X' },
      // Unknown id — passes through as-is.
      { id: 'brand-new-model', name: 'Brand New', tier: 'powerful' },
    ]);
    const svc = setup(ipc);

    svc.ensureLoaded('cursor');
    await flush();

    const models = svc.modelsFor('cursor');
    expect(ipc.listModelsForProvider).toHaveBeenCalledWith('cursor');
    expect(models.map((m) => m.id)).toEqual(['composer-2.5', 'brand-new-model']);

    const composer = models.find((m) => m.id === 'composer-2.5')!;
    expect(composer.name).toBe('Composer 2.5 (fresh)'); // live name wins
    expect(composer.pinned).toBe(true); // static metadata overlaid
    expect(composer.family).toBe('Composer');
    expect(composer.tier).toBe('balanced');

    const fresh = models.find((m) => m.id === 'brand-new-model')!;
    expect(fresh.tier).toBe('powerful'); // untouched
  });

  it('keeps the static fallback when discovery fails', async () => {
    const ipc = makeIpc(null);
    const svc = setup(ipc);
    svc.ensureLoaded('cursor');
    await flush();
    expect(svc.modelsFor('cursor')).toEqual(getModelsForProvider('cursor'));
  });

  it('throttles repeat fetches within the TTL and dedupes in-flight requests', async () => {
    const ipc = makeIpc([{ id: 'composer-2.5', name: 'C', tier: 'balanced' }]);
    const svc = setup(ipc);

    svc.ensureLoaded('cursor'); // starts a fetch
    svc.ensureLoaded('cursor'); // in-flight → deduped
    await flush();
    svc.ensureLoaded('cursor'); // within TTL → skipped

    expect(ipc.listModelsForProvider).toHaveBeenCalledTimes(1);
  });
});
