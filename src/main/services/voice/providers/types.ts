import type {
  VoiceProviderStatus,
  VoiceTranscriptionSession,
  VoiceTtsResult,
} from '@contracts/schemas/voice';
import type { VoiceKeySource } from '../../../../shared/types/voice.types';

export type VoiceTtsFormat = 'mp3' | 'wav' | 'opus';
export type VoiceTranscriptionProviderId = 'openai-realtime';
export type VoiceTtsProviderId = 'local-macos-say' | 'openai-tts';
export type VoiceProviderId = VoiceTranscriptionProviderId | VoiceTtsProviderId;

export interface CreateVoiceTranscriptionSessionInput {
  model: string;
  language?: string;
  providerId?: string;
}

export interface VoiceTtsInput {
  requestId: string;
  input: string;
  model: string;
  voice: string;
  format: VoiceTtsFormat;
  providerId?: string;
}

export class VoiceServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'VoiceServiceError';
  }
}

export interface VoiceTranscriptionProvider {
  readonly id: VoiceTranscriptionProviderId;
  getStatus(): VoiceProviderStatus;
  createSession(input: CreateVoiceTranscriptionSessionInput): Promise<VoiceTranscriptionSession>;
  closeSession(sessionId: string): boolean;
}

export interface VoiceTtsProvider {
  readonly id: VoiceTtsProviderId;
  getStatus(): VoiceProviderStatus;
  synthesize(input: VoiceTtsInput): Promise<VoiceTtsResult>;
  cancel(requestId: string): boolean;
  destroy?(): void;
}

export interface OpenAiVoiceProviderDeps {
  getApiKey(): string;
  getKeySource(): VoiceKeySource;
}
