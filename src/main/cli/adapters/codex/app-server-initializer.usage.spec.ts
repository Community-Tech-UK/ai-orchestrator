import { describe, expect, it, vi } from 'vitest';
import { initializeCodexAppServer } from './app-server-initializer';
import type { AppServerClient } from './app-server-client';
import type { CodexSessionScanner } from './session-scanner';

describe('Codex initialized service tier evidence', () => {
  it.each(['default', 'priority', undefined])('retains only the thread/start response tier %s', async serviceTier => {
    const request = vi.fn(async () => ({ threadId: 'tier-thread', serviceTier }));
    const result = await initializeCodexAppServer({
      client: { request } as unknown as AppServerClient,
      config: { fastMode: false }, cwd: '/workspace/example', sandbox: 'read-only',
      sessionId: null, sessionScanner: {} as CodexSessionScanner, shouldResume: false,
      isCurrent: () => true, onFailedAttempt: vi.fn(),
    });
    expect(request).toHaveBeenCalledWith('thread/start', expect.objectContaining({ serviceTier: null }));
    expect(result?.effectiveServiceTier).toBe(serviceTier ?? null);
  });
});
