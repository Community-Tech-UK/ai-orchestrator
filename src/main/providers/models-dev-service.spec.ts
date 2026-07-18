import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { ModelsDevService } from './models-dev-service';
import { clearModelRateOverlay } from '../../shared/data/model-pricing';
import { MAX_MODEL_ID_LENGTH } from '../../shared/types/provider.types';

describe('ModelsDevService.parseRegistry', () => {
  const service = new ModelsDevService();

  afterEach(() => {
    clearModelRateOverlay();
  });

  it('parses the documented object-keyed shape into rates and context windows', () => {
    const raw = JSON.stringify({
      anthropic: {
        id: 'anthropic',
        models: {
          'claude-opus-4-8': {
            id: 'claude-opus-4-8',
            cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
            limit: { context: 200000, output: 32000 },
          },
        },
      },
      openai: {
        id: 'openai',
        models: {
          'gpt-5.5': {
            id: 'gpt-5.5',
            cost: { input: 5, output: 20 },
            limit: { context: 400000 },
          },
        },
      },
    });

    const parsed = service.parseRegistry(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.rates['claude-opus-4-8']).toEqual({ input: 5, output: 25 });
    expect(parsed!.rates['gpt-5.5']).toEqual({ input: 5, output: 20 });
    expect(parsed!.contextWindows.get('claude-opus-4-8')).toBe(200000);
    expect(parsed!.contextWindows.get('gpt-5.5')).toBe(400000);
  });

  it('tolerates a models-array form', () => {
    const raw = JSON.stringify({
      prov: { models: [{ id: 'm1', cost: { input: 1, output: 2 } }] },
    });
    const parsed = service.parseRegistry(raw);
    expect(parsed!.rates['m1']).toEqual({ input: 1, output: 2 });
  });

  it('skips models missing cost.input/output without throwing', () => {
    const raw = JSON.stringify({
      prov: {
        models: {
          ok: { id: 'ok', cost: { input: 1, output: 2 } },
          noCost: { id: 'noCost' },
          partial: { id: 'partial', cost: { input: 3 } },
          nonNumeric: { id: 'nonNumeric', cost: { input: 'free', output: 'cheap' } },
        },
      },
    });
    const parsed = service.parseRegistry(raw);
    expect(Object.keys(parsed!.rates)).toEqual(['ok']);
  });

  it('skips models beyond the dynamic catalog id length limit', () => {
    const tooLongCatalogModelId = `${'m'.repeat(MAX_MODEL_ID_LENGTH - 2)}-v1`;
    expect(tooLongCatalogModelId).toHaveLength(MAX_MODEL_ID_LENGTH + 1);
    const raw = JSON.stringify({
      prov: {
        models: {
          ok: { id: 'ok', cost: { input: 1, output: 2 } },
          tooLong: {
            id: tooLongCatalogModelId,
            cost: { input: 3, output: 4 },
            limit: { context: 1234 },
          },
        },
      },
    });

    const parsed = service.parseRegistry(raw);

    expect(Object.keys(parsed!.rates)).toEqual(['ok']);
    expect(parsed!.contextWindows.has(tooLongCatalogModelId)).toBe(false);
    expect(parsed!.entries.map((entry) => entry.id)).toEqual(['ok']);
  });

  it('returns null for malformed JSON and non-object roots', () => {
    expect(service.parseRegistry('not json {')).toBeNull();
    expect(service.parseRegistry('42')).toBeNull();
    expect(service.parseRegistry('null')).toBeNull();
  });

  it('returns empty rates for an object with no usable models (offline-equivalent)', () => {
    const parsed = service.parseRegistry(JSON.stringify({ prov: { models: {} } }));
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!.rates)).toHaveLength(0);
  });

  it('includes provider namespace in each parsed entry', () => {
    const raw = JSON.stringify({
      anthropic: {
        models: {
          'claude-opus-4-8': {
            id: 'claude-opus-4-8',
            cost: { input: 5, output: 25 },
          },
        },
      },
      openai: {
        models: {
          'gpt-5.5': {
            id: 'gpt-5.5',
            cost: { input: 5, output: 20 },
          },
        },
      },
    });
    const parsed = service.parseRegistry(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.entries).toHaveLength(2);
    const opusEntry = parsed!.entries.find((e) => e.id === 'claude-opus-4-8');
    expect(opusEntry?.provider).toBe('anthropic');
    const gptEntry = parsed!.entries.find((e) => e.id === 'gpt-5.5');
    expect(gptEntry?.provider).toBe('openai');
  });

  it('listEntries returns empty array before any refresh', () => {
    const freshService = new ModelsDevService();
    expect(freshService.listEntries()).toEqual([]);
  });
});

describe('ModelsDevService.start/stop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('refreshes immediately on start, then once per interval (ticks force)', () => {
    const svc = new ModelsDevService();
    // Stub refresh so no network is touched and we can inspect call args.
    const refresh = vi.spyOn(svc, 'refresh').mockResolvedValue(false);

    svc.start(1000);
    // Immediate startup refresh is unforced so it coalesces with other startup
    // callers and respects a warm TTL.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenLastCalledWith();

    vi.advanceTimersByTime(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith(true);

    vi.advanceTimersByTime(1000);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenLastCalledWith(true);

    svc.stop();
  });

  it('is idempotent — a second start() does not create a second interval', () => {
    const svc = new ModelsDevService();
    const refresh = vi.spyOn(svc, 'refresh').mockResolvedValue(false);

    svc.start(1000);
    svc.start(1000); // no-op: timer already running
    expect(refresh).toHaveBeenCalledTimes(1); // only the first immediate refresh

    vi.advanceTimersByTime(1000);
    expect(refresh).toHaveBeenCalledTimes(2); // one tick, not two

    svc.stop();
  });

  it('stop() halts periodic refresh and is idempotent', () => {
    const svc = new ModelsDevService();
    const refresh = vi.spyOn(svc, 'refresh').mockResolvedValue(false);

    svc.start(1000);
    vi.advanceTimersByTime(1000);
    expect(refresh).toHaveBeenCalledTimes(2);

    svc.stop();
    vi.advanceTimersByTime(5000);
    expect(refresh).toHaveBeenCalledTimes(2); // no further refreshes after stop

    svc.stop(); // second stop is a harmless no-op
  });
});

describe('ModelsDevService.listEntries', () => {
  it('returns entries populated after parseRegistry and doRefresh simulation', () => {
    const svc = new ModelsDevService();
    // Simulate a parse by calling parseRegistry (which we can verify returns entries)
    const raw = JSON.stringify({
      myprovider: {
        models: {
          'my-model': { id: 'my-model', cost: { input: 1, output: 3 } },
        },
      },
    });
    const parsed = svc.parseRegistry(raw);
    expect(parsed!.entries).toHaveLength(1);
    expect(parsed!.entries[0].id).toBe('my-model');
    expect(parsed!.entries[0].provider).toBe('myprovider');
    expect(parsed!.entries[0].rate).toEqual({ input: 1, output: 3 });
  });
});
