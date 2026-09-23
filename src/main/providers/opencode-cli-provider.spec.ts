import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const probeVersionStatus = vi.hoisted(() => vi.fn());

vi.mock('../cli/adapters/cli-status-probe', () => ({ probeVersionStatus }));

class FakeOpenCodeAdapter extends EventEmitter {
  async spawn(): Promise<void> { /* no-op */ }
  getSessionId(): string { return 'ses_placeholder'; }
  getPid(): number | null { return null; }
  async terminate(): Promise<void> { /* no-op */ }
  async sendInput(): Promise<void> { /* no-op */ }
}

const createOpenCodeAdapter = vi.hoisted(() => vi.fn());

vi.mock('../cli/adapters/adapter-factory', () => ({ createOpenCodeAdapter }));

import { OpenCodeCliProvider, DEFAULT_OPENCODE_CONFIG } from './opencode-cli-provider';

const EMPTY_LIST = '┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n';

describe('OpenCodeCliProvider', () => {
  beforeEach(() => {
    probeVersionStatus.mockReset();
    createOpenCodeAdapter.mockReset();
    createOpenCodeAdapter.mockImplementation(() => new FakeOpenCodeAdapter());
  });

  it('has no AIO default model', () => {
    expect(DEFAULT_OPENCODE_CONFIG.defaultModel).toBeUndefined();
  });

  it('reports unavailable when `opencode --version` fails, without running auth commands', async () => {
    probeVersionStatus.mockResolvedValue({ available: false, error: 'not found' });
    const run = vi.fn();
    const provider = new OpenCodeCliProvider({ ...DEFAULT_OPENCODE_CONFIG }, run);
    await expect(provider.checkStatus()).resolves.toMatchObject({ available: false, authenticated: false });
    expect(run).not.toHaveBeenCalled();
  });

  it('is signed in on the free default with no credentials', async () => {
    probeVersionStatus.mockResolvedValue({ available: true });
    const run = vi.fn(async (args: string[]) => (args[0] === 'auth' ? EMPTY_LIST : '{}'));
    const provider = new OpenCodeCliProvider({ ...DEFAULT_OPENCODE_CONFIG }, run);
    await expect(provider.checkStatus()).resolves.toMatchObject({ type: 'opencode', available: true, authenticated: true });
  });

  it('is not signed in when the chosen model needs a key and none is stored', async () => {
    probeVersionStatus.mockResolvedValue({ available: true });
    const run = vi.fn(async () => EMPTY_LIST);
    const provider = new OpenCodeCliProvider(
      { ...DEFAULT_OPENCODE_CONFIG, defaultModel: 'xiaomi-token-plan-ams/mimo-v2.6-pro' },
      run,
    );
    const status = await provider.checkStatus();
    expect(status).toMatchObject({ available: true, authenticated: false });
    expect(status.error).toContain('opencode auth login');
  });

  it('treats a failing auth command as not signed in', async () => {
    probeVersionStatus.mockResolvedValue({ available: true });
    const provider = new OpenCodeCliProvider({ ...DEFAULT_OPENCODE_CONFIG }, async () => {
      throw new Error('spawn opencode ENOENT');
    });
    await expect(provider.checkStatus()).resolves.toMatchObject({ available: true, authenticated: false });
  });

  it('accumulates measured tokens and the reported cost per turn', async () => {
    const provider = new OpenCodeCliProvider({ ...DEFAULT_OPENCODE_CONFIG, enabled: true });
    await provider.initialize({ workingDirectory: '/tmp', instanceId: 'i-1' });
    const adapter = createOpenCodeAdapter.mock.results[0]?.value as FakeOpenCodeAdapter;

    adapter.emit('complete', { id: 'r1', role: 'assistant', content: 'a', usage: { inputTokens: 100, outputTokens: 4, cacheReadTokens: 7808, reasoningTokens: 11, totalTokens: 7923, cost: 0.02 } });
    adapter.emit('complete', { id: 'r2', role: 'assistant', content: 'b', usage: { inputTokens: 50, outputTokens: 6, totalTokens: 56 } });

    expect(provider.getUsage()).toEqual({
      inputTokens: 150,
      outputTokens: 10,
      cacheReadTokens: 7808,
      reasoningTokens: 11,
      totalTokens: 7979,
      estimatedCost: 0.02,
    });
  });

  it('passes the requested model through, or none for OpenCode default', async () => {
    const provider = new OpenCodeCliProvider({ ...DEFAULT_OPENCODE_CONFIG });
    await provider.initialize({ workingDirectory: '/tmp', instanceId: 'i-1' });
    expect(createOpenCodeAdapter.mock.calls[0]?.[0]).toMatchObject({ model: undefined, workingDirectory: '/tmp' });
  });
});
