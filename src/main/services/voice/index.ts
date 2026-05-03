import { VoiceService, VoiceServiceError } from './voice-service';

let instance: VoiceService | null = null;

export function getVoiceService(): VoiceService {
  instance ??= new VoiceService();
  return instance;
}

export function _resetVoiceServiceForTesting(): void {
  instance = null;
}

export { VoiceService, VoiceServiceError };
export type {
  CreateVoiceTranscriptionSessionInput,
  VoiceTtsInput,
} from './voice-service';
