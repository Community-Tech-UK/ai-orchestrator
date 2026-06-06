/**
 * Auxiliary Model Client
 *
 * Low-level REST client for Ollama and OpenAI-compatible endpoints.
 * Used by AuxiliaryLlmService to dispatch helper calls to local/cheap models.
 */

import type { AuxiliaryLlmModelInfo } from '../../shared/types/auxiliary-llm.types';

export interface AuxiliaryGenerateRequest {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  requireJson: boolean;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Derive a short stable endpoint ID from a base URL string.
 * Collisions are extremely unlikely for the handful of endpoints a user
 * configures; this is purely an opaque identifier, not a security token.
 */
function endpointIdFromUrl(baseUrl: string): string {
  return Buffer.from(baseUrl).toString('base64').slice(0, 12);
}

/**
 * Build an AbortController that fires after `timeoutMs` milliseconds.
 * Returns the controller and a cleanup function that cancels the timer.
 */
function makeAbortController(timeoutMs: number): {
  controller: AbortController;
  clear: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const clear = () => clearTimeout(timer);
  return { controller, clear };
}

// ─── Ollama ──────────────────────────────────────────────────────────────────

/**
 * Check whether an Ollama endpoint is reachable by hitting `/api/version`.
 */
export async function probeOllamaEndpoint(
  baseUrl: string,
  timeoutMs: number
): Promise<boolean> {
  const { controller, clear } = makeAbortController(timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/api/version`, { signal: controller.signal });
    clear();
    return response.ok;
  } catch {
    clear();
    return false;
  }
}

/**
 * List models available from an Ollama endpoint via `/api/tags`.
 */
export async function listOllamaModels(
  baseUrl: string,
  timeoutMs: number
): Promise<AuxiliaryLlmModelInfo[]> {
  const { controller, clear } = makeAbortController(timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    clear();
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as {
      models?: Array<{
        name: string;
        size?: number;
        parameter_size?: string;
        quantization_level?: string;
        modified_at?: string;
      }>;
    };

    const endpointId = endpointIdFromUrl(baseUrl);
    return (data.models ?? []).map((m) => ({
      id: m.name,
      name: m.name,
      provider: 'ollama' as const,
      endpointId,
      parameterSize: m.parameter_size,
      quantization: m.quantization_level,
      modifiedAt: m.modified_at,
    }));
  } catch {
    clear();
    return [];
  }
}

/**
 * Generate text using an Ollama endpoint via `/api/generate`.
 * Throws on timeout or HTTP error.
 */
export async function generateWithOllama(
  baseUrl: string,
  request: AuxiliaryGenerateRequest
): Promise<string> {
  const { controller, clear } = makeAbortController(request.timeoutMs);
  const body = {
    model: request.model,
    prompt: `${request.systemPrompt}\n\n${request.userPrompt}`,
    stream: false,
    ...(request.requireJson ? { format: 'json' } : {}),
    options: {
      temperature: request.temperature,
      num_predict: request.maxOutputTokens,
    },
  };

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clear();
    const isAbort =
      err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'));
    if (isAbort) {
      throw new Error(`Auxiliary model timed out: Ollama at ${baseUrl}`);
    }
    throw err;
  }

  clear();

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Ollama generate failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { response?: string };
  return data.response ?? '';
}

// ─── OpenAI-compatible ───────────────────────────────────────────────────────

function openAiHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Check whether an OpenAI-compatible endpoint is reachable via `GET /v1/models`.
 */
export async function probeOpenAiCompatibleEndpoint(
  baseUrl: string,
  apiKey: string | undefined,
  timeoutMs: number
): Promise<boolean> {
  const { controller, clear } = makeAbortController(timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: openAiHeaders(apiKey),
      signal: controller.signal,
    });
    clear();
    return response.ok;
  } catch {
    clear();
    return false;
  }
}

/**
 * List models available from an OpenAI-compatible endpoint via `GET /v1/models`.
 */
export async function listOpenAiCompatibleModels(
  baseUrl: string,
  apiKey: string | undefined,
  timeoutMs: number
): Promise<AuxiliaryLlmModelInfo[]> {
  const { controller, clear } = makeAbortController(timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: openAiHeaders(apiKey),
      signal: controller.signal,
    });
    clear();
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as {
      data?: Array<{ id: string; object?: string }>;
    };

    const endpointId = endpointIdFromUrl(baseUrl);
    return (data.data ?? []).map((m) => ({
      id: m.id,
      name: m.id,
      provider: 'openai-compatible' as const,
      endpointId,
    }));
  } catch {
    clear();
    return [];
  }
}

/**
 * Generate text using an OpenAI-compatible endpoint via `POST /v1/chat/completions`.
 * Throws on timeout or HTTP error.
 */
export async function generateWithOpenAiCompatible(
  baseUrl: string,
  apiKey: string | undefined,
  request: AuxiliaryGenerateRequest
): Promise<string> {
  const { controller, clear } = makeAbortController(request.timeoutMs);
  const body: Record<string, unknown> = {
    model: request.model,
    messages: [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userPrompt },
    ],
    temperature: request.temperature,
    max_tokens: request.maxOutputTokens,
  };
  if (request.requireJson) {
    body['response_format'] = { type: 'json_object' };
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: openAiHeaders(apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clear();
    const isAbort =
      err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'));
    if (isAbort) {
      throw new Error(`Auxiliary model timed out: OpenAI-compatible at ${baseUrl}`);
    }
    throw err;
  }

  clear();

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI-compatible generate failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? '';
}
