import type {
  VoiceLocalSttChunkPayload,
  VoiceLocalSttEvent,
  VoiceProviderStatus,
  VoiceStatus,
  VoiceTranscriptionSession,
  VoiceTtsResult,
} from '@contracts/schemas/voice';
import { existsSync } from 'fs';
import { delimiter, join } from 'path';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type VoiceSttRoutingMode,
} from '../../../shared/types/settings.types';
import { LocalWhisperTranscriptionProvider } from './providers/local-whisper-transcription-provider';
import { MacosSayTtsProvider } from './providers/macos-say-tts-provider';
import { OpenAiRealtimeTranscriptionProvider } from './providers/openai-realtime-transcription-provider';
import { OpenAiTtsProvider } from './providers/openai-tts-provider';
import {
  type CreateVoiceTranscriptionSessionInput,
  type VoiceTranscriptionProvider,
  type VoiceTranscriptionProviderId,
  VoiceServiceError,
  type VoiceTtsInput,
  type VoiceTtsProvider,
  type VoiceTtsProviderId,
} from './providers/types';

export { VoiceServiceError };
export type {
  CreateVoiceTranscriptionSessionInput,
  VoiceTtsInput,
} from './providers/types';

type VoiceKeySource = VoiceStatus['keySource'];

const OPENAI_TTS_INPUT_LIMIT = 4096;
const TTS_TIMEOUT_MS = 30000;

export interface VoiceServiceDeps {
  localTts?: VoiceTtsProvider;
  openAiTts?: VoiceTtsProvider;
  localTranscription?: VoiceTranscriptionProvider;
  openAiTranscription?: VoiceTranscriptionProvider;
  commandExists?: (command: string) => boolean;
}

export class VoiceService {
  private temporaryOpenAiApiKey: string | null = null;
  private readonly transcriptionProviders: VoiceTranscriptionProvider[];
  private readonly ttsProviders: VoiceTtsProvider[];
  private readonly commandExists: (command: string) => boolean;
  private readonly cancelledTtsRequests = new Set<string>();
  private settings: AppSettings = DEFAULT_SETTINGS;
  private ttsQueue: Promise<unknown> = Promise.resolve();

  constructor(deps: VoiceServiceDeps = {}) {
    const openAiDeps = {
      getApiKey: () => this.requireApiKey(),
      getKeySource: () => this.getKeySource(),
    };
    this.commandExists = deps.commandExists ?? commandExistsInPath;
    this.transcriptionProviders = [
      deps.localTranscription ?? new LocalWhisperTranscriptionProvider({
        commandExists: this.commandExists,
      }),
      deps.openAiTranscription ?? new OpenAiRealtimeTranscriptionProvider(openAiDeps),
    ];
    this.ttsProviders = [
      deps.localTts ?? new MacosSayTtsProvider(),
      deps.openAiTts ?? new OpenAiTtsProvider(openAiDeps),
    ];
  }

  configure(settings: AppSettings): void {
    this.settings = settings;
    for (const provider of this.transcriptionProviders) {
      if (this.hasTranscriptionProviderConfigure(provider)) {
        provider.configure(settings);
      }
    }
  }

  async refreshLocalSttHealth(): Promise<void> {
    const provider = this.transcriptionProviders.find((candidate) =>
      candidate.id === 'local-whisper'
    );
    if (provider && this.hasTranscriptionProviderRefresh(provider)) {
      await provider.refreshHealth();
    }
  }

  getStatus(): VoiceStatus {
    const providerStatuses = this.getProviderStatuses();
    const activeTranscriptionProviderId =
      this.selectActiveTranscriptionProviderId(providerStatuses);
    const activeTtsProviderId = this.selectActiveTtsProviderId(providerStatuses);
    const providers = providerStatuses.map((provider) => ({
      ...provider,
      active: provider.id === activeTranscriptionProviderId
        || provider.id === activeTtsProviderId,
    }));
    const available = Boolean(activeTranscriptionProviderId && activeTtsProviderId);

    return {
      available,
      keySource: this.getKeySource(),
      canConfigureTemporaryKey: true,
      activeTranscriptionProviderId,
      activeTtsProviderId,
      providers,
      ...(available
        ? {}
        : {
            unavailableReason: this.unavailableReason(
              activeTranscriptionProviderId,
              activeTtsProviderId
            ),
          }),
    };
  }

  setTemporaryOpenAiApiKey(apiKey: string): void {
    this.temporaryOpenAiApiKey = apiKey.trim();
  }

  clearTemporaryOpenAiApiKey(): void {
    this.temporaryOpenAiApiKey = null;
  }

  async createTranscriptionSession(
    input: CreateVoiceTranscriptionSessionInput
  ): Promise<VoiceTranscriptionSession> {
    const providerId = this.resolveTranscriptionProviderId(input.providerId);
    const provider = this.transcriptionProviders.find((candidate) =>
      candidate.id === providerId
    );
    if (!provider) {
      throw new VoiceServiceError(
        'voice-provider-unavailable',
        `Voice transcription provider ${providerId} is not available.`
      );
    }
    return provider.createSession({ ...input, providerId });
  }

