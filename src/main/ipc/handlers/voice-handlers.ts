/**
 * Voice IPC handlers.
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  VoiceAuthenticatedPayloadSchema,
  VoiceCloseTranscriptionSessionPayloadSchema,
  VoiceCreateTranscriptionSessionPayloadSchema,
  VoiceSetTemporaryOpenAiKeyPayloadSchema,
  VoiceTtsCancelPayloadSchema,
  VoiceTtsPayloadSchema,
} from '@contracts/schemas/voice';
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
