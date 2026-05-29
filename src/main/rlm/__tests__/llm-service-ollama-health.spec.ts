import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

describe('LLMService Ollama health checks', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    const { LLMService } = await import('../llm-service');
    LLMService._resetForTesting();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('checkOllamaHealth() returns false and marks Ollama unavailable for a 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const { getLLMService } = await import('../llm-service');
    const service = getLLMService({ ollamaHost: 'http://ollama.test' });

    await expect(service.checkOllamaHealth()).resolves.toBe(false);
    expect(service.getProviderStatus().ollama).toBe(false);
  });

  it('checkOllamaHealth() returns false and marks Ollama unavailable for a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    const { getLLMService } = await import('../llm-service');
    const service = getLLMService({ ollamaHost: 'http://ollama.test' });

    await expect(service.checkOllamaHealth()).resolves.toBe(false);
    expect(service.getProviderStatus().ollama).toBe(false);
  });

  it('checkOllamaHealth() returns true and marks Ollama available for a 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const { getLLMService } = await import('../llm-service');
    const service = getLLMService({ ollamaHost: 'http://ollama.test' });

    await expect(service.checkOllamaHealth()).resolves.toBe(true);
    expect(service.getProviderStatus().ollama).toBe(true);
  });
});