  closeTranscriptionSession(sessionId: string): boolean {
    for (const provider of this.transcriptionProviders) {
      if (provider.closeSession(sessionId)) return true;
    }
    return false;
  }

  async pushLocalSttChunk(
    payload: VoiceLocalSttChunkPayload
  ): Promise<VoiceLocalSttEvent> {
    const provider = this.transcriptionProviders.find((candidate) =>
      candidate.id === 'local-whisper'
    );
    if (!provider?.pushSegment) {
      throw new VoiceServiceError(
        'local-stt-backend-unavailable',
        'Local speech-to-text is not available.'
      );
    }
    return provider.pushSegment({
      sessionId: payload.sessionId,
      seq: payload.seq,
      wavBase64: payload.wavBase64,
      last: payload.last,
    });
  }

  synthesizeSpeech(input: VoiceTtsInput): Promise<VoiceTtsResult> {
    if (input.input.length > OPENAI_TTS_INPUT_LIMIT) {
      return Promise.reject(new VoiceServiceError(
        'VOICE_TTS_INPUT_TOO_LONG',
        'Speech text is too long for TTS.'
      ));
    }

    const run = () => this.synthesizeSpeechNow(input);
    const result = this.ttsQueue.then(run, run);
    this.ttsQueue = result.catch(() => undefined);
    return result;
  }

  cancelSpeech(requestId: string): boolean {
    this.cancelledTtsRequests.add(requestId);
    let cancelled = false;
    for (const provider of this.ttsProviders) {
      cancelled = provider.cancel(requestId) || cancelled;
    }
    if (!cancelled) {
      const cleanup = setTimeout(() => {
        this.cancelledTtsRequests.delete(requestId);
      }, TTS_TIMEOUT_MS);
      cleanup.unref?.();
    }
    return cancelled;
  }

  destroy(): void {
    for (const provider of this.ttsProviders) {
      provider.destroy?.();
    }
  }

  private async synthesizeSpeechNow(input: VoiceTtsInput): Promise<VoiceTtsResult> {
    if (this.cancelledTtsRequests.delete(input.requestId)) {
      throw new VoiceServiceError('VOICE_TTS_CANCELLED', 'Speech request was cancelled.');
    }

    const providerId = this.resolveTtsProviderId(input.providerId);
    const provider = this.ttsProviders.find((candidate) => candidate.id === providerId);
    if (!provider) {
      throw new VoiceServiceError(
        'voice-provider-unavailable',
        `Voice TTS provider ${providerId} is not available.`
      );
    }

    try {
      return await provider.synthesize({
        ...input,
        providerId,
        format: providerId === 'local-macos-say' ? 'wav' : input.format,
      });
    } finally {
      this.cancelledTtsRequests.delete(input.requestId);
    }
  }

  private resolveTranscriptionProviderId(
    requestedProviderId?: string
  ): VoiceTranscriptionProviderId {
    if (requestedProviderId) {
      if (this.isTranscriptionProviderId(requestedProviderId)) {
        return requestedProviderId;
      }
      throw new VoiceServiceError(
        'voice-provider-unavailable',
        `Voice transcription provider ${requestedProviderId} is not available.`
      );
    }

    const providerId = this.selectActiveTranscriptionProviderId(this.getProviderStatuses());
    if (providerId) return providerId;
    if (this.getKeySource() === 'missing') {
      throw new VoiceServiceError(
        'missing-api-key',
        'Speech-to-text requires an OpenAI API key until a local or CLI-native STT provider is configured.'
      );
    }
    throw new VoiceServiceError(
      'voice-provider-unavailable',
      'No speech-to-text provider is available.'
    );
  }

  private resolveTtsProviderId(requestedProviderId?: string): VoiceTtsProviderId {
    if (requestedProviderId) {
      if (this.isTtsProviderId(requestedProviderId)) {
        return requestedProviderId;
      }
      throw new VoiceServiceError(
        'voice-provider-unavailable',
        `Voice TTS provider ${requestedProviderId} is not available.`
      );
    }

    const providerId = this.selectActiveTtsProviderId(this.getProviderStatuses());
    if (providerId) return providerId;
    throw new VoiceServiceError(
      'voice-provider-unavailable',
      'No text-to-speech provider is available.'
    );
  }

  private getProviderStatuses(): VoiceProviderStatus[] {
    return [
      ...this.transcriptionProviders.map((provider) => provider.getStatus()),
      ...this.ttsProviders.map((provider) => provider.getStatus()),
      this.claudeVoiceStreamStatus(),
      this.codexRealtimeStatus(),
    ];
  }

  private selectActiveTranscriptionProviderId(
    statuses: VoiceProviderStatus[]
  ): VoiceTranscriptionProviderId | undefined {
    const local = statuses.find((provider) => provider.id === 'local-whisper');
    const openAi = statuses.find((provider) => provider.id === 'openai-realtime');
    return this.selectTranscriptionProviderForMode(
      this.settings.voiceSttRoutingMode,
      local,
      openAi
    );
  }

