import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  settings: { codexHelperAgentsChats: 'off' } as Record<string, unknown>,
}));

vi.mock('../../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => hoisted.settings }),
}));
vi.mock('../../../core/system/session-policy-log', () => ({ recordSessionPolicy: vi.fn() }));
vi.mock('./codex-private-rollout-reconcile', () => ({
  repairPrivateCodexRolloutPath: vi.fn(() => ({ status: 'skipped', reason: 'missing-database' })),
}));

import { initializeCodexAppServer } from './app-server-initializer';
import type { AppServerClient } from './app-server-client';
import type { CodexSessionScanner } from './session-scanner';

// Chats set to Off give a policy that is easy to tell from "no policy":
// helper agents disabled plus the chat output and compaction limits.
const CHAT_OFF_POLICY_CONFIG = {
  'agents.enabled': false,
  tool_output_token_limit: 6000,
  model_post_turn_compact_threshold_percent: 70,
};

type RequestMock = ReturnType<typeof vi.fn>;

function makeClient(handlers: {
  list?: unknown;
  resume?: (params: Record<string, unknown>) => unknown;
  start?: unknown;
}): { client: AppServerClient; request: RequestMock } {
  const request: RequestMock = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'thread/list') return handlers.list ?? { data: [] };
    if (method === 'thread/resume') {
      if (!handlers.resume) throw new Error('unexpected thread/resume');
      return handlers.resume(params);
    }
    if (method === 'thread/start') return handlers.start ?? { threadId: 'fresh-thread' };
    throw new Error(`unexpected ${method}`);
  });
  return { client: { request, close: vi.fn(async () => undefined) } as unknown as AppServerClient, request };
}

function callsTo(request: RequestMock, method: string): Record<string, unknown>[] {
  return request.mock.calls
    .filter(([name]) => name === method)
    .map(([, params]) => params as Record<string, unknown>);
}

function baseOptions(client: AppServerClient) {
  return {
    client,
    config: { sessionKind: 'chat' as const },
    cwd: '/workspace/example',
    sandbox: 'read-only' as const,
    isCurrent: () => true,
    onFailedAttempt: vi.fn(),
  };
}

describe('Codex app-server initializer sends the thread policy on every thread request', () => {
  beforeEach(() => {
    hoisted.settings = { codexHelperAgentsChats: 'off' };
  });

  it('resume of a specific persisted thread carries the policy config', async () => {
    const { client, request } = makeClient({ resume: () => ({ threadId: 'thread-persisted' }) });
    const result = await initializeCodexAppServer({
      ...baseOptions(client),
      sessionId: 'thread-persisted', sessionScanner: {} as CodexSessionScanner, shouldResume: true,
    });
    expect(result?.threadId).toBe('thread-persisted');
    const resumes = callsTo(request, 'thread/resume');
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({ threadId: 'thread-persisted', config: CHAT_OFF_POLICY_CONFIG });
    expect(callsTo(request, 'thread/start')).toHaveLength(0);
  });

  it('resume of the newest thread/list candidate carries the policy config', async () => {
    const { client, request } = makeClient({
      list: { data: [{ id: 'thread-listed' }] },
      resume: () => ({ threadId: 'thread-listed' }),
    });
    const result = await initializeCodexAppServer({
      ...baseOptions(client),
      sessionId: null, sessionScanner: {} as CodexSessionScanner, shouldResume: true,
    });
    expect(result?.threadId).toBe('thread-listed');
    expect(result?.resumeCursor?.scanSource).toBe('thread-list');
    const resumes = callsTo(request, 'thread/resume');
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({ threadId: 'thread-listed', config: CHAT_OFF_POLICY_CONFIG });
  });

  it('resume of a JSONL-scan match carries the policy config', async () => {
    const { client, request } = makeClient({
      list: { data: [] },
      resume: () => ({ threadId: 'thread-scanned' }),
    });
    const findSessionForWorkspace = vi.fn(async () => ({
      threadId: 'thread-scanned', sessionFilePath: '/sessions/thread-scanned.jsonl',
    }));
    const result = await initializeCodexAppServer({
      ...baseOptions(client),
      sessionId: null,
      sessionScanner: { findSessionForWorkspace } as unknown as CodexSessionScanner,
      shouldResume: true,
    });
    expect(result?.threadId).toBe('thread-scanned');
    expect(result?.resumeCursor?.scanSource).toBe('jsonl-scan');
    const resumes = callsTo(request, 'thread/resume');
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({ threadId: 'thread-scanned', config: CHAT_OFF_POLICY_CONFIG });
  });

  it('a fresh start, and the fresh fallback after a lost thread, carry the policy config', async () => {
    const fresh = makeClient({});
    await initializeCodexAppServer({
      ...baseOptions(fresh.client),
      sessionId: null, sessionScanner: {} as CodexSessionScanner, shouldResume: false,
    });
    expect(callsTo(fresh.request, 'thread/start')[0]).toMatchObject({ config: CHAT_OFF_POLICY_CONFIG });

    const lost = makeClient({
      resume: () => { throw new Error('Thread does not exist'); },
      start: { threadId: 'replacement-thread' },
    });
    const result = await initializeCodexAppServer({
      ...baseOptions(lost.client),
      sessionId: 'thread-gone', sessionScanner: {} as CodexSessionScanner, shouldResume: true,
    });
    expect(result?.threadId).toBe('replacement-thread');
    expect(result?.resumeAttempt.source).toBe('fresh-fallback');
    expect(callsTo(lost.request, 'thread/resume')[0]).toMatchObject({ config: CHAT_OFF_POLICY_CONFIG });
    expect(callsTo(lost.request, 'thread/start')[0]).toMatchObject({ config: CHAT_OFF_POLICY_CONFIG });
  });

  it('the policy follows the session kind and settings rather than a fixed value', async () => {
    hoisted.settings = { codexHelperAgentsHarnessWork: 'full' };
    const { client, request } = makeClient({ resume: () => ({ threadId: 'thread-loop' }) });
    await initializeCodexAppServer({
      ...baseOptions(client),
      config: { sessionKind: 'loop' },
      sessionId: 'thread-loop', sessionScanner: {} as CodexSessionScanner, shouldResume: true,
    });
    const [resume] = callsTo(request, 'thread/resume');
    expect(resume['config']).toEqual({
      tool_output_token_limit: 4000,
      model_post_turn_compact_threshold_percent: 60,
    });
  });
});
