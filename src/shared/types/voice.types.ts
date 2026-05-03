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
  | 'transcription-failed'
  | 'voice-connection-lost'
  | 'voice-credential-expired'
  | 'speech-synthesis-failed'
  | 'speech-synthesis-cancelled'
  | 'speech-rate-limited'
  | 'session-unavailable'
  | 'cleanup-failed';

export type VoiceKeySource = 'environment' | 'temporary' | 'missing';
