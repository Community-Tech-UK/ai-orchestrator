export type VoiceConversationPhase =
  | 'off'
  | 'connecting'
  | 'listening'
  | 'transcribing'
  | 'sending'
  | 'waiting-for-session'
  | 'speaking'
  | 'stopping'
  | 'error';

export type VoiceErrorCode =
  | 'missing-api-key'
  | 'temporary-api-key-rejected'
  | 'microphone-denied'
  | 'microphone-unavailable'
  | 'provider-session-failed'
  | 'voice-provider-unavailable'
  | 'transcription-failed'
  | 'voice-connection-lost'
  | 'voice-credential-expired'
  | 'speech-synthesis-failed'
  | 'speech-synthesis-cancelled'
  | 'speech-rate-limited'
  | 'local-voice-unavailable'
  | 'session-unavailable'
  | 'cleanup-failed';

export type VoiceKeySource = 'environment' | 'temporary' | 'missing';
export type VoiceProviderSource = 'local' | 'cli-native' | 'cloud';
export type VoiceProviderCapability = 'stt' | 'tts' | 'full-duplex';
export type VoiceProviderPrivacy = 'local' | 'provider-cloud';
