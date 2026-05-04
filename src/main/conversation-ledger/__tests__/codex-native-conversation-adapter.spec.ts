import { mkdirSync, writeFileSync } from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexNativeConversationAdapter } from '../codex/codex-native-conversation-adapter';
import type { CodexAppServerClientInstance } from '../../cli/adapters/codex/app-server-client';
import type { AppServerMethod, AppServerRequestParams, AppServerResponseResult } from '../../cli/adapters/codex/app-server-types';

describe('CodexNativeConversationAdapter', () => {
  const clients: FakeClient[] = [];
  let tempDir: string | null = null;

  afterEach(() => {
    for (const client of clients) client.closed = true;
    clients.length = 0;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('starts durable app-server threads with ephemeral false', async () => {
    const client = new FakeClient({
      'thread/start': { threadId: 'thread_1', thread: { id: 'thread_1', name: 'Started' } },
    });
    clients.push(client);
    const adapter = new CodexNativeConversationAdapter({
      appServerClientFactory: async () => client as unknown as CodexAppServerClientInstance,
    });

    const handle = await adapter.startThread({
      provider: 'codex',
      workspacePath: '/tmp/project',
      model: 'gpt-5.4',
    });

    expect(handle.nativeThreadId).toBe('thread_1');
    expect(client.requests[0]).toMatchObject({
      method: 'thread/start',
      params: { cwd: '/tmp/project', ephemeral: false, serviceName: 'ai-orchestrator' },
    });
  });

  it('discovers from app-server data and maps source kinds from data, not threads', async () => {
    const client = new FakeClient({
      'thread/list': {
        data: [{
          id: 'thread_1',
          name: 'Native',
          cwd: '/tmp/project',
          source: 'appServer',
          updatedAt: 10,
          createdAt: 5,
          turns: [],
        }],
        nextCursor: null,
        backwardsCursor: null,
      },
    });
    const adapter = new CodexNativeConversationAdapter({
      appServerClientFactory: async () => client as unknown as CodexAppServerClientInstance,
      sessionsDir: '/tmp/does-not-exist',
    });

    const threads = await adapter.discover({ workspacePath: '/tmp/project' });

    expect(threads).toMatchObject([{ nativeThreadId: 'thread_1', nativeSourceKind: 'appServer' }]);
    expect(client.requests[0]).toMatchObject({
      method: 'thread/list',
      params: { sourceKinds: ['cli', 'vscode', 'appServer'] },
    });
  });

  it('reads app-server turns and falls back to filesystem rollout when read is unsupported', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'codex-native-adapter-'));
    const rolloutPath = join(tempDir, 'rollout-fallback.jsonl');
    writeFileSync(rolloutPath, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'thread_fallback', cwd: '/tmp/project', source: 'cli' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } }),
    ].join('\n'));
    const client = new FakeClient({}, new Error('method not found'));
    const adapter = new CodexNativeConversationAdapter({
      appServerClientFactory: async () => client as unknown as CodexAppServerClientInstance,
    });

    const snapshot = await adapter.readThread({
      provider: 'codex',
      nativeThreadId: 'thread_fallback',
      sourcePath: rolloutPath,
    });

    expect(snapshot.thread.nativeThreadId).toBe('thread_fallback');
    expect(snapshot.messages).toMatchObject([{ role: 'user', content: 'hello' }]);
  });

  it('resumes and sends turns through app-server', async () => {
    const client = new FakeClient({
      'thread/resume': { threadId: 'thread_1', thread: { id: 'thread_1', name: 'Resumed' } },
      'turn/start': {
        turn: {
          id: 'turn_1',
          status: 'completed',
          items: [{ type: 'agentMessage', id: 'msg_1', text: 'answer', phase: 'final' }],
        },
      },
    });
    const adapter = new CodexNativeConversationAdapter({
      appServerClientFactory: async () => client as unknown as CodexAppServerClientInstance,
      clock: () => 100,
    });

    await adapter.resumeThread({ provider: 'codex', nativeThreadId: 'thread_1', workspacePath: '/tmp/project' });
    const result = await adapter.sendTurn(
      { provider: 'codex', nativeThreadId: 'thread_1', workspacePath: '/tmp/project' },
      { text: 'continue' }
    );

    expect(result.messages).toMatchObject([{ role: 'assistant', content: 'answer' }]);
    expect(client.requests.map(request => request.method)).toEqual(['thread/resume', 'turn/start']);
  });

  it('discovers fixture-backed filesystem sessions', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'codex-native-adapter-'));
    const nested = join(tempDir, '2026/05/02');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'rollout-thread.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'thread_file', cwd: '/tmp/project', source: 'vscode' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } }),
    ].join('\n'));
    const adapter = new CodexNativeConversationAdapter({
      appServerClientFactory: async () => { throw new Error('no app server'); },
      sessionsDir: tempDir,
    });

    const threads = await adapter.discover({ workspacePath: '/tmp/project' });

    expect(threads).toMatchObject([{ nativeThreadId: 'thread_file', nativeSourceKind: 'vscode' }]);
  });
});

class FakeClient {
  readonly requests: { method: AppServerMethod; params: unknown }[] = [];
  closed = false;

  constructor(
    private readonly responses: Partial<{ [M in AppServerMethod]: AppServerResponseResult<M> }>,
    private readonly fallbackError?: Error
  ) {}

  async request<M extends AppServerMethod>(
    method: M,
    params: AppServerRequestParams<M>,
  ): Promise<AppServerResponseResult<M>> {
    this.requests.push({ method, params });
    const response = this.responses[method];
    if (response === undefined) {
      throw this.fallbackError ?? new Error(`No fake response for ${method}`);
    }
    return response as AppServerResponseResult<M>;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  setNotificationHandler = vi.fn();
  notify = vi.fn();
  getExitError = vi.fn(() => null);
  readonly cwd = '/tmp/project';
  readonly transport = 'direct' as const;
  readonly exitPromise = Promise.resolve();
}
