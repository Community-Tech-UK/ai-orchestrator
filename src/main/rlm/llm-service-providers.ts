/**
 * Frontier LLM provider generate + stream helpers.
 *
 * Extracted from `llm-service.ts` so the service stays inside its LOC
 * ceiling. Callers pass config and availability flags; this module does
 * not own service state. Behaviour matches the previous private methods.
 */

import { CLAUDE_MODELS, OPENAI_MODELS } from '../../shared/types/provider.types';
import { sanitizeProviderText } from '../security/surrogate-sanitizer';
import {
  runCorrelatedPaidFrontierCall,
} from '../local-ai-guard/local-ai-cost-correlation';
import { recordCorrelatedFrontierAttribution } from './frontier-cost-attribution';
import type { LLMServiceConfig, StreamChunk } from './llm-service.types';

export interface LlmProviderAvailability {
  anthropicAvailable: boolean | null;
  ollamaAvailable: boolean | null;
  openaiAvailable: boolean | null;
}

export async function* streamWithAnthropic(
  config: LLMServiceConfig,
  availability: LlmProviderAvailability,
  systemPrompt: string,
  userPrompt: string,
  requestId: string,
  signal: AbortSignal,
): AsyncGenerator<StreamChunk, void, unknown> {
  const apiKey = config.anthropicApiKey;
  if (!apiKey) {
    throw new Error('Anthropic API key not configured');
  }

  const model = config.model || CLAUDE_MODELS.HAIKU;
  const safePrompts = sanitizeProviderText({ systemPrompt, userPrompt });

  const response = await runCorrelatedPaidFrontierCall(() =>
    fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: config.maxTokens || 4096,
        temperature: config.temperature || 0.3,
        system: safePrompts.systemPrompt,
        messages: [{ role: 'user', content: safePrompts.userPrompt }],
        stream: true,
      }),
      signal,
    }),
  );

  if (!response.ok) {
    throw new Error(`Anthropic error: ${response.status} ${response.statusText}`);
  }

  availability.anthropicAvailable = true;

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            yield { requestId, chunk: '', done: true };
            return;
          }

          try {
            const parsed = JSON.parse(data) as {
              type: string;
              delta?: { type: string; text?: string };
            };

            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              yield { requestId, chunk: parsed.delta.text, done: false };
            } else if (parsed.type === 'message_stop') {
              yield { requestId, chunk: '', done: true };
              return;
            }
          } catch {
            /* intentionally ignored: malformed JSON lines are skipped during streaming parse */
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { requestId, chunk: '', done: true };
}

export async function* streamWithOllama(
  config: LLMServiceConfig,
  availability: LlmProviderAvailability,
  systemPrompt: string,
  userPrompt: string,
  requestId: string,
  signal: AbortSignal,
): AsyncGenerator<StreamChunk, void, unknown> {
  const host = config.ollamaHost || 'http://localhost:11434';
  const model = config.model || 'llama3';
  const safePrompts = sanitizeProviderText({ systemPrompt, userPrompt });

  const response = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: `${safePrompts.systemPrompt}\n\nUser: ${safePrompts.userPrompt}`,
      stream: true,
      options: {
        temperature: config.temperature || 0.3,
        num_predict: config.maxTokens || 4096,
      },
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
  }

  availability.ollamaAvailable = true;

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line) as { response: string; done: boolean };
            yield {
              requestId,
              chunk: parsed.response || '',
              done: parsed.done,
            };

            if (parsed.done) {
              return;
            }
          } catch {
            /* intentionally ignored: malformed JSON lines are skipped during streaming parse */
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { requestId, chunk: '', done: true };
}

