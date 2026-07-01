import { describe, expect, it } from 'vitest';
import {
  VoiceLocalSttChunkPayloadSchema,
  VoiceLocalSttEventSchema,
  VoiceProviderStatusSchema,
  VoiceTranscriptionSessionSchema,
} from '../voice.schemas';

describe('voice.schemas', () => {
  it('parses legacy WebRTC transcription sessions with a default transport', () => {
    const parsed = VoiceTranscriptionSessionSchema.parse({
      sessionId: 'voice-session-1',
      clientSecret: 'ephemeral-secret',
      model: 'gpt-4o-transcribe',
      providerId: 'openai-realtime',
      sdpUrl: 'https://realtime.openai.com/v1/realtime/calls',
    });

    expect(parsed).toMatchObject({
      transport: 'webrtc',
      clientSecret: 'ephemeral-secret',
      providerId: 'openai-realtime',
    });
  });

  it('parses local segmented transcription sessions without cloud credentials', () => {
    const parsed = VoiceTranscriptionSessionSchema.parse({
      transport: 'local-segmented',
      sessionId: 'local-session-1',
      model: 'distil-large-v3',
      providerId: 'local-whisper',
      sampleRate: 16000,
      maxSegmentMs: 5000,
      language: 'en',
      task: 'transcribe',
    });

    expect(parsed).toEqual({
      transport: 'local-segmented',
      sessionId: 'local-session-1',
      model: 'distil-large-v3',
      providerId: 'local-whisper',
      sampleRate: 16000,
      maxSegmentMs: 5000,
      language: 'en',
      task: 'transcribe',
    });
  });

  it('validates local STT chunk payloads and rejects empty audio', () => {
    expect(VoiceLocalSttChunkPayloadSchema.parse({
      sessionId: 'local-session-1',
      seq: 1,
      wavBase64: 'UklGRg==',
      last: true,
    })).toEqual({
      sessionId: 'local-session-1',
      seq: 1,
      wavBase64: 'UklGRg==',
      last: true,
    });

    expect(VoiceLocalSttChunkPayloadSchema.safeParse({
      sessionId: 'local-session-1',
      seq: 1,
      wavBase64: '',
    }).success).toBe(false);
  });

  it('validates local STT transcript events', () => {
    expect(VoiceLocalSttEventSchema.parse({
      sessionId: 'local-session-1',
      kind: 'final',
      text: 'hello world',
      segmentId: 2,
    })).toEqual({
      sessionId: 'local-session-1',
      kind: 'final',
      text: 'hello world',
      segmentId: 2,
    });

    expect(VoiceLocalSttEventSchema.safeParse({
      sessionId: 'local-session-1',
      kind: 'delta',
      text: 'hello',
    }).success).toBe(false);
  });

  it('allows provider status to label STT latency and location', () => {
    expect(VoiceProviderStatusSchema.parse({
      id: 'local-whisper',
      label: 'Local Whisper STT',
      source: 'local',
      capabilities: ['stt'],
      available: true,
      configured: true,
      active: false,
      privacy: 'local',
      latencyClass: 'near-realtime',
      location: 'worker-node',
    })).toMatchObject({
      latencyClass: 'near-realtime',
      location: 'worker-node',
    });
  });
});