  private selectTranscriptionProviderForMode(
    mode: VoiceSttRoutingMode,
    local: VoiceProviderStatus | undefined,
    openAi: VoiceProviderStatus | undefined
  ): VoiceTranscriptionProviderId | undefined {
    if (mode === 'cloud') {
      return openAi?.available ? 'openai-realtime' : undefined;
    }
    if (mode === 'this-device') {
      return local?.available && local.location === 'this-device'
        ? 'local-whisper'
        : undefined;
    }
    if (mode === 'worker-node') {
      return local?.available && local.location === 'worker-node'
        ? 'local-whisper'
        : undefined;
    }
    if (mode === 'this-device-or-cloud') {
      if (local?.available && local.location === 'this-device') return 'local-whisper';
      return openAi?.available ? 'openai-realtime' : undefined;
    }

    if (local?.available) return 'local-whisper';
    return openAi?.available ? 'openai-realtime' : undefined;
  }

  private selectActiveTtsProviderId(
    statuses: VoiceProviderStatus[]
  ): VoiceTtsProviderId | undefined {
    const local = statuses.find((provider) => provider.id === 'local-macos-say');
    if (local?.available) return 'local-macos-say';
    const openAi = statuses.find((provider) => provider.id === 'openai-tts');
    return openAi?.available ? 'openai-tts' : undefined;
  }

  private unavailableReason(
    activeTranscriptionProviderId: VoiceTranscriptionProviderId | undefined,
    activeTtsProviderId: VoiceTtsProviderId | undefined
  ): string {
    if (!activeTranscriptionProviderId && !activeTtsProviderId) {
      return 'Speech-to-text provider is unavailable, and no text-to-speech provider is available.';
    }
    if (!activeTranscriptionProviderId) {
      return 'Speech-to-text provider is unavailable.';
    }
    return 'No text-to-speech provider is available.';
  }

  private claudeVoiceStreamStatus(): VoiceProviderStatus {
    const configured = this.commandExists('claude');
    return {
      id: 'claude-voice-stream',
      label: 'Claude Voice Stream',
      source: 'cli-native',
      capabilities: ['stt'],
      available: false,
      configured,
      active: false,
      privacy: 'provider-cloud',
      reason: configured
        ? 'Claude CLI is installed, but it does not expose a stable public noninteractive audio API for this app.'
        : 'Claude CLI is not installed or not on PATH.',
      requiresSetup: 'Use a stable Claude audio API if Anthropic exposes one for CLI clients.',
    };
  }

  private codexRealtimeStatus(): VoiceProviderStatus {
    const configured = this.commandExists('codex');
    return {
      id: 'codex-realtime',
      label: 'Codex Realtime',
      source: 'cli-native',
      capabilities: ['full-duplex'],
      available: false,
      configured,
      active: false,
      privacy: 'provider-cloud',
      reason: configured
        ? 'Codex realtime is experimental and scoped to Codex sessions; the generic adapter is not enabled.'
        : 'Codex CLI is not installed or not on PATH.',
      requiresSetup: 'Enable a stable Codex app-server realtime adapter for Codex sessions.',
    };
  }

  private requireApiKey(): string {
    const apiKey = process.env['OPENAI_API_KEY']?.trim() || this.temporaryOpenAiApiKey;
    if (!apiKey) {
      throw new VoiceServiceError(
        'missing-api-key',
        'OpenAI API key is required for cloud voice providers.'
      );
    }
    return apiKey;
  }

  private getKeySource(): VoiceKeySource {
    if (process.env['OPENAI_API_KEY']?.trim()) return 'environment';
    if (this.temporaryOpenAiApiKey) return 'temporary';
    return 'missing';
  }

  private isTranscriptionProviderId(
    providerId: string
  ): providerId is VoiceTranscriptionProviderId {
    return this.transcriptionProviders.some((provider) => provider.id === providerId);
  }

  private isTtsProviderId(providerId: string): providerId is VoiceTtsProviderId {
    return this.ttsProviders.some((provider) => provider.id === providerId);
  }

  private hasTranscriptionProviderConfigure(
    provider: VoiceTranscriptionProvider
  ): provider is VoiceTranscriptionProvider & {
    configure(settings: AppSettings): void;
  } {
    return 'configure' in provider && typeof provider.configure === 'function';
  }

  private hasTranscriptionProviderRefresh(
    provider: VoiceTranscriptionProvider
  ): provider is VoiceTranscriptionProvider & {
    refreshHealth(): Promise<void>;
  } {
    return 'refreshHealth' in provider && typeof provider.refreshHealth === 'function';
  }
}

function commandExistsInPath(command: string): boolean {
  const pathValue = process.env['PATH'] ?? '';
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .some((pathDir) => existsSync(join(pathDir, command)));
}
