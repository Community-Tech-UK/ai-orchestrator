import { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

type WithAuth = (
  payload?: Record<string, unknown>
) => Record<string, unknown> & { ipcAuthToken?: string };

export function createVoiceDomain(
  ipcRenderer: IpcRenderer,
  ch: typeof IPC_CHANNELS,
  withAuth: WithAuth = (payload = {}) => payload
) {
  return {
    getVoiceStatus: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.VOICE_STATUS_GET),

    setTemporaryOpenAiVoiceKey: (apiKey: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.VOICE_OPENAI_TEMP_KEY_SET, withAuth({ apiKey })),

    clearTemporaryOpenAiVoiceKey: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.VOICE_OPENAI_TEMP_KEY_CLEAR, withAuth({})),

    createVoiceTranscriptionSession: (
      payload: { model?: string; language?: string; providerId?: string } = {}
    ): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.VOICE_TRANSCRIPTION_SESSION_CREATE, withAuth(payload)),

    closeVoiceTranscriptionSession: (sessionId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.VOICE_TRANSCRIPTION_SESSION_CLOSE, withAuth({ sessionId })),

    pushVoiceLocalSttChunk: (payload: {
      sessionId: string;
      seq: number;
      wavBase64: string;
      last?: boolean;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.VOICE_LOCAL_STT_CHUNK, withAuth(payload)),

    onVoiceLocalSttEvent: (callback: (event: unknown) => void): (() => void) => {
      const listener = (_event: unknown, payload: unknown) => callback(payload);
      ipcRenderer.on(ch.VOICE_LOCAL_STT_EVENT, listener);
      return () => ipcRenderer.removeListener(ch.VOICE_LOCAL_STT_EVENT, listener);
    },

    synthesizeVoiceSpeech: (payload: {
      requestId: string;
      input: string;
      model?: string;
      voice?: string;
      format?: 'mp3' | 'wav' | 'opus';
      providerId?: string;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.VOICE_TTS_SYNTHESIZE, withAuth(payload)),

    cancelVoiceSpeech: (requestId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.VOICE_TTS_CANCEL, withAuth({ requestId })),
  };
}
