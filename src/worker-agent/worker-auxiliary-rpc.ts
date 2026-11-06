import { z } from 'zod/v4';
import { generateOllamaOnWorker, generateOpenAiCompatibleOnWorker } from './worker-auxiliary-generate';
import { OLLAMA_LOCAL_BASE_URL, LMSTUDIO_LOCAL_BASE_URL } from './local-model-config';
import { AudioTranscribeParamsSchema } from '../main/remote-node/rpc-schemas';

type AudioTranscribeParams = z.infer<typeof AudioTranscribeParamsSchema>;

export async function handleAuxiliaryModelList(provider: 'ollama' | 'openai-compatible'): Promise<string[]> {
  if (provider === 'ollama') {
    const resp = await fetch(`${OLLAMA_LOCAL_BASE_URL}/api/tags`, { method: 'GET' });
    if (!resp.ok) throw new Error(`Ollama list failed: ${resp.status}`);
    const data = await resp.json() as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name);
  }
  if (provider === 'openai-compatible') {
    const resp = await fetch(`${LMSTUDIO_LOCAL_BASE_URL}/v1/models`, { method: 'GET' });
    if (!resp.ok) throw new Error(`OpenAI-compatible list failed: ${resp.status}`);
    const data = await resp.json() as { data?: { id: string }[] };
    return (data.data ?? []).map((m) => m.id);
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

export async function handleAuxiliaryModelGenerate(params: {
  provider: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  requireJson: boolean;
  numCtx?: number;
}): Promise<string> {
  if (params.provider === 'ollama') {
    return generateOllamaOnWorker(OLLAMA_LOCAL_BASE_URL, params);
  }
  if (params.provider === 'openai-compatible') {
    return generateOpenAiCompatibleOnWorker(LMSTUDIO_LOCAL_BASE_URL, params);
  }
  throw new Error(`Unsupported provider: ${params.provider}`);
}

export async function handleAudioTranscribe(params: AudioTranscribeParams): Promise<string> {
  if (params.provider !== 'openai-compatible') {
    throw new Error(`Unsupported audio transcription provider: ${params.provider}`);
  }

  const baseUrl = normalizeWorkerLocalBaseUrl(params.baseUrl);
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const body = new FormData();
    body.append('file', new Blob([Buffer.from(params.audioBase64, 'base64')], {
      type: 'audio/wav',
    }), 'segment.wav');
    body.append('model', params.model);
    body.append('language', params.language);
    body.append('task', params.task);
    body.append('response_format', 'json');

    const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`audio.transcribe failed: ${response.status}`);
    }
    const data = await response.json() as { text?: unknown };
    if (typeof data.text !== 'string') {
      throw new Error('audio.transcribe response missing text');
    }
    return data.text;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`audio.transcribe timed out after ${params.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(tid);
  }
}


function normalizeWorkerLocalBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('audio.transcribe baseUrl must be worker-local loopback.');
  }
  return url.toString().replace(/\/+$/, '');
}
