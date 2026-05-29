import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockEmbed,
  mockGetConfig,
  mockGetProviderStatus,
} = vi.hoisted(() => ({
  mockEmbed: vi.fn(),
  mockGetConfig: vi.fn(),
  mockGetProviderStatus: vi.fn(),
}));

vi.mock('../embedding-service', () => ({
  EmbeddingService: class {},
  getEmbeddingService: vi.fn(() => ({
    embed: mockEmbed,
  })),
}));

vi.mock('../llm-service', () => ({
  LLMService: class {},
  getLLMService: vi.fn(() => ({
    getConfig: mockGetConfig,
    getProviderStatus: mockGetProviderStatus,
  })),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

describe('HyDEService fallback behavior', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    const { HyDEService } = await import('../hyde-service');
    HyDEService._resetForTesting();
    mockEmbed.mockImplementation(async (text: string) => ({
      embedding: text === 'explain context lookup' ? [0.1, 0.2, 0.3] : [0.9, 0.8, 0.7],
      model: 'test-embedding',
      tokens: 3,
      cached: false,
      provider: 'test',
    }));
    mockGetConfig.mockReturnValue({ ollamaHost: 'http://ollama.test' });
    mockGetProviderStatus.mockReturnValue({
      anthropic: null,
      ollama: null,
      openai: null,
      local: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses a 3 second default generation timeout', async () => {
    const { getHyDEService } = await import('../hyde-service');

    expect(getHyDEService().getConfig().generationTimeout).toBe(3000);
  });

  it('embed() falls back to direct embedding when hypothetical generation throws', async () => {
    const { getHyDEService } = await import('../hyde-service');
    const service = getHyDEService({
      cacheEnabled: false,
      enabled: true,
      minQueryLength: 0,
    });
    const patched = service as unknown as {
      generateHypotheticalDocument: () => Promise<string>;
    };
    patched.generateHypotheticalDocument = vi.fn(() => {
      throw new Error('synthetic HyDE failure');
    });

    const result = await service.embed('explain context lookup', { forceHyDE: true });

    expect(result.hydeUsed).toBe(false);
    expect(result.hypotheticalDocuments).toEqual([]);
    expect(result.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(mockEmbed).toHaveBeenCalledWith('explain context lookup');
  });

  it('embed() falls back to direct embedding within the configured timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    const { getHyDEService } = await import('../hyde-service');
    const service = getHyDEService({
      cacheEnabled: false,
      enabled: true,
      generationTimeout: 25,
      minQueryLength: 0,
    });
    const startedAt = Date.now();

    const result = await service.embed('explain context lookup', { forceHyDE: true });

    expect(Date.now() - startedAt).toBeLessThan(75);
    expect(result.hydeUsed).toBe(false);
    expect(result.hypotheticalDocuments).toEqual([]);
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(mockEmbed).toHaveBeenCalledWith('explain context lookup');
  });

  it('embed() direct-embeds without calling Ollama when health has marked Ollama unavailable', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    mockGetProviderStatus.mockReturnValue({
      anthropic: null,
      ollama: false,
      openai: null,
      local: true,
    });
    const { getHyDEService } = await import('../hyde-service');
    const service = getHyDEService({
      cacheEnabled: false,
      enabled: true,
      generationTimeout: 25,
      minQueryLength: 0,
    });

    const result = await service.embed('explain context lookup', { forceHyDE: true });

    expect(result.hydeUsed).toBe(false);
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(mockEmbed).toHaveBeenCalledWith('explain context lookup');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
