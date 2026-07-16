import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceService, VoiceServiceError } from './voice-service';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../shared/types/settings.types';
import type {
  VoiceProviderStatus,
  VoiceTranscriptionSession,
} from '@contracts/schemas/voice';
import type {
  VoiceTranscriptionProvider,
  VoiceTranscriptionProviderId,
  VoiceTtsProvider,
} from './providers/types';

const ORIGINAL_OPENAI_API_KEY = process.env['OPENAI_API_KEY'];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function fakeTtsProvider(): VoiceTtsProvider {
  return {
    id: 'local-macos-say',
    getStatus: vi.fn(() => ({
      id: 'local-macos-say',
      label: 'macOS Local Voice',
      source: 'local' as const,
      capabilities: ['tts' as const],
      available: true,
      configured: true,
      active: false,
      privacy: 'local' as const,
    })),
    synthesize: vi.fn(),
    cancel: vi.fn(() => false),
    destroy: vi.fn(),
  };
}

function fakeTranscriptionProvider(
  id: VoiceTranscriptionProviderId,
  status: Partial<VoiceProviderStatus>
): VoiceTranscriptionProvider {
  return {
    id,
    getStatus: vi.fn(() => ({
      id,
      label: id,
      source: (id === 'openai-realtime' ? 'cloud' : 'local') as 'cloud' | 'local',
      capabilities: ['stt' as const],
      available: true,
      configured: true,
      active: false,
      privacy: (id === 'openai-realtime' ? 'provider-cloud' : 'local') as 'provider-cloud' | 'local',
      ...status,
    })),
    createSession: vi.fn(async () => ({
      transport: id === 'openai-realtime' ? 'webrtc' : 'local-segmented',
      sessionId: `${id}-session`,
      model: 'distil-large-v3',
      providerId: id,
      ...(id === 'openai-realtime'
        ? { clientSecret: 'ephemeral-secret' }
        : { sampleRate: 16000, language: 'en', task: 'transcribe' as const }),
    } as VoiceTranscriptionSession)),
    closeSession: vi.fn(() => false),
  };
}

