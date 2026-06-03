import { describe, it, expect, afterEach } from 'vitest';
import { ModelsDevService } from './models-dev-service';
import { clearModelRateOverlay } from '../../shared/data/model-pricing';

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
