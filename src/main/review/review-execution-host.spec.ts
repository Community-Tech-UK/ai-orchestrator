import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProviderReviewExecutionHost, resolveReviewerModelOverride } from './review-execution-host';

// Mutable holder so each test can configure the per-reviewer model override.
const hostTestState = vi.hoisted(() => ({
  modelByProvider: {} as Record<string, string>,
  createAdapter: vi.fn(),
  quotaSnapshot: null as null | {
    ok: boolean;
    takenAt: number;
    windows: Array<{ id: string; label: string; used: number; limit: number }>;
  },
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      crossModelReviewModelByProvider: hostTestState.modelByProvider,
    }),
  }),
}));

// The resolver does not use these, but importing review-execution-host pulls
// them in at module load — stub them so the unit spec stays light and isolated.
vi.mock('../cli/adapters/adapter-factory', () => ({
  resolveCliType: vi.fn(async (provider: string) => provider),
}));
vi.mock('../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: () => ({ createAdapter: hostTestState.createAdapter }),
}));
vi.mock('../core/system/provider-quota-service', () => ({
  getProviderQuotaService: () => ({ getSnapshot: () => hostTestState.quotaSnapshot }),
}));

describe('resolveReviewerModelOverride', () => {
  beforeEach(() => {
    hostTestState.modelByProvider = {};
    hostTestState.createAdapter.mockReset();
    hostTestState.quotaSnapshot = null;
  });

  it('returns undefined when no entry is configured (CLI auto-routes)', () => {
    expect(resolveReviewerModelOverride('copilot')).toBeUndefined();
  });

  it('returns undefined for an empty / whitespace-only value', () => {
    hostTestState.modelByProvider = { copilot: '   ' };
    expect(resolveReviewerModelOverride('copilot')).toBeUndefined();
  });

  it("treats 'auto' as no override (case-insensitive)", () => {
    hostTestState.modelByProvider = { copilot: 'Auto' };
    expect(resolveReviewerModelOverride('copilot')).toBeUndefined();
  });

  it('returns the configured concrete model id, trimmed', () => {
    hostTestState.modelByProvider = { copilot: '  claude-sonnet-46  ' };
    expect(resolveReviewerModelOverride('copilot')).toBe('claude-sonnet-46');
  });

  it('does not fall back to a primary model for a provider without an entry', () => {
    hostTestState.modelByProvider = { copilot: 'gpt-5.5' };
    // gemini has no entry — must stay on its own CLI routing, not a primary.
    expect(resolveReviewerModelOverride('gemini')).toBeUndefined();
  });

  it('tolerates a missing override map entirely', () => {
    // Simulate an older persisted settings object with no map at all.
    hostTestState.modelByProvider = undefined as unknown as Record<string, string>;
    expect(resolveReviewerModelOverride('copilot')).toBeUndefined();
  });
});

describe('ProviderReviewExecutionHost', () => {
  beforeEach(() => {
    hostTestState.modelByProvider = {};
    hostTestState.createAdapter.mockReset();
    hostTestState.quotaSnapshot = null;
  });

  it('interrupts and force-terminates an in-flight reviewer when cancelled', async () => {
    const abort = new AbortController();
    let rejectSend!: (reason?: unknown) => void;
    const sendMessage = vi.fn(() => new Promise<never>((_resolve, reject) => {
      rejectSend = reject;
    }));
    const interrupt = vi.fn(() => ({ status: 'accepted' as const }));
    const terminate = vi.fn(async () => undefined);
    hostTestState.createAdapter.mockReturnValue({ sendMessage, interrupt, terminate });

    const pending = new ProviderReviewExecutionHost().dispatchReviewerPrompt(
      'codex',
      'review this',
      '/repo',
      abort.signal,
    );
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());

    abort.abort();
    await expect(Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 250)),
    ])).rejects.toThrow('Review cancelled');
    expect(interrupt).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledWith(false);

    rejectSend(new Error('late adapter rejection'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('still settles cancellation when a non-conforming terminate throws synchronously', async () => {
    const abort = new AbortController();
    const sendMessage = vi.fn(() => new Promise<never>(() => undefined));
    hostTestState.createAdapter.mockReturnValue({
      sendMessage,
      interrupt: vi.fn(),
      terminate: vi.fn(() => { throw new Error('terminate exploded'); }),
    });

    const pending = new ProviderReviewExecutionHost().dispatchReviewerPrompt(
      'codex', 'review this', '/repo', abort.signal,
    );
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(() => abort.abort()).not.toThrow();
    await expect(pending).rejects.toThrow('Review cancelled');
  });

  it('routes an exhausted Antigravity Gemini override to Sonnet', async () => {
    hostTestState.modelByProvider = { antigravity: 'Gemini 3.5 Flash (Medium)' };
    hostTestState.quotaSnapshot = {
      ok: true,
      takenAt: Date.now(),
      windows: [
        { id: 'antigravity.gemini-5h', label: 'Gemini · 5-hour', used: 100, limit: 100 },
        { id: 'antigravity.3p-5h', label: 'Claude/GPT · 5-hour', used: 0, limit: 100 },
      ],
    };
    let capturedModel: unknown;
    hostTestState.createAdapter.mockImplementation(({ options }) => {
      capturedModel = options.model;
      return {
        sendMessage: vi.fn().mockResolvedValue({ content: '{}' }),
        terminate: vi.fn().mockResolvedValue(undefined),
      };
    });

    await new ProviderReviewExecutionHost().dispatchReviewerPrompt(
      'antigravity',
      'review this',
      '/repo',
      new AbortController().signal,
    );

    expect(capturedModel).toBe('Claude Sonnet 4.6 (Thinking)');
  });
});
