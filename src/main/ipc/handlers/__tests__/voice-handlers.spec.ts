import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/types/ipc.types';
import type { IpcResponse } from '../../../../shared/types/ipc.types';

type IpcHandler = (
  event: { sender?: { send: ReturnType<typeof vi.fn> } },
  payload?: unknown
) => Promise<IpcResponse>;

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}));

const voiceMocks = vi.hoisted(() => ({
  configure: vi.fn(),
  refreshLocalSttHealth: vi.fn(async () => undefined),
  getStatus: vi.fn(() => ({ available: true, providers: [] })),
  pushLocalSttChunk: vi.fn(async () => ({
    sessionId: 'local-session-1',
    kind: 'final' as const,
    text: 'hello worker',
    segmentId: 3,
  })),
}));

const settingsMocks = vi.hoisted(() => ({
  getAll: vi.fn(() => ({})),
  on: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      electronMocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../../services/voice', () => {
  class VoiceServiceError extends Error {
    constructor(
      public readonly code: string,
      message: string
    ) {
      super(message);
    }
  }
  return {
    getVoiceService: () => voiceMocks,
    VoiceServiceError,
  };
});

vi.mock('../../../core/config/settings-manager', () => ({
  getSettingsManager: () => settingsMocks,
}));

async function loadHandlers(): Promise<void> {
  const { registerVoiceHandlers } = await import('../voice-handlers');
  registerVoiceHandlers({ ensureAuthorized: vi.fn(() => null) });
}

async function invoke(
  channel: string,
  payload: unknown,
  event: { sender?: { send: ReturnType<typeof vi.fn> } } = { sender: { send: vi.fn() } }
): Promise<{ response: IpcResponse; event: { sender?: { send: ReturnType<typeof vi.fn> } } }> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return { response: await handler(event, payload), event };
}

describe('registerVoiceHandlers local STT chunks', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    electronMocks.handlers.clear();
    voiceMocks.pushLocalSttChunk.mockResolvedValue({
      sessionId: 'local-session-1',
      kind: 'final',
      text: 'hello worker',
      segmentId: 3,
    });
  });

  it('pushes validated local STT chunks through VoiceService and emits transcript events', async () => {
    await loadHandlers();

    const { response, event } = await invoke(IPC_CHANNELS.VOICE_LOCAL_STT_CHUNK, {
      sessionId: 'local-session-1',
      seq: 3,
      wavBase64: 'UklGRg==',
      last: false,
      ipcAuthToken: 'auth-token',
    });

    expect(voiceMocks.pushLocalSttChunk).toHaveBeenCalledWith({
      sessionId: 'local-session-1',
      seq: 3,
      wavBase64: 'UklGRg==',
      last: false,
      ipcAuthToken: 'auth-token',
    });
    expect(event.sender?.send).toHaveBeenCalledWith(
      IPC_CHANNELS.VOICE_LOCAL_STT_EVENT,
      {
        sessionId: 'local-session-1',
        kind: 'final',
        text: 'hello worker',
        segmentId: 3,
      },
    );
    expect(response).toEqual({ success: true, data: { accepted: true } });
  });

  it('emits local STT error events without making the renderer handle duplicate failures', async () => {
    voiceMocks.pushLocalSttChunk.mockRejectedValueOnce(new Error('worker offline'));
    await loadHandlers();

    const { response, event } = await invoke(IPC_CHANNELS.VOICE_LOCAL_STT_CHUNK, {
      sessionId: 'local-session-1',
      seq: 4,
      wavBase64: 'UklGRg==',
      last: false,
      ipcAuthToken: 'auth-token',
    });

    expect(event.sender?.send).toHaveBeenCalledWith(
      IPC_CHANNELS.VOICE_LOCAL_STT_EVENT,
      {
        sessionId: 'local-session-1',
        kind: 'error',
        error: 'worker offline',
      },
    );
    expect(response).toEqual({ success: true, data: { accepted: false } });
  });
});
