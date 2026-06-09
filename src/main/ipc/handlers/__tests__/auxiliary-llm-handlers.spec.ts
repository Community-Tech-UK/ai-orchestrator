import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../validated-handler';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}));

const serviceMocks = vi.hoisted(() => ({
  discoverCandidates: vi.fn(),
  generate: vi.fn(),
  configure: vi.fn(),
}));

const settingsMocks = vi.hoisted(() => ({
  set: vi.fn(),
  getAll: vi.fn(() => ({
    auxiliaryLlmEnabled: true,
    auxiliaryLlmRoutingMode: 'local-first',
    auxiliaryLlmAllowRemoteWorkerModels: true,
    auxiliaryLlmEndpointsJson: '[]',
    auxiliaryLlmSlotsJson: '{}',
  })),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      electronMocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../../rlm/auxiliary-llm-service', () => ({
  getAuxiliaryLlmService: () => serviceMocks,
}));

vi.mock('../../../core/config/settings-manager', () => ({
  getSettingsManager: () => settingsMocks,
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@contracts/channels', () => ({
  IPC_CHANNELS: {
    AUXILIARY_LLM_LIST_CANDIDATES: 'auxiliary-llm:list-candidates',
    AUXILIARY_LLM_PROBE_ENDPOINT: 'auxiliary-llm:probe-endpoint',
    AUXILIARY_LLM_TEST_GENERATE: 'auxiliary-llm:test-generate',
    AUXILIARY_LLM_SAVE_SETTINGS: 'auxiliary-llm:save-settings',
    AUXILIARY_LLM_EXTRACT_WEB: 'auxiliary-llm:extract-web',
  },
}));

