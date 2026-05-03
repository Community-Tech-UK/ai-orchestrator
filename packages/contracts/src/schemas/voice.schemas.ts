import { z } from 'zod';

export const VoiceKeySourceSchema = z.enum(['environment', 'temporary', 'missing']);

export const VoiceStatusSchema = z.object({
  available: z.boolean(),
  keySource: VoiceKeySourceSchema,
  canConfigureTemporaryKey: z.boolean(),
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
  ipcAuthToken: z.string().optional(),
});

export const VoiceTranscriptionSessionSchema = z.object({
  sessionId: z.string().min(1),
  clientSecret: z.string().min(1),
  expiresAt: z.number().optional(),
  model: z.string(),
  sdpUrl: z.string().url().optional(),
});

export const VoiceCloseTranscriptionSessionPayloadSchema = z.object({
  sessionId: z.string().trim().min(1).max(128),
  ipcAuthToken: z.string().optional(),
});

export const VoiceTtsPayloadSchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  input: z.string().trim().min(1).max(4096),
  model: z.string().default('gpt-4o-mini-tts'),
  voice: z.string().default('alloy'),
  format: z.enum(['mp3', 'wav', 'opus']).default('mp3'),
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
});

export type VoiceStatus = z.infer<typeof VoiceStatusSchema>;
export type VoiceTranscriptionSession = z.infer<typeof VoiceTranscriptionSessionSchema>;
export type VoiceTtsResult = z.infer<typeof VoiceTtsResultSchema>;
