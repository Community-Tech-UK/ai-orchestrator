import { Injectable, NgZone, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { VoiceIpcService } from '../services/ipc/voice-ipc.service';
import type { VoiceProviderStatus } from '@contracts/schemas/voice';
import type {
  InstanceProvider,
  InstanceStatus,
  OutputMessage,
} from '../state/instance/instance.types';
import type {
  VoiceConversationPhase,
  VoiceErrorCode,
  VoiceKeySource,
} from '../../../../shared/types/voice.types';
import { truncateForTts, toSpeakableText } from './speech-text';
import {
  RealtimeTranscriptionService,
  VoiceTranscriptEvent,
  VoiceTranscriptionConnection,
  VoiceTranscriptionError,
} from './realtime-transcription.service';
import { VoicePlaybackService } from './voice-playback.service';

export interface VoiceConversationSessionContext {
  instanceId: string;
  status: InstanceStatus;
  messages: OutputMessage[];
  provider: InstanceProvider;
  sendInput: (message: string) => void;
  steerInput: (message: string) => void;
}

@Injectable({ providedIn: 'root' })
export class VoiceConversationStore {
  private readonly voiceIpc = inject(VoiceIpcService);
  private readonly transcription = inject(RealtimeTranscriptionService);
  private readonly playback = inject(VoicePlaybackService);
  private readonly zone = inject(NgZone);

  readonly mode = signal<VoiceConversationPhase>('off');
  readonly partialTranscript = signal('');
  readonly lastFinalTranscript = signal('');
  readonly error = signal<string | null>(null);
  readonly errorCode = signal<VoiceErrorCode | null>(null);
  readonly voiceAvailable = signal(false);
  readonly keySource = signal<VoiceKeySource>('missing');
  readonly activeTranscriptionProviderId = signal<string | null>(null);
  readonly activeTtsProviderId = signal<string | null>(null);
  readonly voiceProviders = signal<VoiceProviderStatus[]>([]);
  readonly transcriptDetached = signal(false);
  readonly audioLevel = signal(0);
  readonly providerSummary = signal<string | null>(null);

  private context: VoiceConversationSessionContext | null = null;
  private connection: VoiceTranscriptionConnection | null = null;
  private transcriptSubscription: Subscription | null = null;
  private voiceStartedAtMessageIndex = 0;
  private readonly spokenMessageKeys = new Set<string>();
  private activeSpeechItemId: string | null = null;
  private currentSpeechRequestId: string | null = null;
  private currentTranscriptionSessionId: string | null = null;
  private audioContext: AudioContext | null = null;
  private bargeInGeneration = 0;
  private startGeneration = 0;
  private maskedUntilStable = false;
  private reconnectAttempted = false;
  private speakTimer: ReturnType<typeof setTimeout> | null = null;
  private levelTimer: ReturnType<typeof setInterval> | null = null;

  async start(context: VoiceConversationSessionContext): Promise<void> {
    if (this.mode() !== 'off') {
      this.stop();
    }
    const generation = ++this.startGeneration;

    this.context = context;
    this.voiceStartedAtMessageIndex = context.messages.length;
    this.spokenMessageKeys.clear();
    this.bargeInGeneration = 0;
    this.maskedUntilStable = false;
    this.reconnectAttempted = false;
    this.activeSpeechItemId = null;
    this.error.set(null);
    this.errorCode.set(null);
    this.transcriptDetached.set(false);
    this.partialTranscript.set('');
    this.mode.set('connecting');

    try {
      const previousAudioContext = this.audioContext;
      const audioContext = await this.ensureAudioContext();
      if (!this.isCurrentStart(generation)) {
        if (audioContext !== previousAudioContext) {
          await audioContext.close().catch(() => undefined);
        }
        return;
      }
      this.audioContext = audioContext;

      const status = await this.voiceIpc.getStatus();
      if (!this.isCurrentStart(generation)) return;
      this.applyVoiceStatus(status);
      if (!status.available) {
        this.enterError(
          status.keySource === 'missing' ? 'missing-api-key' : 'voice-provider-unavailable',
          status.unavailableReason || 'No usable voice provider is available.'
        );
        return;
      }

      const session = await this.voiceIpc.createTranscriptionSession({
        model: 'gpt-4o-transcribe',
        providerId: status.activeTranscriptionProviderId,
      });
      if (!this.isCurrentStart(generation)) {
        await this.voiceIpc.closeTranscriptionSession(session.sessionId).catch(() => undefined);
        return;
      }
      await this.connectTranscription(session);
      if (!this.isCurrentStart(generation)) return;
      this.mode.set('listening');
    } catch (error) {
      if (this.isCurrentStart(generation)) {
        this.handleStartError(error);
      }
    }
  }

  updateContext(context: VoiceConversationSessionContext): void {
    const previousInstanceId = this.context?.instanceId;
    this.context = context;

    if (previousInstanceId && previousInstanceId !== context.instanceId) {
      this.stop();
      return;
    }

    if (this.maskedUntilStable && this.isStableStatus(context.status)) {
      this.maskedUntilStable = false;
    }

    if (this.mode() === 'waiting-for-session' || this.mode() === 'listening') {
      this.scheduleSpeakCheck();
    }
  }

  stop(): void {
    this.startGeneration += 1;
    this.mode.set(this.mode() === 'off' ? 'off' : 'stopping');
    this.clearSpeakTimer();
    this.stopLevelPolling();
    this.transcriptSubscription?.unsubscribe();
    this.transcriptSubscription = null;
    this.connection?.close();
    this.connection = null;
    this.playback.stop();
    void this.releaseCurrentTranscriptionSession();
    void this.cancelCurrentSpeech();
    this.audioLevel.set(0);
    this.mode.set('off');
    this.partialTranscript.set('');
    this.transcriptDetached.set(false);
    this.activeSpeechItemId = null;
  }

  async setTemporaryOpenAiKey(apiKey: string): Promise<void> {
    const status = await this.voiceIpc.setTemporaryOpenAiKey(apiKey);
    this.applyVoiceStatus(status);
    this.error.set(null);
    this.errorCode.set(null);
    if (this.mode() === 'error') this.mode.set('off');
  }

  async clearTemporaryOpenAiKey(): Promise<void> {
    const status = await this.voiceIpc.clearTemporaryOpenAiKey();
    this.applyVoiceStatus(status);
  }

  detachTranscript(): void {
    if (this.partialTranscript()) {
      this.transcriptDetached.set(true);
    }
  }

  private async connectTranscription(session: {
    sessionId: string;
    clientSecret: string;
    expiresAt?: number;
    model: string;
    sdpUrl?: string;
  }): Promise<void> {
    if (!this.audioContext) {
      throw new Error('AudioContext is not available.');
    }
    this.transcriptSubscription?.unsubscribe();
    this.connection?.close();
    await this.releaseCurrentTranscriptionSession();
    this.currentTranscriptionSessionId = session.sessionId;
    this.connection = await this.transcription.connect(session, this.audioContext);
    this.transcriptSubscription = this.connection.events.subscribe((event) => {
      this.zone.run(() => this.handleTranscriptEvent(event));
    });
    this.startLevelPolling();
  }

  private handleTranscriptEvent(event: VoiceTranscriptEvent): void {
    switch (event.kind) {
      case 'speech-started':
        this.handleSpeechStarted(event.itemId);
        break;
      case 'partial':
        this.handlePartialTranscript(event);
        break;
      case 'final':
        this.handleFinalTranscript(event.text || '', event.itemId);
        break;
      case 'connection-lost':
        this.enterError('voice-connection-lost', event.error || 'Voice connection was lost.');
        break;
      case 'credential-expired':
        void this.reconnectAfterCredentialExpiry();
        break;
      case 'error':
        this.enterError('transcription-failed', event.error || 'Voice transcription failed.');
        break;
      case 'speech-stopped':
        break;
    }
  }

  private handleSpeechStarted(itemId?: string): void {
    if (itemId && itemId !== this.activeSpeechItemId) {
      this.activeSpeechItemId = itemId;
      this.transcriptDetached.set(false);
    }
    this.bargeInGeneration += 1;
    this.maskedUntilStable = true;
    if (this.context) {
      this.voiceStartedAtMessageIndex = this.context.messages.length;
    }
    this.clearSpeakTimer();
    this.playback.stop();
    void this.cancelCurrentSpeech();
    if (this.mode() === 'speaking' || this.mode() === 'waiting-for-session') {
      this.mode.set('transcribing');
    }
  }

  private handlePartialTranscript(event: VoiceTranscriptEvent): void {
    if (event.itemId && event.itemId !== this.activeSpeechItemId) {
      this.activeSpeechItemId = event.itemId;
      this.transcriptDetached.set(false);
    }
    if (!this.transcriptDetached()) {
      this.partialTranscript.set(event.text || '');
    }
    if (this.mode() !== 'speaking') {
      this.mode.set('transcribing');
    }
  }

  private handleFinalTranscript(text: string, itemId?: string): void {
    if (itemId && itemId !== this.activeSpeechItemId) {
      this.activeSpeechItemId = itemId;
    }

    const message = text.trim();
    if (!message || !this.context) {
      this.mode.set('listening');
      return;
    }

    this.lastFinalTranscript.set(message);
    this.partialTranscript.set('');
    this.playback.stop();
    void this.cancelCurrentSpeech();

    if (this.transcriptDetached()) {
      this.mode.set('listening');
      return;
    }

    this.mode.set('sending');
    if (this.isSteerableStatus(this.context.status)) {
      this.context.steerInput(message);
    } else if (this.isStableStatus(this.context.status)) {
      this.context.sendInput(message);
    } else {
      this.enterError(
        'session-unavailable',
        `Voice cannot send while the session is ${this.context.status}.`
      );
      return;
    }
    this.mode.set('waiting-for-session');
  }

  private scheduleSpeakCheck(): void {
    this.clearSpeakTimer();
    this.speakTimer = setTimeout(() => {
      void this.maybeSpeakLatest();
    }, 700);
  }

  private async maybeSpeakLatest(): Promise<void> {
    const context = this.context;
    if (!context || this.maskedUntilStable || !this.isStableStatus(context.status)) {
      return;
    }
    if (this.mode() === 'speaking' || this.mode() === 'transcribing' || this.mode() === 'off') {
      return;
    }

    const candidate = this.findLatestSpeakableMessage(context.messages);
    if (!candidate) {
      if (this.mode() === 'waiting-for-session') this.mode.set('listening');
      return;
    }

    await this.speakAssistantMessage(candidate.message, candidate.key);
  }

  private findLatestSpeakableMessage(
    messages: OutputMessage[]
  ): { message: OutputMessage; key: string } | null {
    for (let index = messages.length - 1; index >= this.voiceStartedAtMessageIndex; index -= 1) {
      const message = messages[index];
      if (!message || message.type !== 'assistant' || message.thinking?.length) continue;
      const key = this.messageKey(message, index);
      if (this.spokenMessageKeys.has(key)) continue;
      const text = truncateForTts(toSpeakableText(message.content));
      if (!text) continue;
      return { message, key };
    }
    return null;
  }

  private async speakAssistantMessage(
    message: OutputMessage,
    messageKey: string
  ): Promise<void> {
    const text = truncateForTts(toSpeakableText(message.content));
    if (!text) return;

    const generation = this.bargeInGeneration;
    const requestId = crypto.randomUUID();
    this.currentSpeechRequestId = requestId;
    this.spokenMessageKeys.add(messageKey);
    this.mode.set('speaking');

    try {
      const audio = await this.voiceIpc.synthesizeSpeech({
        requestId,
        input: text,
        model: 'gpt-4o-mini-tts',
        voice: 'alloy',
        format: this.activeTtsProviderId() === 'local-macos-say' ? 'wav' : 'mp3',
        providerId: this.activeTtsProviderId() ?? undefined,
      });
      if (
        generation !== this.bargeInGeneration ||
        requestId !== this.currentSpeechRequestId
      ) {
        return;
      }
      await this.playback.play(audio, text);
      if (this.mode() === 'speaking') {
        this.mode.set('listening');
      }
    } catch (error) {
      if (generation !== this.bargeInGeneration) return;
      const messageText = error instanceof Error ? error.message : 'Speech synthesis failed.';
      if (/cancel/i.test(messageText)) return;
      this.enterError('speech-synthesis-failed', messageText);
    } finally {
      if (this.currentSpeechRequestId === requestId) {
        this.currentSpeechRequestId = null;
      }
    }
  }

  private async cancelCurrentSpeech(): Promise<void> {
    const requestId = this.currentSpeechRequestId;
    this.currentSpeechRequestId = null;
    if (requestId) {
      await this.voiceIpc.cancelSpeech(requestId).catch(() => undefined);
    }
  }

  private async reconnectAfterCredentialExpiry(): Promise<void> {
    if (this.reconnectAttempted || !this.context) {
      this.enterError('voice-credential-expired', 'Voice credential expired.');
      return;
    }
    const generation = this.startGeneration;
    this.reconnectAttempted = true;
    try {
      await this.releaseCurrentTranscriptionSession();
      if (!this.isCurrentGeneration(generation)) return;
      const session = await this.voiceIpc.createTranscriptionSession({
        model: 'gpt-4o-transcribe',
        providerId: this.activeTranscriptionProviderId() ?? undefined,
      });
      if (!this.isCurrentGeneration(generation)) {
        await this.voiceIpc.closeTranscriptionSession(session.sessionId).catch(() => undefined);
        return;
      }
      await this.connectTranscription(session);
      if (!this.isCurrentGeneration(generation)) return;
      this.mode.set('listening');
    } catch {
      if (this.isCurrentGeneration(generation)) {
        this.enterError('voice-credential-expired', 'Voice credential expired.');
      }
    }
  }

  private handleStartError(error: unknown): void {
    if (error instanceof VoiceTranscriptionError) {
      this.enterError(error.code, error.message);
      return;
    }
    this.enterError(
      'provider-session-failed',
      error instanceof Error ? error.message : 'Voice failed to start.'
    );
  }

  private applyVoiceStatus(status: {
    available: boolean;
    keySource: VoiceKeySource;
    activeTranscriptionProviderId?: string;
    activeTtsProviderId?: string;
    providers: VoiceProviderStatus[];
  }): void {
    this.voiceAvailable.set(status.available);
    this.keySource.set(status.keySource);
    this.activeTranscriptionProviderId.set(status.activeTranscriptionProviderId ?? null);
    this.activeTtsProviderId.set(status.activeTtsProviderId ?? null);
    this.voiceProviders.set(status.providers);
    this.providerSummary.set(this.summarizeProviders(status.providers));
  }

  private summarizeProviders(providers: VoiceProviderStatus[]): string | null {
    const activeProviders = providers.filter((provider) => provider.active);
    if (activeProviders.length === 0) return null;
    const hasLocalTts = activeProviders.some((provider) =>
      provider.id === 'local-macos-say'
    );
    const hasCloudStt = activeProviders.some((provider) =>
      provider.capabilities.includes('stt') && provider.privacy === 'provider-cloud'
    );
    const hasCloudTts = activeProviders.some((provider) =>
      provider.capabilities.includes('tts') && provider.privacy === 'provider-cloud'
    );
    if (hasLocalTts && hasCloudStt) return 'Local TTS + cloud STT';
    if (hasCloudStt && hasCloudTts) return 'Cloud STT/TTS';
    if (activeProviders.every((provider) => provider.privacy === 'local')) return 'Local voice';
    return activeProviders.map((provider) => provider.label).join(' + ');
  }

  private enterError(code: VoiceErrorCode, message: string): void {
    this.clearSpeakTimer();
    this.stopLevelPolling();
    this.transcriptSubscription?.unsubscribe();
    this.transcriptSubscription = null;
    this.connection?.close();
    this.connection = null;
    this.playback.stop();
    void this.releaseCurrentTranscriptionSession();
    void this.cancelCurrentSpeech();
    this.audioLevel.set(0);
    this.errorCode.set(code);
    this.error.set(message);
    this.mode.set('error');
  }

  private startLevelPolling(): void {
    this.stopLevelPolling();
    this.levelTimer = setInterval(() => {
      if (this.connection) {
        this.audioLevel.set(this.connection.level());
      }
    }, 67);
  }

  private stopLevelPolling(): void {
    if (this.levelTimer) {
      clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
  }

  private clearSpeakTimer(): void {
    if (this.speakTimer) {
      clearTimeout(this.speakTimer);
      this.speakTimer = null;
    }
  }

  private isStableStatus(status: InstanceStatus): boolean {
    return status === 'idle' || status === 'ready' || status === 'waiting_for_input';
  }

  private isSteerableStatus(status: InstanceStatus): boolean {
    return status === 'busy'
      || status === 'processing'
      || status === 'thinking_deeply'
      || status === 'waiting_for_permission';
  }

  private messageKey(message: OutputMessage, index: number): string {
    if (message.id) return message.id;
    const content = message.content || '';
    return `${index}:${message.type}:${content.length}:${content.slice(0, 16)}:${content.slice(-16)}`;
  }

  private async ensureAudioContext(): Promise<AudioContext> {
    const Ctor = window.AudioContext || this.webkitAudioContext();
    if (!Ctor) {
      throw new Error('AudioContext is not available in this browser.');
    }
    const audioContext = this.audioContext || new Ctor();
    await audioContext.resume();
    return audioContext;
  }

  private isCurrentStart(generation: number): boolean {
    return generation === this.startGeneration && this.mode() === 'connecting';
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.startGeneration
      && this.mode() !== 'off'
      && this.mode() !== 'error';
  }

  private async releaseCurrentTranscriptionSession(): Promise<void> {
    const sessionId = this.currentTranscriptionSessionId;
    this.currentTranscriptionSessionId = null;
    if (sessionId) {
      await this.voiceIpc.closeTranscriptionSession(sessionId).catch(() => undefined);
    }
  }

  private webkitAudioContext(): typeof AudioContext | undefined {
    return (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  }
}
