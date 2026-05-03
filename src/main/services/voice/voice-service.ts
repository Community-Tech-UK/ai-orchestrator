import type {
  VoiceStatus,
  VoiceTranscriptionSession,
  VoiceTtsResult,
} from '@contracts/schemas/voice';
import { randomUUID } from 'crypto';

export interface CreateVoiceTranscriptionSessionInput {
  model: string;
  language?: string;
}

export interface VoiceTtsInput {
  requestId: string;
  input: string;
  model: string;
  voice: string;
  format: 'mp3' | 'wav' | 'opus';
}

type VoiceKeySource = VoiceStatus['keySource'];

const OPENAI_TTS_INPUT_LIMIT = 4096;
const TRANSCRIPTION_SESSION_TIMEOUT_MS = 15000;
const TTS_TIMEOUT_MS = 30000;
const ACTIVE_TRANSCRIPTION_SESSION_STALE_MS = 12 * 60 * 60 * 1000;

interface ActiveTranscriptionSession {
  sessionId: string;
  createdAt: number;
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

export class VoiceService {
  private temporaryOpenAiApiKey: string | null = null;
  private activeTranscriptionSession: ActiveTranscriptionSession | null = null;
  private readonly ttsControllers = new Map<string, AbortController>();
  private readonly cancelledTtsRequests = new Set<string>();
  private ttsQueue: Promise<unknown> = Promise.resolve();