export async function* streamWithOpenAI(
  config: LLMServiceConfig,
  availability: LlmProviderAvailability,
  systemPrompt: string,
  userPrompt: string,
  requestId: string,
  signal: AbortSignal,
): AsyncGenerator<StreamChunk, void, unknown> {
  if (!config.openaiApiKey) {
    throw new Error('OpenAI API key not configured');
  }

  const model = config.model || OPENAI_MODELS.GPT55_MINI;
  const safePrompts = sanitizeProviderText({ systemPrompt, userPrompt });

  const response = await runCorrelatedPaidFrontierCall(() =>
    fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: config.maxTokens || 4096,
        temperature: config.temperature || 0.3,
        messages: [
          { role: 'system', content: safePrompts.systemPrompt },
          { role: 'user', content: safePrompts.userPrompt },
        ],
        stream: true,
      }),
      signal,
    }),
  );

  if (!response.ok) {
    throw new Error(`OpenAI error: ${response.status} ${response.statusText}`);
  }

  availability.openaiAvailable = true;

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            yield { requestId, chunk: '', done: true };
            return;
          }

          try {
            const parsed = JSON.parse(data) as {
              choices: { delta: { content?: string }; finish_reason?: string }[];
            };

            const choice = parsed.choices[0];
            if (choice?.delta?.content) {
              yield { requestId, chunk: choice.delta.content, done: false };
            }

            if (choice?.finish_reason === 'stop') {
              yield { requestId, chunk: '', done: true };
              return;
            }
          } catch {
            /* intentionally ignored: malformed JSON lines are skipped during streaming parse */
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { requestId, chunk: '', done: true };
}

export async function generateWithAnthropic(
  config: LLMServiceConfig,
  availability: LlmProviderAvailability,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const apiKey = config.anthropicApiKey;
  if (!apiKey) {
    throw new Error('Anthropic API key not configured');
  }

  const model = config.model || CLAUDE_MODELS.HAIKU;
  const safePrompts = sanitizeProviderText({ systemPrompt, userPrompt });

  const response = await runCorrelatedPaidFrontierCall(() =>
    fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: config.maxTokens || 4096,
        temperature: config.temperature || 0.3,
        system: safePrompts.systemPrompt,
        messages: [{ role: 'user', content: safePrompts.userPrompt }],
      }),
    }),
  );

  if (!response.ok) {
    throw new Error(`Anthropic error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    content: { type: string; text: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  availability.anthropicAvailable = true;
  const output = data.content[0]?.text || '';
  recordCorrelatedFrontierAttribution({
    taskType: 'local-ai-frontier-fallback',
    provider: 'anthropic',
    model,
    inputTexts: [systemPrompt, userPrompt],
    outputText: output,
    usage: {
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
    },
  });
  return output;
}

export async function generateWithOllama(
  config: LLMServiceConfig,
  availability: LlmProviderAvailability,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const host = config.ollamaHost || 'http://localhost:11434';
  const model = config.model || 'llama3';
  const safePrompts = sanitizeProviderText({ systemPrompt, userPrompt });

  const response = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: `${safePrompts.systemPrompt}\n\nUser: ${safePrompts.userPrompt}`,
      stream: false,
      options: {
        temperature: config.temperature || 0.3,
        num_predict: config.maxTokens || 4096,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { response: string };
  availability.ollamaAvailable = true;
  return data.response || '';
}

export async function generateWithOpenAI(
  config: LLMServiceConfig,
  availability: LlmProviderAvailability,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  if (!config.openaiApiKey) {
    throw new Error('OpenAI API key not configured');
  }

  const model = config.model || OPENAI_MODELS.GPT55_MINI;
  const safePrompts = sanitizeProviderText({ systemPrompt, userPrompt });

  const response = await runCorrelatedPaidFrontierCall(() =>
    fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: config.maxTokens || 4096,
        temperature: config.temperature || 0.3,
        messages: [
          { role: 'system', content: safePrompts.systemPrompt },
          { role: 'user', content: safePrompts.userPrompt },
        ],
      }),
    }),
  );

  if (!response.ok) {
    throw new Error(`OpenAI error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  availability.openaiAvailable = true;
  const output = data.choices[0]?.message?.content || '';
  recordCorrelatedFrontierAttribution({
    taskType: 'local-ai-frontier-fallback',
    provider: 'openai',
    model,
    inputTexts: [systemPrompt, userPrompt],
    outputText: output,
    usage: {
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
    },
  });
  return output;
}
