import type { VoiceProviderStatus, VoiceTtsResult } from '@contracts/schemas/voice';
import {
  type OpenAiVoiceProviderDeps,
  VoiceServiceError,
  type VoiceTtsInput,
  type VoiceTtsProvider,
} from './types';

const TTS_TIMEOUT_MS = 30000;

export class OpenAiTtsProvider implements VoiceTtsProvider {
  readonly id = 'openai-tts' as const;
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly deps: OpenAiVoiceProviderDeps) {}

  getStatus(): VoiceProviderStatus {
    const configured = this.deps.getKeySource() !== 'missing';
    return {
      id: this.id,
      label: 'OpenAI TTS',
      source: 'cloud',
      capabilities: ['tts'],
      available: configured,
      configured,
      active: false,
      privacy: 'provider-cloud',
      ...(configured
        ? {}
        : {
            reason: 'OpenAI TTS requires an OpenAI API key.',
            requiresSetup: 'Configure an OpenAI key.',
          }),
    };
  }

  async synthesize(input: VoiceTtsInput): Promise<VoiceTtsResult> {
    const apiKey = this.deps.getApiKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
    this.controllers.set(input.requestId, controller);

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
        providerId: this.id,
      };
    } catch (error) {
      if (this.isAbortError(error)) {
        throw new VoiceServiceError('VOICE_TTS_CANCELLED', 'Speech request was cancelled.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(input.requestId);
    }
  }

  cancel(requestId: string): boolean {
    const controller = this.controllers.get(requestId);
    if (!controller) return false;
    controller.abort();
    this.controllers.delete(requestId);
    return true;
  }

  destroy(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
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

  private sanitizeOpenAiErrorMessage(message: string): string {
    return message
      .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
      .slice(0, 240);
  }
}