describe('VoiceService', () => {
  beforeEach(() => {
    delete process.env['OPENAI_API_KEY'];
  });

  afterEach(() => {
    if (ORIGINAL_OPENAI_API_KEY === undefined) {
      delete process.env['OPENAI_API_KEY'];
    } else {
      process.env['OPENAI_API_KEY'] = ORIGINAL_OPENAI_API_KEY;
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reports provider availability without persisting temporary keys outside the service', () => {
    const localTts = {
      id: 'local-macos-say' as const,
      getStatus: vi.fn(() => ({
        id: 'local-macos-say',
        label: 'macOS Local Voice',
        source: 'local' as const,
        capabilities: ['tts' as const],
        available: true,
        configured: true,
        active: false,
        privacy: 'local' as const,
      })),
      synthesize: vi.fn(),
      cancel: vi.fn(() => false),
      destroy: vi.fn(),
    };
    const service = new VoiceService({
      localTts,
      commandExists: () => false,
    });

    expect(service.getStatus()).toMatchObject({
      available: false,
      keySource: 'missing',
      canConfigureTemporaryKey: true,
      activeTtsProviderId: 'local-macos-say',
      activeTranscriptionProviderId: undefined,
      unavailableReason: expect.stringContaining('Speech-to-text'),
    });
    expect(service.getStatus().providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'local-macos-say',
        source: 'local',
        capabilities: ['tts'],
        privacy: 'local',
        available: true,
        active: true,
      }),
      expect.objectContaining({
        id: 'openai-realtime',
        source: 'cloud',
        capabilities: ['stt'],
        privacy: 'provider-cloud',
        available: false,
      }),
    ]));

    service.setTemporaryOpenAiApiKey('sk-test-temporary-key-with-enough-length');

    expect(service.getStatus()).toMatchObject({
      available: true,
      keySource: 'temporary',
      canConfigureTemporaryKey: true,
      activeTranscriptionProviderId: 'openai-realtime',
      activeTtsProviderId: 'local-macos-say',
    });
  });

  it('routes TTS through the local provider by default when it is available', async () => {
    const localTts = {
      id: 'local-macos-say' as const,
      getStatus: vi.fn(() => ({
        id: 'local-macos-say',
        label: 'macOS Local Voice',
        source: 'local' as const,
        capabilities: ['tts' as const],
        available: true,
        configured: true,
        active: false,
        privacy: 'local' as const,
      })),
      synthesize: vi.fn(async () => ({
        requestId: 'tts-local',
        audioBase64: 'UklGRg==',
        mimeType: 'audio/wav',
        format: 'wav' as const,
        providerId: 'local-macos-say',
        local: true,
      })),
      cancel: vi.fn(() => false),
      destroy: vi.fn(),
    };
    const service = new VoiceService({
      localTts,
      commandExists: () => false,
    });

    await expect(service.synthesizeSpeech({
      requestId: 'tts-local',
      input: 'hello',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      format: 'wav',
    })).resolves.toMatchObject({
      providerId: 'local-macos-say',
      local: true,
      format: 'wav',
    });
    expect(localTts.synthesize).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'tts-local',
      input: 'hello',
    }));
  });

  it('mints one active transcription session and requires explicit release', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({
      client_secret: {
        value: 'ephemeral-client-secret',
        expires_at: 12345,
      },
      session_details: {
        stream_url: 'https://realtime.openai.com/v1/realtime/calls',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const service = new VoiceService({ commandExists: () => false });
    service.setTemporaryOpenAiApiKey('sk-test-temporary-key-with-enough-length');

    const session = await service.createTranscriptionSession({
      model: 'gpt-4o-transcribe',
      language: 'en',
    });

    expect(session).toMatchObject({
      clientSecret: 'ephemeral-client-secret',
      expiresAt: 12345,
      model: 'gpt-4o-transcribe',
      sdpUrl: 'https://realtime.openai.com/v1/realtime/calls',
    });
    expect(session.sessionId).toHaveLength(36);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/realtime/transcription_sessions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test-temporary-key-with-enough-length',
        }),
      }),
    );

    await expect(service.createTranscriptionSession({
      model: 'gpt-4o-transcribe',
    })).rejects.toMatchObject({
      code: 'session-unavailable',
    });

    expect(service.closeTranscriptionSession('wrong-session')).toBe(false);
    expect(service.closeTranscriptionSession(session.sessionId)).toBe(true);

    await expect(service.createTranscriptionSession({
      model: 'gpt-4o-transcribe',
    })).resolves.toMatchObject({
      clientSecret: 'ephemeral-client-secret',
    });
  });

  it('does not return untrusted provider SDP URLs to the renderer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      client_secret: { value: 'ephemeral-client-secret' },
      session_details: {
        stream_url: 'https://attacker.example/realtime',
      },
    })));

    const service = new VoiceService({ commandExists: () => false });
    service.setTemporaryOpenAiApiKey('sk-test-temporary-key-with-enough-length');

    await expect(service.createTranscriptionSession({
      model: 'gpt-4o-transcribe',
    })).resolves.toMatchObject({
      sdpUrl: undefined,
    });
  });

  it('rejects over-limit TTS input as a rejected promise', async () => {
    const service = new VoiceService({ commandExists: () => false });
    service.setTemporaryOpenAiApiKey('sk-test-temporary-key-with-enough-length');

    await expect(service.synthesizeSpeech({
      requestId: 'tts-1',
      input: 'x'.repeat(4097),
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      format: 'mp3',
    })).rejects.toBeInstanceOf(VoiceServiceError);
  });

  it('sanitizes OpenAI error messages before returning them to IPC handlers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: {
        message: 'quota failed for sk-sensitive-secret-token',
      },
    }, 429)));

    const service = new VoiceService({ commandExists: () => false });
    service.setTemporaryOpenAiApiKey('sk-test-temporary-key-with-enough-length');

    await expect(service.synthesizeSpeech({
      requestId: 'tts-2',
      input: 'hello',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      format: 'mp3',
      providerId: 'openai-tts',
    })).rejects.toMatchObject({
      code: 'speech-rate-limited',
      message: 'quota failed for [redacted]',
    });
  });

  it('prefers local STT over OpenAI in auto mode when a local route is healthy', () => {
    const service = new VoiceService({
      localTts: fakeTtsProvider(),
      localTranscription: fakeTranscriptionProvider('local-whisper', {
        location: 'worker-node',
        latencyClass: 'near-realtime',
      }),
      openAiTranscription: fakeTranscriptionProvider('openai-realtime', {
        location: 'cloud',
        latencyClass: 'live',
      }),
    });
    service.configure(settings({ voiceSttRoutingMode: 'auto' }));

    const status = service.getStatus();

    expect(status.activeTranscriptionProviderId).toBe('local-whisper');
    expect(status.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'local-whisper', active: true }),
      expect.objectContaining({ id: 'openai-realtime', active: false }),
    ]));
  });

  it('falls back to OpenAI in auto mode when local STT is unavailable', () => {
    const service = new VoiceService({
      localTts: fakeTtsProvider(),
      localTranscription: fakeTranscriptionProvider('local-whisper', {
        available: false,
        configured: true,
        location: 'worker-node',
      }),
      openAiTranscription: fakeTranscriptionProvider('openai-realtime', {
        available: true,
        location: 'cloud',
      }),
    });
    service.configure(settings({ voiceSttRoutingMode: 'auto' }));

    expect(service.getStatus().activeTranscriptionProviderId).toBe('openai-realtime');
  });

  it('threads command existence into the default local STT provider for CLI fallback', () => {
    const service = new VoiceService({
      localTts: fakeTtsProvider(),
      commandExists: (command) => command === 'whisper-cli',
      openAiTranscription: fakeTranscriptionProvider('openai-realtime', {
        available: false,
      }),
    });
    service.configure(settings({
      voiceSttRoutingMode: 'this-device',
      voiceLocalSttModel: '/models/ggml-distil-large-v3.bin',
    }));

    expect(service.getStatus()).toMatchObject({
      available: true,
      activeTranscriptionProviderId: 'local-whisper',
    });
  });

  it('honors explicit cloud routing even when local STT is healthy', () => {
    const service = new VoiceService({
      localTts: fakeTtsProvider(),
      localTranscription: fakeTranscriptionProvider('local-whisper', {
        location: 'this-device',
      }),
      openAiTranscription: fakeTranscriptionProvider('openai-realtime', {
        available: true,
        location: 'cloud',
      }),
    });
    service.configure(settings({ voiceSttRoutingMode: 'cloud' }));

    expect(service.getStatus().activeTranscriptionProviderId).toBe('openai-realtime');
  });

  it('does not fall back to cloud when worker-node routing is explicitly selected', () => {
    const service = new VoiceService({
      localTts: fakeTtsProvider(),
      localTranscription: fakeTranscriptionProvider('local-whisper', {
        available: false,
        configured: true,
        location: 'worker-node',
      }),
      openAiTranscription: fakeTranscriptionProvider('openai-realtime', {
        available: true,
        location: 'cloud',
      }),
    });
    service.configure(settings({ voiceSttRoutingMode: 'worker-node' }));

    expect(service.getStatus()).toMatchObject({
      available: false,
      activeTranscriptionProviderId: undefined,
      unavailableReason: expect.stringContaining('Speech-to-text provider'),
    });
  });

  it('routes local STT chunks through the local transcription provider', async () => {
    const localTranscription = {
      ...fakeTranscriptionProvider('local-whisper', {
        location: 'worker-node',
        latencyClass: 'near-realtime',
      }),
      pushSegment: vi.fn(async () => ({
        sessionId: 'local-session-1',
        kind: 'final' as const,
        text: 'hello local',
        segmentId: 4,
      })),
    };
    const service = new VoiceService({
      localTts: fakeTtsProvider(),
      localTranscription,
      openAiTranscription: fakeTranscriptionProvider('openai-realtime', {
        available: false,
      }),
    });

    await expect(service.pushLocalSttChunk({
      sessionId: 'local-session-1',
      seq: 4,
      wavBase64: 'UklGRg==',
      last: true,
    })).resolves.toEqual({
      sessionId: 'local-session-1',
      kind: 'final',
      text: 'hello local',
      segmentId: 4,
    });

    expect(localTranscription.pushSegment).toHaveBeenCalledWith({
      sessionId: 'local-session-1',
      seq: 4,
      wavBase64: 'UklGRg==',
      last: true,
    });
  });
});
