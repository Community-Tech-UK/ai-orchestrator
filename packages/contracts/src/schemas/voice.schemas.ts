import { z } from 'zod';

export const VoiceKeySourceSchema = z.enum(['environment', 'temporary', 'missing']);
export const VoiceProviderSourceSchema = z.enum(['local', 'cli-native', 'cloud']);
export const VoiceProviderCapabilitySchema = z.enum(['stt', 'tts', 'full-duplex']);
export const VoiceProviderPrivacySchema = z.enum(['local', 'provider-cloud']);
export const VoiceProviderLatencyClassSchema = z.enum(['live', 'near-realtime']);
export const VoiceProviderLocationSchema = z.enum(['this-device', 'worker-node', 'cloud']);
export const VoiceTranscriptionTaskSchema = z.enum(['transcribe', 'translate']);

export const VoiceProviderStatusSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  source: VoiceProviderSourceSchema,
  capabilities: z.array(VoiceProviderCapabilitySchema).min(1),
  available: z.boolean(),
  configured: z.boolean(),
  active: z.boolean(),
  privacy: VoiceProviderPrivacySchema,
  reason: z.string().optional(),
  requiresSetup: z.string().optional(),
  latencyClass: VoiceProviderLatencyClassSchema.optional(),
  location: VoiceProviderLocationSchema.optional(),
});

export const VoiceStatusSchema = z.object({
  available: z.boolean(),
  keySource: VoiceKeySourceSchema,
  canConfigureTemporaryKey: z.boolean(),
  activeTranscriptionProviderId: z.string().optional(),
  activeTtsProviderId: z.string().optional(),
  providers: z.array(VoiceProviderStatusSchema),
  unavailableReason: z.string().optional(),
});

export const VoiceSetTemporaryOpenAiKeyPayloadSchema = z.object({
  apiKey: z.string().trim().min(20),
  ipcAuthToken: z.string().optional(),
});

export const VoiceAuthenticatedPayloadSchema = z.object({
  ipcAuthToken: z.string().optional(),
});

export const VoiceCreateTranscriptionSessionPayloadSchema = z.object({
  model: z.string().default('gpt-4o-transcribe'),
  language: z.string().trim().min(2).max(16).optional(),
  providerId: z.string().trim().min(1).max(128).optional(),
  ipcAuthToken: z.string().optional(),
});

export const VoiceWebrtcTranscriptionSessionSchema = z.object({
  transport: z.literal('webrtc').optional().default('webrtc'),
  sessionId: z.string().min(1),
  clientSecret: z.string().min(1),
  expiresAt: z.number().optional(),
  model: z.string(),
  providerId: z.string().optional(),
  sdpUrl: z.string().url().optional(),
});

export const VoiceLocalSegmentedTranscriptionSessionSchema = z.object({
  transport: z.literal('local-segmented'),
  sessionId: z.string().min(1),
  model: z.string().min(1),
  providerId: z.string().optional(),
  sampleRate: z.number().int().positive(),
  maxSegmentMs: z.number().int().min(1000).max(30000).optional(),
  language: z.string().trim().min(2).max(16).default('en'),
  task: VoiceTranscriptionTaskSchema.default('transcribe'),
});

export const VoiceTranscriptionSessionSchema = z.union([
  VoiceWebrtcTranscriptionSessionSchema,
  VoiceLocalSegmentedTranscriptionSessionSchema,
]);

export const VoiceCloseTranscriptionSessionPayloadSchema = z.object({
  sessionId: z.string().trim().min(1).max(128),
  ipcAuthToken: z.string().optional(),
});

const LOCAL_STT_WAV_BASE64_MAX_LENGTH = 16 * 1024 * 1024;

export const VoiceLocalSttChunkPayloadSchema = z.object({
  sessionId: z.string().trim().min(1).max(128),
  seq: z.number().int().nonnegative(),
  wavBase64: z.string().min(1).max(LOCAL_STT_WAV_BASE64_MAX_LENGTH),
  last: z.boolean().optional(),
  ipcAuthToken: z.string().optional(),
});

export const VoiceLocalSttEventSchema = z.object({
  sessionId: z.string().min(1),
  kind: z.enum(['partial', 'final', 'error']),
  text: z.string().optional(),
  segmentId: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

export const VoiceTtsPayloadSchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  input: z.string().trim().min(1).max(4096),
  model: z.string().default('gpt-4o-mini-tts'),
  voice: z.string().default('alloy'),
  format: z.enum(['mp3', 'wav', 'opus']).default('mp3'),
  providerId: z.string().trim().min(1).max(128).optional(),
  ipcAuthToken: z.string().optional(),
});

export const VoiceTtsCancelPayloadSchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  ipcAuthToken: z.string().optional(),
});

export const VoiceTtsResultSchema = z.object({
  requestId: z.string().min(1),
  audioBase64: z.string().min(1),
  mimeType: z.string().min(1),
  format: z.enum(['mp3', 'wav', 'opus']),
  providerId: z.string().optional(),
  local: z.boolean().optional(),
});

export type VoiceProviderStatus = z.infer<typeof VoiceProviderStatusSchema>;
export type VoiceStatus = z.infer<typeof VoiceStatusSchema>;
export type VoiceWebrtcTranscriptionSession = z.infer<typeof VoiceWebrtcTranscriptionSessionSchema>;
export type VoiceLocalSegmentedTranscriptionSession = z.infer<typeof VoiceLocalSegmentedTranscriptionSessionSchema>;
export type VoiceTranscriptionSession = z.infer<typeof VoiceTranscriptionSessionSchema>;
export type VoiceLocalSttChunkPayload = z.infer<typeof VoiceLocalSttChunkPayloadSchema>;
export type VoiceLocalSttEvent = z.infer<typeof VoiceLocalSttEventSchema>;
export type VoiceTtsResult = z.infer<typeof VoiceTtsResultSchema>;