  getStatus(): VoiceStatus {
    const keySource = this.getKeySource();
    return {
      available: keySource !== 'missing',
      keySource,
      canConfigureTemporaryKey: true,
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
    this.clearStaleTranscriptionSession();
    if (this.activeTranscriptionSession) {
      throw new VoiceServiceError(
        'session-unavailable',
        'Another voice session is already active.'
      );
    }

    const apiKey = this.requireApiKey();
    const response = await this.fetchWithTimeout(
      'https://api.openai.com/v1/realtime/transcription_sessions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'transcription',
          audio: {
            input: {
              noise_reduction: { type: 'near_field' },
              transcription: {
                model: input.model,
                ...(input.language ? { language: input.language } : {}),
              },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
              },
            },
          },
          include: [],
        }),
      },
      TRANSCRIPTION_SESSION_TIMEOUT_MS,
      'VOICE_TRANSCRIPTION_SESSION_TIMEOUT'
    );

    const json = await this.readJsonResponse(
      response,
      'VOICE_TRANSCRIPTION_SESSION_FAILED'
    );
    const sessionId = randomUUID();
    this.activeTranscriptionSession = {
      sessionId,
      createdAt: Date.now(),
    };
    return {
      sessionId,
      clientSecret: this.extractClientSecret(json),
      expiresAt: this.extractExpiresAt(json),
      model: input.model,
      sdpUrl: this.extractSdpUrl(json),
    };
  }

  closeTranscriptionSession(sessionId: string): boolean {
    if (this.activeTranscriptionSession?.sessionId !== sessionId) {
      return false;
    }
    this.activeTranscriptionSession = null;
    return true;
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
    const controller = this.ttsControllers.get(requestId);
    if (!controller) {
      const cleanup = setTimeout(() => {
        this.cancelledTtsRequests.delete(requestId);
      }, TTS_TIMEOUT_MS);
      cleanup.unref?.();
      return false;
    }
    controller.abort();
    this.ttsControllers.delete(requestId);
    return true;
  }

  private async synthesizeSpeechNow(input: VoiceTtsInput): Promise<VoiceTtsResult> {
    if (this.cancelledTtsRequests.delete(input.requestId)) {
      throw new VoiceServiceError('VOICE_TTS_CANCELLED', 'Speech request was cancelled.');
    }

    const apiKey = this.requireApiKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
    this.ttsControllers.set(input.requestId, controller);

    try {
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: input.model,
          voice: input.voice,
          input: input.input,
          response_format: input.format,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        await this.throwOpenAiError(response, 'VOICE_TTS_FAILED');
      }

      const arrayBuffer = await response.arrayBuffer();
      return {
        requestId: input.requestId,
        audioBase64: Buffer.from(arrayBuffer).toString('base64'),
        mimeType: this.mimeTypeForFormat(input.format),
        format: input.format,
      };
    } catch (error) {
      if (this.isAbortError(error)) {
        throw new VoiceServiceError('VOICE_TTS_CANCELLED', 'Speech request was cancelled.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.ttsControllers.delete(input.requestId);
      this.cancelledTtsRequests.delete(input.requestId);
    }
  }

  private requireApiKey(): string {
    const apiKey = process.env['OPENAI_API_KEY']?.trim() || this.temporaryOpenAiApiKey;
    if (!apiKey) {
      throw new VoiceServiceError(
        'missing-api-key',
        'OpenAI API key is required for voice.'
      );
    }
    return apiKey;
  }

  private getKeySource(): VoiceKeySource {
    if (process.env['OPENAI_API_KEY']?.trim()) return 'environment';
    if (this.temporaryOpenAiApiKey) return 'temporary';
    return 'missing';
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    timeoutCode: string
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (this.isAbortError(error)) {
        throw new VoiceServiceError(timeoutCode, 'OpenAI voice request timed out.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readJsonResponse(response: Response, fallbackCode: string): Promise<Record<string, unknown>> {
    if (!response.ok) {
      await this.throwOpenAiError(response, fallbackCode);
    }
    const json = await response.json();
    if (!json || typeof json !== 'object') {
      throw new VoiceServiceError(fallbackCode, 'OpenAI returned an invalid voice response.');
    }
    return json as Record<string, unknown>;
  }

  private async throwOpenAiError(response: Response, fallbackCode: string): Promise<never> {
    let message = `OpenAI voice request failed (${response.status}).`;
    try {
      const body = await response.json() as {
        error?: { code?: string; message?: string };
      };
      if (body.error?.message) message = this.sanitizeOpenAiErrorMessage(body.error.message);
    } catch {
      // Keep the generic message. Do not include raw response bodies in errors.
    }

    const code = response.status === 429 ? 'speech-rate-limited' : fallbackCode;
    throw new VoiceServiceError(code, message);
  }

  private extractClientSecret(json: Record<string, unknown>): string {
    const clientSecret = json['client_secret'];
    if (typeof clientSecret === 'string') return clientSecret;
    if (clientSecret && typeof clientSecret === 'object') {
      const value = (clientSecret as Record<string, unknown>)['value'];
      if (typeof value === 'string') return value;
    }
    const value = json['value'];
    if (typeof value === 'string') return value;
    throw new VoiceServiceError(
      'VOICE_TRANSCRIPTION_SESSION_FAILED',
      'OpenAI did not return a realtime client secret.'
    );
  }

  private extractExpiresAt(json: Record<string, unknown>): number | undefined {
    if (typeof json['expires_at'] === 'number') return json['expires_at'];
    const clientSecret = json['client_secret'];
    if (clientSecret && typeof clientSecret === 'object') {
      const expiresAt = (clientSecret as Record<string, unknown>)['expires_at'];
      if (typeof expiresAt === 'number') return expiresAt;
    }
    return undefined;
  }

  private extractSdpUrl(json: Record<string, unknown>): string | undefined {
    const sessionDetails = json['session_details'];
    if (!sessionDetails || typeof sessionDetails !== 'object') return undefined;
    const streamUrl = (sessionDetails as Record<string, unknown>)['stream_url'];
    if (typeof streamUrl !== 'string') return undefined;
    try {
      const url = new URL(streamUrl);
      if (url.protocol === 'https:' && url.hostname.endsWith('.openai.com')) {
        return url.toString();
      }
    } catch {
      // Ignore invalid or unexpected URLs from the provider response.
    }
    return undefined;
  }

  private mimeTypeForFormat(format: VoiceTtsInput['format']): string {
    switch (format) {
      case 'mp3':
        return 'audio/mpeg';
      case 'wav':
        return 'audio/wav';
      case 'opus':
        return 'audio/ogg; codecs=opus';
    }
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
  }

  private clearStaleTranscriptionSession(): void {
    const active = this.activeTranscriptionSession;
    if (!active) return;
    if (Date.now() - active.createdAt > ACTIVE_TRANSCRIPTION_SESSION_STALE_MS) {
      this.activeTranscriptionSession = null;
    }
  }

  private sanitizeOpenAiErrorMessage(message: string): string {
    return message
      .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
      .slice(0, 240);
  }
}
