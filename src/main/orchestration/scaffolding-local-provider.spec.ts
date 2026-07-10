import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getAll: vi.fn(),
}));

vi.mock('../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: vi.fn(() => ({ getAll: hoisted.getAll })),
}));

// resolveScaffoldingProvider (also in this module) needs the CLI resolver;
// keep the spec's module graph light — the adapter factory pulls in every
// adapter otherwise.
vi.mock('../cli/adapters/adapter-factory', () => ({
  resolveCliType: vi.fn(async () => 'claude'),
}));

import { resolveOllamaScaffoldingTarget } from './scaffolding-local-provider';

interface TagModel {
  name: string;
  size?: number;
}

/** Stub fetch with per-host tag responses; hosts not listed refuse connection. */
function mockTagsByHost(byHost: Record<string, TagModel[]>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const host = Object.keys(byHost).find((candidate) => String(url).includes(candidate));
    if (!host) throw new Error('ECONNREFUSED');
    return {
      ok: true,
      json: async () => ({ models: byHost[host] }),
    };
  }));
}

describe('resolveOllamaScaffoldingTarget', () => {
  beforeEach(() => {
    hoisted.getAll.mockReturnValue({
      auxiliaryLlmUseLocalhostOllama: true,
      auxiliaryLlmAllowRemoteWorkerModels: true,
      auxiliaryLlmQualityModel: '',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns undefined when nothing is reachable', async () => {
    mockTagsByHost({});
    expect(await resolveOllamaScaffoldingTarget()).toBeUndefined();
  });

  it('returns undefined when reachable servers have no models', async () => {
    mockTagsByHost({ '127.0.0.1': [] });
    expect(await resolveOllamaScaffoldingTarget()).toBeUndefined();
  });

  it('skips all probing when both candidate classes are disabled', async () => {
    hoisted.getAll.mockReturnValue({
      auxiliaryLlmUseLocalhostOllama: false,
      auxiliaryLlmAllowRemoteWorkerModels: false,
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await resolveOllamaScaffoldingTarget()).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not attempt remote-worker discovery when only that class is enabled', async () => {
    hoisted.getAll.mockReturnValue({
      auxiliaryLlmUseLocalhostOllama: false,
      auxiliaryLlmAllowRemoteWorkerModels: true,
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await resolveOllamaScaffoldingTarget()).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses localhost and prefers the configured aux quality model (tag-prefix match)', async () => {
    hoisted.getAll.mockReturnValue({
      auxiliaryLlmUseLocalhostOllama: true,
      auxiliaryLlmAllowRemoteWorkerModels: true,
      auxiliaryLlmQualityModel: 'qwen3',
    });
    mockTagsByHost({
      '127.0.0.1': [
        { name: 'llama3.2:3b', size: 2_000_000_000 },
        { name: 'qwen3:32b', size: 20_000_000_000 },
      ],
    });
    expect(await resolveOllamaScaffoldingTarget()).toEqual({
      model: 'qwen3:32b',
      host: '127.0.0.1',
      port: 11434,
      origin: 'this-device',
    });
  });

  it('falls back to the largest installed localhost model', async () => {
    mockTagsByHost({
      '127.0.0.1': [
        { name: 'llama3.2:3b', size: 2_000_000_000 },
        { name: 'gpt-oss:120b', size: 65_000_000_000 },
      ],
    });
    expect(await resolveOllamaScaffoldingTarget()).toEqual({
      model: 'gpt-oss:120b',
      host: '127.0.0.1',
      port: 11434,
      origin: 'this-device',
    });
  });

  it('prefers the configured quality model over a larger localhost model', async () => {
    hoisted.getAll.mockReturnValue({
      auxiliaryLlmUseLocalhostOllama: true,
      auxiliaryLlmAllowRemoteWorkerModels: true,
      auxiliaryLlmQualityModel: 'qwen3-coder:30b',
    });
    mockTagsByHost({
      '127.0.0.1': [
        { name: 'llama3.3:latest', size: 42_000_000_000 },
        { name: 'qwen3-coder:30b', size: 18_000_000_000 },
      ],
    });
    expect((await resolveOllamaScaffoldingTarget())?.model).toBe('qwen3-coder:30b');
  });

  it('ignores malformed tag entries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ models: [{ size: 5 }, { name: 'good:1b', size: 1 }, null] }),
    })));
    expect((await resolveOllamaScaffoldingTarget())?.model).toBe('good:1b');
  });

  it('returns undefined on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await resolveOllamaScaffoldingTarget()).toBeUndefined();
  });
});
