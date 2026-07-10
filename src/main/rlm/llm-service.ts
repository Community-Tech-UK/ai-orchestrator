/**
 * LLM Service for RLM
 * Provides summarization and sub-query capabilities
 *
 * Uses lightweight API calls rather than spawning CLI processes
 * for faster response times on quick tasks.
 *
 * Supports both streaming and non-streaming modes for real-time output.
 */

import { EventEmitter } from 'events';
import { getTokenCounter, TokenCounter } from './token-counter';
import { CLAUDE_MODELS, OPENAI_MODELS } from '../../shared/types/provider.types';
import { getCircuitBreakerRegistry } from '../core/circuit-breaker';
import { getLogger } from '../logging/logger';
import type {
  LLMServiceConfig,
  SummarizeRequest,
  SummarizeResponse,
  SubQueryRequest,
  SubQueryResponse,
  StreamChunk,
  StreamCallback,
} from './llm-service.types';
import {
  DEFAULT_CONFIG,
  SUMMARIZE_SYSTEM_PROMPT,
  SUBQUERY_SYSTEM_PROMPT,
  LLM_UNAVAILABLE_TEXT,
} from './llm-service.constants';
import { getAuxiliaryLlmService } from './auxiliary-llm-service';
import type { AuxiliaryLlmSlot } from '../../shared/types/auxiliary-llm.types';
import { sanitizeProviderText } from '../security/surrogate-sanitizer';

// Re-export public API so existing importers are unaffected.
export type {
  LLMServiceConfig,
  SummarizeRequest,
  SummarizeResponse,
  SubQueryRequest,
  SubQueryResponse,
  StreamChunk,
  StreamCallback,
};

const logger = getLogger('LLMService');

export class LLMService extends EventEmitter {
  private static instance: LLMService | null = null;
  private config: LLMServiceConfig;
  private anthropicAvailable: boolean | null = null;
  private ollamaAvailable: boolean | null = null;
  private openaiAvailable: boolean | null = null;
  private tokenCounter: TokenCounter;
  private activeStreams = new Map<string, AbortController>();

  private constructor(config: Partial<LLMServiceConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tokenCounter = getTokenCounter();
    this.tokenCounter.setDefaultModel(this.config.model);
    void this.checkOllamaHealth();
  }

