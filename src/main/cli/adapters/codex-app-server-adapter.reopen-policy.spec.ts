import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  settings: { codexHelperAgentsChats: 'off' } as Record<string, unknown>,
}));

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => hoisted.settings }),
}));
vi.mock('../../core/system/session-policy-log', () => ({ recordSessionPolicy: vi.fn() }));

import { CodexCliAdapter } from './codex-cli-adapter';

interface ReopenHost {
  appServerClient: unknown;
  appServerThreadId: string | null;
  sessionId: string | null;
  reopenAppServerThread(): Promise<void>;
}

function adapterWithClient(
  config: ConstructorParameters<typeof CodexCliAdapter>[0],
  request: ReturnType<typeof vi.fn>,
): ReopenHost {
  const adapter = new CodexCliAdapter(config) as unknown as ReopenHost;
  adapter.appServerClient = { request };
  adapter.appServerThreadId = 'thread-old';
  return adapter;
}

describe('reopenAppServerThread sends the thread policy', () => {
  beforeEach(() => {
    hoisted.settings = { codexHelperAgentsChats: 'off' };
  });

  it('starts the replacement thread with the chat policy config', async () => {
    const request = vi.fn(async () => ({ threadId: 'thread-new' }));
    const adapter = adapterWithClient({ sessionKind: 'chat', workingDir: '/tmp/project' }, request);

    await adapter.reopenAppServerThread();

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('thread/start', expect.objectContaining({
      cwd: '/tmp/project',
      config: {
        'agents.enabled': false,
        tool_output_token_limit: 6000,
        model_post_turn_compact_threshold_percent: 70,
      },
    }));
    expect(adapter.appServerThreadId).toBe('thread-new');
    expect(adapter.sessionId).toBe('thread-new');
  });

  it('uses the adapter session kind, so a loop gets the Harness-work policy', async () => {
    hoisted.settings = { codexHelperAgentsHarnessWork: 'full' };
    const request = vi.fn(async () => ({ threadId: 'thread-loop-new' }));
    const adapter = adapterWithClient({ sessionKind: 'loop', workingDir: '/tmp/project' }, request);

    await adapter.reopenAppServerThread();

    expect(request).toHaveBeenCalledWith('thread/start', expect.objectContaining({
      config: {
        tool_output_token_limit: 4000,
        model_post_turn_compact_threshold_percent: 60,
      },
    }));
  });
});
