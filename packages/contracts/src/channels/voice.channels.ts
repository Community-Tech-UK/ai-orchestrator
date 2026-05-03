/**
 * IPC channels for voice conversation: status, temporary credentials,
 * Realtime transcription sessions, and TTS.
 */
export const VOICE_CHANNELS = {
  VOICE_STATUS_GET: 'voice:status:get',
  VOICE_OPENAI_TEMP_KEY_SET: 'voice:openai-temp-key:set',
  VOICE_OPENAI_TEMP_KEY_CLEAR: 'voice:openai-temp-key:clear',
  VOICE_TRANSCRIPTION_SESSION_CREATE: 'voice:transcription-session:create',
  VOICE_TRANSCRIPTION_SESSION_CLOSE: 'voice:transcription-session:close',
  VOICE_TTS_SYNTHESIZE: 'voice:tts:synthesize',
  VOICE_TTS_CANCEL: 'voice:tts:cancel',
} as const;