  static getInstance(config?: Partial<LLMServiceConfig>): LLMService {
    if (!this.instance) {
      this.instance = new LLMService(config);
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  configure(config: Partial<LLMServiceConfig>): void {
    this.config = { ...this.config, ...config };
    // Reset availability checks when config changes
    if (config.anthropicApiKey !== undefined) this.anthropicAvailable = null;
    if (config.openaiApiKey !== undefined) this.openaiAvailable = null;
    if (config.ollamaHost !== undefined) {
      this.ollamaAvailable = null;
      void this.checkOllamaHealth();
    }
    // Update token counter model
    if (config.model) {
      this.tokenCounter.setDefaultModel(config.model);
    }
  }

  getConfig(): LLMServiceConfig {
    return { ...this.config };
  }

  /**
   * Get the token counter instance for external use
   */
  getTokenCounter(): TokenCounter {
    return this.tokenCounter;
  }

  /**
   * Count tokens in text using the configured model
   */
  countTokens(text: string): number {
    return this.tokenCounter.countTokens(text, this.config.model);
  }

  /**
   * Truncate text to fit within a token limit
   */
  truncateToTokens(text: string, maxTokens: number): string {
    return this.tokenCounter.truncateToTokens(text, maxTokens, this.config.model);
  }

  /**
   * Summarize content to target token count
   */
  async summarize(request: SummarizeRequest): Promise<string> {
    const userPrompt = `Please summarize the following content to approximately ${request.targetTokens} tokens:

${request.content}

Summary:`;

    // Try auxiliary LLM first (local/cheap model) before calling the primary LLM.
    try {
      const { text: auxText, decision: auxDecision } = await getAuxiliaryLlmService().generate(
        'compression',
        SUMMARIZE_SYSTEM_PROMPT,
        userPrompt
      );
      if (auxDecision.source !== 'fallback' && auxText.trim()) {
        const originalTokens = this.countTokens(request.content);
        const summaryTokens = this.countTokens(auxText);
        this.emit('summarize:complete', {
          requestId: request.requestId,
          summary: auxText,
          originalTokens,
          summaryTokens,
        } as SummarizeResponse);
        return auxText;
      }
      if (!auxDecision.allowFrontierFallback) {
        // Frontier fallback disabled for the compression slot — return the
        // deterministic local summary instead of calling the primary (cloud) LLM.
        const summary = this.fallbackSummarize(request.content, request.targetTokens);
        this.emit('summarize:complete', {
          requestId: request.requestId,
          summary,
          originalTokens: this.countTokens(request.content),
          summaryTokens: this.countTokens(summary),
        } as SummarizeResponse);
        return summary;
      }
    } catch {
      // Auxiliary service unavailable in this context — fall through to primary LLM
    }

    try {
      const summary = await this.generateCompletion(SUMMARIZE_SYSTEM_PROMPT, userPrompt);
      const originalTokens = this.countTokens(request.content);
      const summaryTokens = this.countTokens(summary);

      this.emit('summarize:complete', {
        requestId: request.requestId,
        summary,
        originalTokens,
        summaryTokens,
      } as SummarizeResponse);

      return summary;
    } catch (error) {
      this.emit('summarize:error', {
        requestId: request.requestId,
        error: (error as Error).message,
      });

      // Return fallback summary
      return this.fallbackSummarize(request.content, request.targetTokens);
    }
  }

  /**
   * Summarize content with streaming output
   * Yields chunks as they are received from the LLM
   */
  async *summarizeStreaming(
    request: SummarizeRequest
  ): AsyncGenerator<StreamChunk, string, unknown> {
    const userPrompt = `Please summarize the following content to approximately ${request.targetTokens} tokens:

${request.content}

Summary:`;

    let fullResponse = '';
    const originalTokens = this.countTokens(request.content);

    try {
      for await (const chunk of this.generateCompletionStreaming(
        SUMMARIZE_SYSTEM_PROMPT,
        userPrompt,
        request.requestId
      )) {
        fullResponse += chunk.chunk;

        yield chunk;

        if (chunk.done) {
          const summaryTokens = this.countTokens(fullResponse);
          this.emit('summarize:complete', {
            requestId: request.requestId,
            summary: fullResponse,
            originalTokens,
            summaryTokens,
          } as SummarizeResponse);
        }
      }
    } catch (error) {
      const errorChunk: StreamChunk = {
        requestId: request.requestId,
        chunk: '',
        done: true,
        error: (error as Error).message,
      };
      yield errorChunk;

      this.emit('summarize:error', {
        requestId: request.requestId,
        error: (error as Error).message,
      });

      // Return fallback summary
      fullResponse = this.fallbackSummarize(request.content, request.targetTokens);
    }

    return fullResponse;
  }

  /**
   * Execute a sub-query against context
   */
  async subQuery(request: SubQueryRequest): Promise<string> {
    const userPrompt = `Context:
${request.context}

Question: ${request.prompt}

Answer:`;

    try {
      const response = await this.generateCompletion(SUBQUERY_SYSTEM_PROMPT, userPrompt);
      const inputTokens = this.countTokens(request.context + request.prompt);
      const outputTokens = this.countTokens(response);

      this.emit('sub_query:complete', {
        requestId: request.requestId,
        response,
        depth: request.depth,
        tokens: {
          input: inputTokens,
          output: outputTokens,
        },
      } as SubQueryResponse);

      return response;
    } catch (error) {
      this.emit('sub_query:error', {
        requestId: request.requestId,
        error: (error as Error).message,
      });

      return `Unable to process sub-query: ${(error as Error).message}`;
    }
  }

  /** Run a provider completion with caller-supplied system and user prompts. */
  async generate(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.generateCompletion(systemPrompt, userPrompt);
  }

  /**
   * Execute a sub-query, routing grunt-work through the auxiliary LLM service
   * first (local/remote-GPU model) before the frontier cloud ladder.
   *
   * Control flow mirrors the A3 auxiliary pattern (see `summarize()`):
   *  1. Aux produced a real result (`source !== 'fallback'` and non-empty) → use it.
   *  2. Aux fell back but the slot allows frontier escalation → run the preserved
   *     `subQuery()` path (today's cloud/localhost ladder + its own fallback).
   *  3. Aux fell back and frontier escalation is disallowed → return the
   *     deterministic local-unavailable sentinel. Callers that JSON-parse the
   *     result (branch/loop scoring) degrade to their neutral value naturally.
   *
   * `subQuery()` itself is left untouched so excluded callers (answer-agent,
   * hook-executor, the renderer IPC pass-through) keep their current behavior.
   */
  async subQueryViaAux(slot: AuxiliaryLlmSlot, request: SubQueryRequest): Promise<string> {
    const userPrompt = `Context:
${request.context}

Question: ${request.prompt}

Answer:`;

    try {
      const { text, decision } = await getAuxiliaryLlmService().generate(
        slot,
        SUBQUERY_SYSTEM_PROMPT,
        userPrompt
      );

      if (decision.source !== 'fallback' && text.trim()) {
        this.emit('sub_query:complete', {
          requestId: request.requestId,
          response: text,
          depth: request.depth,
          tokens: {
            input: this.countTokens(request.context + request.prompt),
            output: this.countTokens(text),
          },
        } as SubQueryResponse);
        return text;
      }

      if (decision.allowFrontierFallback) {
        // Preserve today's behavior: cloud/localhost ladder + subQuery's fallback.
        return this.subQuery(request);
      }

      // Frontier escalation disallowed for this slot — deterministic local result.
      // Emit a completion for parity with subQuery() and the real-aux path above,
      // so event consumers (telemetry/UI) still see a terminal sub_query:complete.
      this.emit('sub_query:complete', {
        requestId: request.requestId,
        response: LLM_UNAVAILABLE_TEXT,
        depth: request.depth,
        tokens: {
          input: this.countTokens(request.context + request.prompt),
          output: this.countTokens(LLM_UNAVAILABLE_TEXT),
        },
      } as SubQueryResponse);
      return LLM_UNAVAILABLE_TEXT;
    } catch (error) {
      // Auxiliary service unavailable in this context — preserve old behavior.
      logger.debug('Auxiliary subQuery failed; falling back to frontier subQuery', {
        slot,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.subQuery(request);
    }
  }

  /**
   * Execute a sub-query with streaming output
   * Yields chunks as they are received from the LLM
   */
  async *subQueryStreaming(
    request: SubQueryRequest
  ): AsyncGenerator<StreamChunk, string, unknown> {
    const userPrompt = `Context:
${request.context}

Question: ${request.prompt}

Answer:`;

    let fullResponse = '';
    const inputTokens = this.countTokens(request.context + request.prompt);

    try {
      for await (const chunk of this.generateCompletionStreaming(
        SUBQUERY_SYSTEM_PROMPT,
        userPrompt,
        request.requestId
      )) {
        fullResponse += chunk.chunk;

        yield chunk;

        if (chunk.done) {
          const outputTokens = this.countTokens(fullResponse);
          this.emit('sub_query:complete', {
            requestId: request.requestId,
            response: fullResponse,
            depth: request.depth,
            tokens: {
              input: inputTokens,
              output: outputTokens,
            },
          } as SubQueryResponse);
        }
      }
    } catch (error) {
      const errorChunk: StreamChunk = {
        requestId: request.requestId,
        chunk: '',
        done: true,
        error: (error as Error).message,
      };
      yield errorChunk;

      this.emit('sub_query:error', {
        requestId: request.requestId,
        error: (error as Error).message,
      });

      fullResponse = `Unable to process sub-query: ${(error as Error).message}`;
    }

    return fullResponse;
  }

  /**
   * Cancel an active streaming request
   */
  cancelStream(requestId: string): boolean {
    const controller = this.activeStreams.get(requestId);
    if (controller) {
      controller.abort();
      this.activeStreams.delete(requestId);
      return true;
    }
    return false;
  }

  /**
   * Generate a completion using the configured provider.
   * Each provider call is guarded by a circuit breaker to fail fast
   * when a provider is known to be unhealthy.
   */
  private async generateCompletion(systemPrompt: string, userPrompt: string): Promise<string> {
    const registry = getCircuitBreakerRegistry();

    // Try providers in order of preference based on config
    if (this.config.provider === 'anthropic' || this.config.anthropicApiKey) {
      const breaker = registry.getBreaker('llm-anthropic');
      if (!breaker.isAllowed()) {
        logger.warn('Circuit breaker open for anthropic LLM provider, skipping');
      } else {
        const startTime = Date.now();
        try {
          const result = await this.generateWithAnthropic(systemPrompt, userPrompt);
          breaker.recordSuccess(Date.now() - startTime);
          return result;
        } catch (error) {
          breaker.recordFailure(error as Error, Date.now() - startTime);
          this.anthropicAvailable = false;
          this.emit('provider:error', { provider: 'anthropic', error });
        }
      }
    }

    if (this.config.provider === 'ollama' || this.ollamaAvailable !== false) {
      const breaker = registry.getBreaker('llm-ollama');
      if (!breaker.isAllowed()) {
        logger.warn('Circuit breaker open for ollama LLM provider, skipping');
      } else {
        const startTime = Date.now();
        try {
          const result = await this.generateWithOllama(systemPrompt, userPrompt);
          breaker.recordSuccess(Date.now() - startTime);
          return result;
        } catch (error) {
          breaker.recordFailure(error as Error, Date.now() - startTime);
          this.ollamaAvailable = false;
          this.emit('provider:error', { provider: 'ollama', error });
        }
      }
    }

    if (this.config.provider === 'openai' || this.config.openaiApiKey) {
      const breaker = registry.getBreaker('llm-openai');
      if (!breaker.isAllowed()) {
        logger.warn('Circuit breaker open for openai LLM provider, skipping');
      } else {
        const startTime = Date.now();
        try {
          const result = await this.generateWithOpenAI(systemPrompt, userPrompt);
          breaker.recordSuccess(Date.now() - startTime);
          return result;
        } catch (error) {
          breaker.recordFailure(error as Error, Date.now() - startTime);
          this.openaiAvailable = false;
          this.emit('provider:error', { provider: 'openai', error });
        }
      }
    }

    // Fall back to local extraction
    return this.generateLocal(userPrompt);
  }

  /**
   * Generate a completion with streaming using the configured provider.
   * Each provider is guarded by a circuit breaker. If the circuit is open
   * for a provider, that provider is skipped immediately without a network call.
   * Timing is tracked across the full stream so the breaker reflects real-world latency.
   */
  private async *generateCompletionStreaming(
    systemPrompt: string,
    userPrompt: string,
    requestId: string
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const controller = new AbortController();
    const registry = getCircuitBreakerRegistry();
    this.activeStreams.set(requestId, controller);

    try {
      // Try providers in order of preference based on config
      if (this.config.provider === 'anthropic' || this.config.anthropicApiKey) {
        const breaker = registry.getBreaker('llm-anthropic');
        if (!breaker.isAllowed()) {
          logger.warn('Circuit breaker open for anthropic LLM provider (streaming), skipping');
        } else {
          const startTime = Date.now();
          try {
            yield* this.streamWithAnthropic(systemPrompt, userPrompt, requestId, controller.signal);
            breaker.recordSuccess(Date.now() - startTime);
            return;
          } catch (error) {
            if ((error as Error).name === 'AbortError') throw error;
            breaker.recordFailure(error as Error, Date.now() - startTime);
            this.anthropicAvailable = false;
            this.emit('provider:error', { provider: 'anthropic', error });
          }
        }
      }

      if (this.config.provider === 'ollama' || this.ollamaAvailable !== false) {
        const breaker = registry.getBreaker('llm-ollama');
        if (!breaker.isAllowed()) {
          logger.warn('Circuit breaker open for ollama LLM provider (streaming), skipping');
        } else {
          const startTime = Date.now();
          try {
            yield* this.streamWithOllama(systemPrompt, userPrompt, requestId, controller.signal);
            breaker.recordSuccess(Date.now() - startTime);
            return;
          } catch (error) {
            if ((error as Error).name === 'AbortError') throw error;
            breaker.recordFailure(error as Error, Date.now() - startTime);
            this.ollamaAvailable = false;
            this.emit('provider:error', { provider: 'ollama', error });
          }
        }
      }

      if (this.config.provider === 'openai' || this.config.openaiApiKey) {
        const breaker = registry.getBreaker('llm-openai');
        if (!breaker.isAllowed()) {
          logger.warn('Circuit breaker open for openai LLM provider (streaming), skipping');
        } else {
          const startTime = Date.now();
          try {
            yield* this.streamWithOpenAI(systemPrompt, userPrompt, requestId, controller.signal);
            breaker.recordSuccess(Date.now() - startTime);
            return;
          } catch (error) {
            if ((error as Error).name === 'AbortError') throw error;
            breaker.recordFailure(error as Error, Date.now() - startTime);
            this.openaiAvailable = false;
            this.emit('provider:error', { provider: 'openai', error });
          }
        }
      }

      // Fall back to local (non-streaming, emitted as single chunk)
      const response = this.generateLocal(userPrompt);
      yield { requestId, chunk: response, done: true };
    } finally {
      this.activeStreams.delete(requestId);
    }
  }

  /**
   * Stream completion from Anthropic API
   */
  private async *streamWithAnthropic(
    systemPrompt: string,
    userPrompt: string,
    requestId: string,
    signal: AbortSignal
  ): AsyncGenerator<StreamChunk, void, unknown> {
    if (!this.config.anthropicApiKey) {
      throw new Error('Anthropic API key not configured');
    }

    const model = this.config.model || CLAUDE_MODELS.HAIKU;
    const safePrompts = sanitizeProviderText({ systemPrompt, userPrompt });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: this.config.maxTokens || 4096,
        temperature: this.config.temperature || 0.3,
        system: safePrompts.systemPrompt,
        messages: [{ role: 'user', content: safePrompts.userPrompt }],
        stream: true,
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Anthropic error: ${response.status} ${response.statusText}`);
    }

    this.anthropicAvailable = true;

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

  /**
   * Stream completion from Ollama
   */
  private async *streamWithOllama(
    systemPrompt: string,
    userPrompt: string,
    requestId: string,
    signal: AbortSignal
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const host = this.config.ollamaHost || 'http://localhost:11434';
    const model = this.config.model || 'llama3';
    const safePrompts = sanitizeProviderText({ systemPrompt, userPrompt });

    const response = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: `${safePrompts.systemPrompt}\n\nUser: ${safePrompts.userPrompt}`,
        stream: true,
        options: {
          temperature: this.config.temperature || 0.3,
          num_predict: this.config.maxTokens || 4096,
        },
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
    }

    this.ollamaAvailable = true;

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

  /**
   * Stream completion from OpenAI API
   */
  private async *streamWithOpenAI(
    systemPrompt: string,
    userPrompt: string,
    requestId: string,
    signal: AbortSignal
  ): AsyncGenerator<StreamChunk, void, unknown> {
    if (!this.config.openaiApiKey) {
      throw new Error('OpenAI API key not configured');
    }

    const model = this.config.model || OPENAI_MODELS.GPT55_MINI;
    const safePrompts = sanitizeProviderText({ systemPrompt, userPrompt });

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.openaiApiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: this.config.maxTokens || 4096,
        temperature: this.config.temperature || 0.3,
        messages: [
          { role: 'system', content: safePrompts.systemPrompt },
          { role: 'user', content: safePrompts.userPrompt },
        ],
        stream: true,
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`OpenAI error: ${response.status} ${response.statusText}`);
    }

    this.openaiAvailable = true;

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

  /**
   * Generate completion using Anthropic API (non-streaming)
   */
  private async generateWithAnthropic(systemPrompt: string, userPrompt: string): Promise<string> {
    if (!this.config.anthropicApiKey) {
      throw new Error('Anthropic API key not configured');
    }

    const model = this.config.model || CLAUDE_MODELS.HAIKU; // Use Haiku for speed
    const safePrompts = sanitizeProviderText({ systemPrompt, userPrompt });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: this.config.maxTokens || 4096,
        temperature: this.config.temperature || 0.3,
        system: safePrompts.systemPrompt,
        messages: [{ role: 'user', content: safePrompts.userPrompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      content: { type: string; text: string }[];
    };

    this.anthropicAvailable = true;
    return data.content[0]?.text || '';
  }

  /**
   * Generate completion using Ollama
   */
  private async generateWithOllama(systemPrompt: string, userPrompt: string): Promise<string> {
    const host = this.config.ollamaHost || 'http://localhost:11434';
    const model = this.config.model || 'llama3';
    const safePrompts = sanitizeProviderText({ systemPrompt, userPrompt });

    const response = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: `${safePrompts.systemPrompt}\n\nUser: ${safePrompts.userPrompt}`,
        stream: false,
        options: {
          temperature: this.config.temperature || 0.3,
          num_predict: this.config.maxTokens || 4096,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { response: string };
    this.ollamaAvailable = true;
    return data.response || '';
  }

  /**
   * Generate completion using OpenAI API
   */
  private async generateWithOpenAI(systemPrompt: string, userPrompt: string): Promise<string> {
    if (!this.config.openaiApiKey) {
      throw new Error('OpenAI API key not configured');
    }

    const model = this.config.model || OPENAI_MODELS.GPT55_MINI; // Use mini for speed
    const safePrompts = sanitizeProviderText({ systemPrompt, userPrompt });

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.openaiApiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: this.config.maxTokens || 4096,
        temperature: this.config.temperature || 0.3,
        messages: [
          { role: 'system', content: safePrompts.systemPrompt },
          { role: 'user', content: safePrompts.userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      choices: { message: { content: string } }[];
    };

    this.openaiAvailable = true;
    return data.choices[0]?.message?.content || '';
  }

  /**
   * Local extraction without LLM (fallback)
   */
  private generateLocal(prompt: string): string {
    // For summarization, extract key content
    // For sub-queries, return a message that LLM is unavailable
    if (prompt.includes('summarize')) {
      const content = prompt.split('Summary:')[0];
      const targetMatch = prompt.match(/approximately (\d+) tokens/);
      const targetTokens = targetMatch ? parseInt(targetMatch[1]) : 500;
      return this.fallbackSummarize(content, targetTokens);
    }

    return LLM_UNAVAILABLE_TEXT;
  }

  /**
   * Fallback summarization without LLM
   */
  private fallbackSummarize(content: string, targetTokens: number): string {
    const targetChars = targetTokens * 4;
    const lines = content.split('\n');

    // Extract key lines (headers, first sentences, etc.)
    const keyLines: string[] = [];
    let currentChars = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Prioritize headers and important patterns
      const isHeader = /^#+\s/.test(trimmed) || /^[A-Z][^.]*:/.test(trimmed);
      const isImportant = /^(NOTE|IMPORTANT|TODO|WARNING|CRITICAL)/i.test(trimmed);

      if (isHeader || isImportant || keyLines.length < 5) {
        if (currentChars + trimmed.length <= targetChars) {
          keyLines.push(trimmed);
          currentChars += trimmed.length;
        }
      }
    }

    // If we have room, add more content
    for (const line of lines) {
      if (currentChars >= targetChars) break;
      const trimmed = line.trim();
      if (!trimmed || keyLines.includes(trimmed)) continue;

      if (currentChars + trimmed.length <= targetChars) {
        keyLines.push(trimmed);
        currentChars += trimmed.length;
      }
    }

    return keyLines.join('\n');
  }

  /**
   * Check if LLM service is available
   */
  async isAvailable(): Promise<boolean> {
    // Check configured provider first
    if (this.config.provider === 'anthropic' && this.config.anthropicApiKey) {
      return true;
    }
    if (this.config.provider === 'openai' && this.config.openaiApiKey) {
      return true;
    }
    if (this.config.provider === 'ollama') {
      return await this.checkOllamaAvailability();
    }
    if (this.config.provider === 'local') {
      return true; // Local fallback is always available
    }

    // Check any available provider
    if (this.config.anthropicApiKey || this.config.openaiApiKey) {
      return true;
    }
    return await this.checkOllamaAvailability();
  }

  /**
   * Check if Ollama is available
   */
  async checkOllamaAvailability(): Promise<boolean> {
    return this.checkOllamaHealth();
  }

  async checkOllamaHealth(): Promise<boolean> {
    const ollamaHost = this.config.ollamaHost ?? 'http://localhost:11434';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetch(`${ollamaHost}/api/tags`, {
        method: 'GET',
        signal: controller.signal,
      });
      this.ollamaAvailable = response.ok;
      if (!response.ok) {
        logger.warn('Ollama health check returned non-200', { status: response.status });
      }
      return this.ollamaAvailable;
    } catch (error) {
      this.ollamaAvailable = false;
      logger.info('Ollama health check failed; will skip Ollama provider', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get provider status
   */
  getProviderStatus(): {
    anthropic: boolean | null;
    ollama: boolean | null;
    openai: boolean | null;
    local: boolean;
  } {
    return {
      anthropic: this.config.anthropicApiKey ? this.anthropicAvailable : null,
      ollama: this.ollamaAvailable,
      openai: this.config.openaiApiKey ? this.openaiAvailable : null,
      local: true, // Always available
    };
  }
}

export function getLLMService(config?: Partial<LLMServiceConfig>): LLMService {
  return LLMService.getInstance(config);
}
