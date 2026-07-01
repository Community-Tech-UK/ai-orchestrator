/**
 * Voice IPC handlers.
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import type { AppSettings } from '../../../shared/types/settings.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  VoiceAuthenticatedPayloadSchema,
  VoiceCloseTranscriptionSessionPayloadSchema,
  VoiceCreateTranscriptionSessionPayloadSchema,
  VoiceLocalSttChunkPayloadSchema,
  VoiceSetTemporaryOpenAiKeyPayloadSchema,
  VoiceTtsCancelPayloadSchema,
  VoiceTtsPayloadSchema,
} from '@contracts/schemas/voice';
import { getSettingsManager } from '../../core/config/settings-manager';
import { getVoiceService, VoiceServiceError } from '../../services/voice';

interface RegisterVoiceHandlersDeps {
  ensureAuthorized: (
    event: IpcMainInvokeEvent,
    channel: string,
    payload: unknown
  ) => IpcResponse | null;
}

export function registerVoiceHandlers(deps: RegisterVoiceHandlersDeps): void {
  const voice = getVoiceService();
  const settings = getSettingsManager();
  voice.configure(settings.getAll());
  void voice.refreshLocalSttHealth().catch(() => undefined);
  settings.on('setting-changed', (key: keyof AppSettings) => {
    if (VOICE_STT_SETTING_KEYS.has(key)) {
      voice.configure(settings.getAll());
      void voice.refreshLocalSttHealth().catch(() => undefined);
    }
  });

  ipcMain.handle(IPC_CHANNELS.VOICE_STATUS_GET, async (): Promise<IpcResponse> => {
    try {
      return { success: true, data: voice.getStatus() };
    } catch (error) {
      return voiceErrorResponse(error, 'VOICE_STATUS_FAILED');
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.VOICE_OPENAI_TEMP_KEY_SET,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const authError = deps.ensureAuthorized(
          event,
          IPC_CHANNELS.VOICE_OPENAI_TEMP_KEY_SET,
          payload
        );
        if (authError) return authError;
        const validated = validateIpcPayload(
          VoiceSetTemporaryOpenAiKeyPayloadSchema,
          payload,
          'VOICE_OPENAI_TEMP_KEY_SET'
        );
        voice.setTemporaryOpenAiApiKey(validated.apiKey);
        return { success: true, data: voice.getStatus() };
      } catch (error) {
        return voiceErrorResponse(error, 'VOICE_OPENAI_TEMP_KEY_SET_FAILED');
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.VOICE_OPENAI_TEMP_KEY_CLEAR,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const authError = deps.ensureAuthorized(
          event,
          IPC_CHANNELS.VOICE_OPENAI_TEMP_KEY_CLEAR,
          payload
        );
        if (authError) return authError;
        validateIpcPayload(
          VoiceAuthenticatedPayloadSchema,
          payload,
          'VOICE_OPENAI_TEMP_KEY_CLEAR'
        );
        voice.clearTemporaryOpenAiApiKey();
        return { success: true, data: voice.getStatus() };
      } catch (error) {
        return voiceErrorResponse(error, 'VOICE_OPENAI_TEMP_KEY_CLEAR_FAILED');
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.VOICE_TRANSCRIPTION_SESSION_CREATE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const authError = deps.ensureAuthorized(
          event,
          IPC_CHANNELS.VOICE_TRANSCRIPTION_SESSION_CREATE,
          payload
        );
        if (authError) return authError;
        const validated = validateIpcPayload(
          VoiceCreateTranscriptionSessionPayloadSchema,
          payload,
          'VOICE_TRANSCRIPTION_SESSION_CREATE'
        );
        const session = await voice.createTranscriptionSession({
          model: validated.model,
          language: validated.language,
          providerId: validated.providerId,
        });
        return { success: true, data: session };
      } catch (error) {
        return voiceErrorResponse(error, 'VOICE_TRANSCRIPTION_SESSION_CREATE_FAILED');
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.VOICE_TRANSCRIPTION_SESSION_CLOSE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const authError = deps.ensureAuthorized(
          event,
          IPC_CHANNELS.VOICE_TRANSCRIPTION_SESSION_CLOSE,
          payload
        );
        if (authError) return authError;
        const validated = validateIpcPayload(
          VoiceCloseTranscriptionSessionPayloadSchema,
          payload,
          'VOICE_TRANSCRIPTION_SESSION_CLOSE'
        );
        return {
          success: true,
          data: { closed: voice.closeTranscriptionSession(validated.sessionId) },
        };
      } catch (error) {
        return voiceErrorResponse(error, 'VOICE_TRANSCRIPTION_SESSION_CLOSE_FAILED');
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.VOICE_LOCAL_STT_CHUNK,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const authError = deps.ensureAuthorized(
          event,
          IPC_CHANNELS.VOICE_LOCAL_STT_CHUNK,
          payload
        );
        if (authError) return authError;
        const validated = validateIpcPayload(
          VoiceLocalSttChunkPayloadSchema,
          payload,
          'VOICE_LOCAL_STT_CHUNK'
        );
        const transcriptEvent = await voice.pushLocalSttChunk(validated);
        event.sender.send(IPC_CHANNELS.VOICE_LOCAL_STT_EVENT, transcriptEvent);
        return { success: true, data: { accepted: true } };
      } catch (error) {
        const sessionId = sessionIdFromPayload(payload);
        if (sessionId) {
          event.sender.send(IPC_CHANNELS.VOICE_LOCAL_STT_EVENT, {
            sessionId,
            kind: 'error',
            error: error instanceof Error ? error.message : 'Local STT failed.',
          });
          return { success: true, data: { accepted: false } };
        }
        return voiceErrorResponse(error, 'VOICE_LOCAL_STT_CHUNK_FAILED');
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.VOICE_TTS_SYNTHESIZE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const authError = deps.ensureAuthorized(
          event,
          IPC_CHANNELS.VOICE_TTS_SYNTHESIZE,
          payload
        );
        if (authError) return authError;
        const validated = validateIpcPayload(
          VoiceTtsPayloadSchema,
          payload,
          'VOICE_TTS_SYNTHESIZE'
        );
        const audio = await voice.synthesizeSpeech({
          requestId: validated.requestId,
          input: validated.input,
          model: validated.model,
          voice: validated.voice,
          format: validated.format,
          providerId: validated.providerId,
        });
        return { success: true, data: audio };
      } catch (error) {
        return voiceErrorResponse(error, 'VOICE_TTS_SYNTHESIZE_FAILED');
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.VOICE_TTS_CANCEL,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const authError = deps.ensureAuthorized(
          event,
          IPC_CHANNELS.VOICE_TTS_CANCEL,
          payload
        );
        if (authError) return authError;
        const validated = validateIpcPayload(
          VoiceTtsCancelPayloadSchema,
          payload,
          'VOICE_TTS_CANCEL'
        );
        return {
          success: true,
          data: { cancelled: voice.cancelSpeech(validated.requestId) },
        };
      } catch (error) {
        return voiceErrorResponse(error, 'VOICE_TTS_CANCEL_FAILED');
      }
    }
  );
}

const VOICE_STT_SETTING_KEYS = new Set<keyof AppSettings>([
  'voiceSttRoutingMode',
  'voiceLocalSttEnabled',
  'voiceLocalSttWorkerNodeId',
  'voiceLocalSttModel',
  'voiceLocalSttLanguage',
  'voiceThisDeviceSttEndpointUrl',
  'voiceThisDeviceSttApiKeyEnv',
  'voiceLocalSttMaxSegmentMs',
]);

function sessionIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const sessionId = (payload as Record<string, unknown>)['sessionId'];
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId : null;
}

function voiceErrorResponse(error: unknown, fallbackCode: string): IpcResponse {
  return {
    success: false,
    error: {
      code: error instanceof VoiceServiceError ? error.code : fallbackCode,
      message: error instanceof Error ? error.message : 'Voice request failed',
      timestamp: Date.now(),
    },
  };
}