describe('auxiliary-llm-handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronMocks.handlers.clear();
    // Register handlers by importing the module
    vi.resetModules();
  });

  async function loadHandlers() {
    const { registerAuxiliaryLlmHandlers } = await import('../auxiliary-llm-handlers');
    registerAuxiliaryLlmHandlers();
  }

  async function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
    const handler = electronMocks.handlers.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return handler(null, payload);
  }

  describe('list-candidates', () => {
    it('returns discovered candidates on success', async () => {
      const candidates = [{ endpoint: { id: 'e1', label: 'Ollama' }, models: [], healthy: true }];
      serviceMocks.discoverCandidates.mockResolvedValue(candidates);
      await loadHandlers();

      const result = await invoke('auxiliary-llm:list-candidates');
      expect(result.success).toBe(true);
      expect(result.data).toEqual(candidates);
    });

    it('returns error envelope when service throws', async () => {
      serviceMocks.discoverCandidates.mockRejectedValue(new Error('network error'));
      await loadHandlers();

      const result = await invoke('auxiliary-llm:list-candidates');
      expect(result.success).toBe(false);
      expect((result.error as { code: string }).code).toBe('AUXILIARY_LLM_LIST_FAILED');
    });
  });

  describe('probe-endpoint', () => {
    it('rejects public internet Ollama endpoints', async () => {
      await loadHandlers();

      const result = await invoke('auxiliary-llm:probe-endpoint', {
        provider: 'ollama',
        baseUrl: 'http://8.8.8.8:11434',
      });
      expect(result.success).toBe(false);
      expect((result.error as { code: string }).code).toBe('ENDPOINT_NOT_ALLOWED');
    });

    it('rejects raw API key values in apiKeyEnv', async () => {
      await loadHandlers();

      const result = await invoke('auxiliary-llm:probe-endpoint', {
        provider: 'openai-compatible',
        baseUrl: 'http://localhost:8080',
        apiKeyEnv: 'sk-abcdefghij1234567890',
      });
      expect(result.success).toBe(false);
      expect((result.error as { code: string }).code).toBe('RAW_API_KEY_REJECTED');
    });

    it('accepts environment variable names as apiKeyEnv', async () => {
      // Mock the auxiliary-model-client probe
      vi.doMock('../../../rlm/auxiliary-model-client', () => ({
        probeOpenAiCompatibleEndpoint: vi.fn().mockResolvedValue(true),
        probeOllamaEndpoint: vi.fn().mockResolvedValue(true),
      }));
      await loadHandlers();

      const result = await invoke('auxiliary-llm:probe-endpoint', {
        provider: 'openai-compatible',
        baseUrl: 'http://localhost:8080',
        apiKeyEnv: 'MY_OPENAI_KEY',
      });
      // Will succeed if probe function resolves; the env-var name is valid format
      // (not a raw key) so it should not get a RAW_API_KEY_REJECTED error
      expect((result.error as { code: string } | undefined)?.code).not.toBe('RAW_API_KEY_REJECTED');
    });
  });

  describe('test-generate', () => {
    it('returns text and decision on success', async () => {
      serviceMocks.generate.mockResolvedValue({
        text: 'Hello!',
        decision: { slot: 'titleGeneration', source: 'local', reason: 'ok' },
      });
      await loadHandlers();

      const result = await invoke('auxiliary-llm:test-generate', {
        slot: 'titleGeneration',
        userPrompt: 'Say hi',
      });
      expect(result.success).toBe(true);
      expect((result.data as { text: string }).text).toBe('Hello!');
    });

    it('uses a slot-aware JSON default prompt for JSON slots when none is provided', async () => {
      serviceMocks.generate.mockResolvedValue({
        text: '{"score":0.1,"confidence":0.9,"reason":"low risk"}',
        decision: { slot: 'approvalScoring', source: 'local', reason: 'ok' },
      });
      await loadHandlers();

      await invoke('auxiliary-llm:test-generate', { slot: 'approvalScoring' });

      const [slot, systemPrompt] = serviceMocks.generate.mock.calls[0] as [string, string, string];
      expect(slot).toBe('approvalScoring');
      // JSON slots must instruct the model to emit JSON, not a generic greeting.
      expect(systemPrompt).toContain('JSON');
    });
  });

  describe('extract-web', () => {
    it('routes captured page text through the webExtract slot', async () => {
      serviceMocks.generate.mockResolvedValue({
        text: 'The Pro plan is $20/month with unlimited projects.',
        decision: { slot: 'webExtract', source: 'local', reason: 'ok' },
      });
      await loadHandlers();

      const result = await invoke('auxiliary-llm:extract-web', {
        text: '<nav>Home About</nav><h1>Pricing</h1><p>Pro is $20/mo.</p>',
      });

      expect(result.success).toBe(true);
      expect((result.data as { text: string }).text).toContain('Pro plan');
      const [slot] = serviceMocks.generate.mock.calls[0] as [string, string, string];
      expect(slot).toBe('webExtract');
    });

    it('rejects empty page text without calling the model', async () => {
      await loadHandlers();

      const result = await invoke('auxiliary-llm:extract-web', { text: '   ' });

      expect(result.success).toBe(false);
      expect((result.error as { code: string }).code).toBe('EXTRACT_WEB_EMPTY');
      expect(serviceMocks.generate).not.toHaveBeenCalled();
    });
  });

  describe('save-settings', () => {
    it('updates only the five allowed auxiliary settings keys', async () => {
      await loadHandlers();

      await invoke('auxiliary-llm:save-settings', {
        auxiliaryLlmEnabled: false,
        auxiliaryLlmRoutingMode: 'manual-only',
        unrelatedKey: 'should-be-ignored',
      });

      const calls = settingsMocks.set.mock.calls.map(([key]: [string]) => key);
      expect(calls).toContain('auxiliaryLlmEnabled');
      expect(calls).toContain('auxiliaryLlmRoutingMode');
      expect(calls).not.toContain('unrelatedKey');
    });

    it('reconfigures the service after saving', async () => {
      await loadHandlers();

      await invoke('auxiliary-llm:save-settings', { auxiliaryLlmEnabled: false });
      expect(serviceMocks.configure).toHaveBeenCalledOnce();
    });
  });
});
