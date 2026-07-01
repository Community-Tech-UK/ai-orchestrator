import { describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import { createVoiceDomain } from '../domains/voice.preload';

describe('voice preload domain', () => {
  it('invokes local STT chunks and subscribes to local STT events on contract channels', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ success: true }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const domain = createVoiceDomain(
      ipcRenderer,
      IPC_CHANNELS,
      (payload = {}) => ({ ...payload, ipcAuthToken: 'auth-token' }),
    );
    const eventCallback = vi.fn();

    await domain.pushVoiceLocalSttChunk({
      sessionId: 'local-session-1',
      seq: 1,
      wavBase64: 'UklGRg==',
      last: true,
    });
    const stop = domain.onVoiceLocalSttEvent(eventCallback);
    stop();

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.VOICE_LOCAL_STT_CHUNK,
      {
        sessionId: 'local-session-1',
        seq: 1,
        wavBase64: 'UklGRg==',
        last: true,
        ipcAuthToken: 'auth-token',
      },
    );
    expect(ipcRenderer.on).toHaveBeenCalledWith(
      IPC_CHANNELS.VOICE_LOCAL_STT_EVENT,
      expect.any(Function),
    );
    const listener = vi.mocked(ipcRenderer.on).mock.calls[0][1] as unknown as (
      event: unknown,
      payload: unknown,
    ) => void;
    listener({}, { sessionId: 'local-session-1', kind: 'final', text: 'hello' });
    expect(eventCallback).toHaveBeenCalledWith({
      sessionId: 'local-session-1',
      kind: 'final',
      text: 'hello',
    });
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.VOICE_LOCAL_STT_EVENT,
      listener,
    );
  });
});
