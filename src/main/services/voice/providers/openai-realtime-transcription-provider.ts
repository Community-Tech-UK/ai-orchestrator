import type {
  VoiceProviderStatus,
  VoiceTranscriptionSession,
} from '@contracts/schemas/voice';
import { randomUUID } from 'crypto';
import {
  type CreateVoiceTranscriptionSessionInput,
  type OpenAiVoiceProviderDeps,
  VoiceServiceError,
  type VoiceTranscriptionProvider,
} from './types';

const TRANSCRIPTION_SESSION_TIMEOUT_MS = 15000;
const ACTIVE_TRANSCRIPTION_SESSION_STALE_MS = 12 * 60 * 60 * 1000;

interface ActiveTranscriptionSession {
  sessionId: string;
  createdAt: number;
}

export class OpenAiRealtimeTranscriptionProvider implements VoiceTranscriptionProvider {
  readonly id = 'openai-realtime' as const;
  private activeTranscriptionSession: ActiveTranscriptionSession | null = null;

  constructor(private readonly deps: OpenAiVoiceProviderDeps) {}

  getStatus(): VoiceProviderStatus {
    const configured = this.deps.getKeySource() !== 'missing';
    return {
      id: this.id,
      label: 'OpenAI Realtime STT',
      source: 'cloud',
      capabilities: ['stt'],
      available: configured,
      configured,
      active: false,
      privacy: 'provider-cloud',
      ...(configured
        ? {}
        : {
            reason: 'Speech-to-text requires an OpenAI API key until a local or CLI-native STT provider is configured.',
            requiresSetup: 'Configure an OpenAI key or install a supported local STT provider.',
          }),
    };
  }

  async createSession(
    input: CreateVoiceTranscriptionSessionInput
  ): Promise<VoiceTranscriptionSession> {
    this.clearStaleTranscriptionSession();
    if (this.activeTranscriptionSession) {
      throw new VoiceServiceError(
        'session-unavailable',
        'Another voice session is already active.'
      );
    }

    const apiKey = this.deps.getApiKey();
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
      providerId: this.id,
      sdpUrl: this.extractSdpUrl(json),
    };
  }

  closeSession(sessionId: string): boolean {
    if (this.activeTranscriptionSession?.sessionId !== sessionId) {
      return false;
    }
    this.activeTranscriptionSession = null;
    return true;
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
