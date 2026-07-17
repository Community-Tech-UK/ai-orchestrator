import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { CopilotServerSession } from './copilot-server-session';
import type {
  CopilotSdkClientLike,
  CopilotSdkSessionLike,
  LoadedCopilotSdk,
} from './copilot-sdk-loader';
import type { MappedCopilotServerEffect } from './copilot-server-event-mapper';

function makeFakeSdk(overrides: {
  createSession?: CopilotSdkClientLike['createSession'];
  resumeSession?: CopilotSdkClientLike['resumeSession'];
  stop?: () => Promise<unknown>;
  session?: Partial<CopilotSdkSessionLike>;
} = {}): {
  sdk: LoadedCopilotSdk;
  clientOptions: Array<Record<string, unknown>>;
  session: CopilotSdkSessionLike & { emit: (e: Record<string, unknown>) => void };
  stopMock: ReturnType<typeof vi.fn>;
  unsubscribed: { value: boolean };
} {
  const unsubscribed = { value: false };
  let listener: ((event: { type: string } & Record<string, unknown>) => void) | null = null;
  const session = {
    sessionId: 'cop-sess-1',
    on: vi.fn((l: (event: { type: string } & Record<string, unknown>) => void) => {
      listener = l;
      return () => { unsubscribed.value = true; };
    }),
    send: vi.fn(async () => 'm-1'),
    abort: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    emit: (e: Record<string, unknown>) => listener?.(e as { type: string } & Record<string, unknown>),
    ...overrides.session,
  } as unknown as CopilotSdkSessionLike & { emit: (e: Record<string, unknown>) => void };

  const stopMock = vi.fn(overrides.stop ?? (async () => []));
  const clientOptions: Array<Record<string, unknown>> = [];
  class FakeClient implements CopilotSdkClientLike {
    constructor(options?: Record<string, unknown>) {
      clientOptions.push(options ?? {});
    }
    createSession = overrides.createSession ?? vi.fn(async () => session);
    resumeSession = overrides.resumeSession ?? vi.fn(async () => session);
    stop = stopMock;
  }
  const sdk: LoadedCopilotSdk = {
    CopilotClient: FakeClient as unknown as LoadedCopilotSdk['CopilotClient'],
    sdkPath: '/fake/copilot-sdk/index.js',
    packageVersion: '1.0.99',
    cliPath: '/fake/bin/copilot',
  };
  return { sdk, clientOptions, session, stopMock, unsubscribed };
}

const approveAll = async () => ({ kind: 'approved' });

describe('CopilotServerSession', () => {
  it('pins the runtime to the SDK-matched CLI binary and maps events to effects', async () => {
    const { sdk, clientOptions, session } = makeFakeSdk();
    const effects: MappedCopilotServerEffect[] = [];
    const server = await CopilotServerSession.start({
      sdk,
      workingDirectory: '/repo',
      model: 'gpt-5.5',
      onPermissionRequest: approveAll,
      onEffect: (e) => effects.push(e),
    });

    expect(clientOptions[0]['connection']).toEqual({ kind: 'stdio', path: '/fake/bin/copilot' });
    expect(server.copilotSessionId).toBe('cop-sess-1');

    session.emit({ type: 'assistant.message_delta', data: { deltaContent: 'Hi', messageId: 'm-1' } });
    session.emit({ type: 'session.usage_info', data: { currentTokens: 10, tokenLimit: 100, messagesLength: 1 } });
    expect(effects).toEqual([
      { kind: 'assistant-delta', messageId: 'm-1', delta: 'Hi' },
      { kind: 'context', used: 10, total: 100 },
    ]);
  });

  it('resumes an existing Copilot session id instead of creating a new one', async () => {
    const { sdk } = makeFakeSdk();
    const server = await CopilotServerSession.start({
      sdk,
      resumeSessionId: 'cop-sess-1',
      onPermissionRequest: approveAll,
      onEffect: () => undefined,
    });
    const client = (server as unknown as { client: CopilotSdkClientLike }).client;
    expect(client.resumeSession).toHaveBeenCalledWith('cop-sess-1', expect.objectContaining({ streaming: true }));
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it('stops the spawned runtime when session setup fails (no process leak)', async () => {
    const boom = vi.fn(async () => { throw new Error('runtime refused'); });
    const { sdk, stopMock } = makeFakeSdk({ createSession: boom });
    await expect(
      CopilotServerSession.start({ sdk, onPermissionRequest: approveAll, onEffect: () => undefined }),
    ).rejects.toThrow('runtime refused');
    expect(stopMock).toHaveBeenCalled();
  });

  it('send/abort delegate to the session; dispose unsubscribes then tears down fail-soft', async () => {
    const { sdk, session, stopMock, unsubscribed } = makeFakeSdk({
      session: {
        disconnect: vi.fn(async () => { throw new Error('already gone'); }),
      },
    });
    const server = await CopilotServerSession.start({
      sdk,
      onPermissionRequest: approveAll,
      onEffect: () => undefined,
    });

    await server.send('do the thing');
    expect(session.send).toHaveBeenCalledWith({ prompt: 'do the thing' });
    await server.abort();
    expect(session.abort).toHaveBeenCalled();

    await server.dispose(); // disconnect throws — must still stop the client
    expect(unsubscribed.value).toBe(true);
    expect(stopMock).toHaveBeenCalled();
  });

  it('a throwing effect handler never breaks the event subscription', async () => {
    const { sdk, session } = makeFakeSdk();
    const seen: string[] = [];
    await CopilotServerSession.start({
      sdk,
      onPermissionRequest: approveAll,
      onEffect: (e) => {
        seen.push(e.kind);
        if (seen.length === 1) throw new Error('consumer bug');
      },
    });
    session.emit({ type: 'assistant.turn_start' });
    session.emit({ type: 'assistant.turn_end' });
    expect(seen).toEqual(['turn-start', 'turn-end']);
  });
});
