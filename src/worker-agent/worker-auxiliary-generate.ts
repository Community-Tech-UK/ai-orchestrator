/**
 * Worker-local OpenAI-compatible (LM Studio) generation.
 *
 * Kept in its own module with NO electron-tainted imports so it can be unit
 * tested in isolation (see worker electron-import-isolation rule) and reused by
 * the worker RPC dispatcher.
 */

import { extractChatCompletionText, suppressReasoning } from '../shared/utils/openai-response';

export interface WorkerOpenAiGenerateParams {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  requireJson: boolean;
}

/**
 * Run an OpenAI-compatible chat completion against a worker-local server (LM
 * Studio). baseUrl-parameterised so it can be unit-tested with a mocked fetch.
 * Two resilience behaviours:
 *   1. If the server 400s specifically on `response_format` (newer LM Studio
 *      builds only accept 'json_schema'/'text'), retry once without it.
 *   2. Empty / whitespace-only content (a reasoning model exhausting its token
 *      budget on hidden reasoning) is surfaced as an error via
 *      extractChatCompletionText, so the auxiliary router falls back cleanly
 *      with a logged reason rather than returning a silent empty string.
 */
export async function generateOpenAiCompatibleOnWorker(
  baseUrl: string,
  params: WorkerOpenAiGenerateParams,
): Promise<string> {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    // NOTE: numCtx is deliberately absent. Unlike Ollama (`num_ctx`), an
    // OpenAI-compatible server like LM Studio has no per-request context override
    // — it serves at the model's *loaded* context length. Sending an over-long
    // prompt overflows that and the server returns a 400 (n_ctx), surfaced as an
    // error here. The lever is loading the model with a larger context, not this
    // request.
    const buildBody = (includeJsonFormat: boolean): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model: params.model,
        messages: [
          { role: 'system', content: suppressReasoning(params.systemPrompt) },
          { role: 'user', content: params.userPrompt },
        ],
        temperature: params.temperature,
        max_tokens: params.maxOutputTokens,
        stream: false,
      };
      if (includeJsonFormat) {
        body['response_format'] = { type: 'json_object' };
      }
      return body;
    };

    const post = (body: Record<string, unknown>) =>
      fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

    let resp = await post(buildBody(params.requireJson));

    // Retry once without response_format if that is specifically what the 400
    // is about (newer LM Studio rejects the OpenAI-standard json_object value).
    if (!resp.ok && resp.status === 400 && params.requireJson) {
      const errText = await resp.text().catch(() => '');
      if (errText.includes('response_format')) {
        resp = await post(buildBody(false));
      } else {
        throw new Error(`OpenAI-compatible generate failed: ${resp.status} ${errText}`.trim());
      }
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`OpenAI-compatible generate failed: ${resp.status} ${errText}`.trim());
    }
    return extractChatCompletionText(await resp.json());
  } finally {
    clearTimeout(tid);
  }
}
