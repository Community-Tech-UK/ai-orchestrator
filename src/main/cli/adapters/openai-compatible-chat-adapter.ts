import { TextDecoder } from 'node:util';
import {
  CliAdapterConfig,
  CliCapabilities,
  CliMessage,
  CliResponse,
  CliUsage,
} from './base-cli-adapter';
import {
  BaseLocalModelChatAdapter,
  type LocalModelChatMessage,
  type LocalModelToolCall,
  type LocalModelToolTurnClient,
  type LocalModelToolTurnMessage,
  type LocalModelToolTurnResult,
  LocalModelToolResponseError,
  normalizeLocalModelToolCall,
} from './local-model-chat-adapter';
import type { LocalReviewToolDefinition } from '../../review/local-review.types';
import { getLogger } from '../../logging/logger';
import type { CliSpawnMode, CliStatus } from './base-cli-adapter';
import {
  MAX_LOCAL_MODEL_JSON_RESPONSE_BYTES,
  openLocalModelResponseReader,
  readLocalModelErrorText,
  readLocalModelResponseText,
} from './local-model-http-response';
import { withLocalModelFetchResponse } from './local-model-fetch';

const logger = getLogger('OpenAICompatibleChatAdapter');

const DEFAULT_BASE_URL = 'http://127.0.0.1:1234';
const DEFAULT_MODEL = 'local-model';
const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_TEMPERATURE = 0.2;

interface OpenAICompatibleChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream: boolean;
  temperature: number;
  tools?: OpenAIToolDefinition[];
}

type OpenAIChatMessage =
  | LocalModelChatMessage
  | { role: 'assistant'; content: string; tool_calls: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIChatChoiceDelta {
  delta?: {
    content?: string;
  };
  message?: {
    role?: string;
    content?: unknown;
    tool_calls?: unknown;
  };
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAIChatCompletionResponse {
  choices?: OpenAIChatChoiceDelta[];
  usage?: OpenAIUsage;
}

interface OpenAIModelsResponse {
  data?: { id?: string }[];
}

export interface OpenAICompatibleChatConfig {
  /** Base OpenAI-compatible endpoint URL. Default is LM Studio's local server. */
  baseUrl?: string;
  /** Model name to use. */
  model?: string;
  /** Optional endpoint identity for diagnostics/future routing. */
  endpointId?: string;
  /** Optional bearer token for endpoints that require one. */
  apiKey?: string;
  /** System prompt to prepend at the start of each conversation. */
  systemPrompt?: string;
  /** Request timeout in milliseconds. Default: 300000 (5 min). */
  timeout?: number;
  /** Working directory (not used for HTTP, stored for compatibility). */
  workingDir?: string;
  /** Sampling temperature. Default: 0.2. */
  temperature?: number;
  /** Context window hint used for Harness context telemetry. */
  contextWindow?: number;
}

export class OpenAICompatibleChatAdapter extends BaseLocalModelChatAdapter implements LocalModelToolTurnClient {
  /** B9: OpenAI-compatible local models have no local process. */
  protected override spawnMode: CliSpawnMode = 'http';

  private readonly baseUrl: string;
  private readonly endpointId: string;
  private readonly apiKey?: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;

  constructor(config: OpenAICompatibleChatConfig = {}) {
    const model = config.model ?? DEFAULT_MODEL;
    const timeoutMs = config.timeout ?? 300_000;
    const adapterConfig: CliAdapterConfig = {
      command: 'openai-compatible-local-model',
      args: [],
      cwd: config.workingDir,
      timeout: timeoutMs,
      sessionPersistence: true,
    };
    super(adapterConfig, {
      endpointProvider: 'openai-compatible',
      model,
      systemPrompt: config.systemPrompt,
      contextWindow: config.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      sessionIdPrefix: 'openai-compatible-local',
      errorLabel: 'OpenAI-compatible local model',
    });

    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.endpointId = config.endpointId ?? 'openai-compatible';
    this.apiKey = config.apiKey;
    this.temperature = config.temperature ?? DEFAULT_TEMPERATURE;
    this.timeoutMs = timeoutMs;
  }

  getName(): string {
    return 'openai-compatible-local-model';
  }

  getCapabilities(): CliCapabilities {
    return {
      streaming: true,
      toolUse: false,
      fileAccess: false,
      shellExecution: false,
      multiTurn: true,
      vision: false,
      codeExecution: false,
      contextWindow: this.contextWindow,
      outputFormats: ['text', 'markdown'],
    };
  }

  async checkStatus(): Promise<CliStatus> {
    try {
      return await this.withResponse(this.url('/v1/models'), {
        method: 'GET',
        headers: this.headers({ acceptJson: true }),
      }, undefined, async (response, responseSignal) => {
        if (!response.ok) {
          const body = await readLocalModelErrorText(response, responseSignal);
          return {
            available: false,
            error: `OpenAI-compatible endpoint not reachable at ${this.baseUrl}: HTTP ${response.status}${body ? `: ${body}` : ''}`,
          };
        }
        const parsed = JSON.parse(await readLocalModelResponseText(
          response,
          MAX_LOCAL_MODEL_JSON_RESPONSE_BYTES,
          'OpenAI-compatible models response',
          responseSignal,
        )) as OpenAIModelsResponse;
        const models = (parsed.data ?? [])
          .map((model) => model.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        return {
          available: true,
          path: this.baseUrl,
          authenticated: true,
          metadata: { endpointId: this.endpointId, models },
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        available: false,
        error: `OpenAI-compatible endpoint not reachable at ${this.baseUrl}: ${message}`,
      };
    }
  }

  protected buildArgs(): string[] {
    return [];
  }

  parseOutput(raw: string): CliResponse {
    try {
      const parsed = JSON.parse(raw) as OpenAIChatCompletionResponse;
      const content = extractNonStreamingContent(parsed) || extractStreamingContent(parsed);
      return {
        id: this.generateResponseId(),
        content: content || raw,
        role: 'assistant',
        ...(parsed.usage ? { usage: mapOpenAIUsage(parsed.usage) } : {}),
        raw: parsed,
      };
    } catch {
      return { id: this.generateResponseId(), content: raw, role: 'assistant' };
    }
  }

  async sendMessage(message: CliMessage): Promise<CliResponse> {
    const userMsg: LocalModelChatMessage = { role: 'user', content: message.content };
    const messages = this.buildMessages(userMsg);
    const signal = this.beginLocalModelTurn();

    try {
      const response = await this.postStreamingChat(messages, signal);
      this.appendAssistantTurn(userMsg, response.content);
      return response;
    } finally {
      this.endLocalModelTurn(signal);
    }
  }

  async sendToolTurn(
    messages: readonly LocalModelToolTurnMessage[],
    tools: readonly LocalReviewToolDefinition[],
    signal: AbortSignal,
  ): Promise<LocalModelToolTurnResult> {
    const body = {
      model: this.model,
      messages: messages.map(mapOpenAIToolTurnMessage),
      stream: false,
      temperature: this.temperature,
      tools: tools.map(mapOpenAIToolDefinition),
    } satisfies OpenAICompatibleChatRequest;
    return await this.withResponse(this.url('/v1/chat/completions'), {
      method: 'POST',
      headers: this.headers({ acceptJson: true, contentJson: true }),
      body: JSON.stringify(body),
    }, signal, async (response, responseSignal) => {
      if (!response.ok) {
        const errorBody = await readLocalModelErrorText(response, responseSignal);
        throw new Error(`OpenAI-compatible tool turn error ${response.status}: ${errorBody}`);
      }
      const parsed = await this.parseToolTurnResponse(response, responseSignal);
      const choice = parsed.choices?.[0];
      if (!choice?.message) {
        throw new LocalModelToolResponseError('OpenAI-compatible tool turn is missing an assistant message');
      }
      return {
        content: coerceMessageContent(choice.message.content),
        toolCalls: parseOpenAIToolCalls(choice.message.tool_calls),
        ...(parsed.usage ? { usage: mapOpenAIUsage(parsed.usage) } : {}),
      };
    });
  }

  async *sendMessageStream(message: CliMessage): AsyncIterable<string> {
    const response = await this.sendMessage(message);
    if (response.content) {
      yield response.content;
    }
  }

  async spawn(): Promise<number> {
    if (this.isRunning()) {
      throw new Error('OpenAICompatibleChatAdapter already spawned');
    }

    const status = await this.checkStatus();
    if (!status.available) {
      throw new Error(`OpenAI-compatible local model endpoint not available: ${status.error}`);
    }

    const models = Array.isArray(status.metadata?.['models'])
      ? status.metadata['models'].filter((model): model is string => typeof model === 'string')
      : [];
    if (!models.includes(this.model)) {
      throw new Error(`${this.model} is no longer available from OpenAI-compatible endpoint.`);
    }

    this.seedHistoryFromSystemPrompt();
    const fakePid = this.markLocalModelSpawned();
    logger.info('OpenAI-compatible local model adapter spawned', {
      endpointId: this.endpointId,
      model: this.model,
    });
    return fakePid;
  }

  private async postStreamingChat(
    messages: LocalModelChatMessage[],
    signal: AbortSignal,
  ): Promise<CliResponse> {
    const body = this.chatRequestBody(messages, true);
    const streamed = await this.withResponse(this.url('/v1/chat/completions'), {
      method: 'POST',
      headers: this.headers({ acceptJson: true, contentJson: true }),
      body: JSON.stringify(body),
    }, signal, async (response, responseSignal) => {
      if (!response.ok) {
        const errorBody = await readLocalModelErrorText(response, responseSignal);
        if (isStreamingUnsupportedError(response.status, errorBody)) return null;
        throw new Error(`OpenAI-compatible chat error ${response.status}: ${errorBody}`);
      }
      return this.readSseResponse(response, responseSignal);
    });
    return streamed ?? this.postNonStreamingChat(messages, signal);
  }

  private async postNonStreamingChat(
    messages: LocalModelChatMessage[],
    signal: AbortSignal,
  ): Promise<CliResponse> {
    const body = this.chatRequestBody(messages, false);
    return await this.withResponse(this.url('/v1/chat/completions'), {
      method: 'POST',
      headers: this.headers({ acceptJson: true, contentJson: true }),
      body: JSON.stringify(body),
    }, signal, async (response, responseSignal) => {
      if (!response.ok) {
        const errorBody = await readLocalModelErrorText(response, responseSignal);
        throw new Error(`OpenAI-compatible non-streaming chat error ${response.status}: ${errorBody}`);
      }
      const parsed = JSON.parse(await readLocalModelResponseText(
        response,
        MAX_LOCAL_MODEL_JSON_RESPONSE_BYTES,
        'OpenAI-compatible non-streaming response',
        responseSignal,
      )) as OpenAIChatCompletionResponse;
      const content = extractNonStreamingContent(parsed);
      this.emitAssistantChunk(content, false);
      return {
        id: this.generateResponseId(), content, role: 'assistant',
        ...(parsed.usage ? { usage: mapOpenAIUsage(parsed.usage) } : {}), raw: parsed,
      };
    });
  }

  private async readSseResponse(response: Response, signal: AbortSignal): Promise<CliResponse> {
    if (!response.body) {
      throw new Error('OpenAI-compatible streaming response did not include a body');
    }

    const reader = openLocalModelResponseReader(response, signal);
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let usage: CliUsage | undefined;
    let partial = '';
    let doneSeen = false;

    try {
      while (!doneSeen) {
        const read = await reader.read();
        if (read.done) break;
        partial += decoder.decode(read.value, { stream: true });
        const lines = partial.split(/\r?\n/);
        partial = lines.pop() ?? '';
        for (const line of lines) {
          const result = this.handleSseLine(line, chunks);
          if (result.usage) usage = result.usage;
          if (result.done) {
            doneSeen = true;
            break;
          }
        }
      }
    } finally {
      if (doneSeen) await reader.cancel();
      reader.release();
    }

    if (!doneSeen && partial.trim()) {
      const result = this.handleSseLine(partial, chunks);
      if (result.usage) {
        usage = result.usage;
      }
    }

    return {
      id: this.generateResponseId(),
      content: chunks.join(''),
      role: 'assistant',
      ...(usage ? { usage } : {}),
      raw: { streaming: true },
    };
  }

  private handleSseLine(
    line: string,
    chunks: string[],
  ): { done: boolean; usage?: CliUsage } {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) {
      return { done: false };
    }
    if (!trimmed.startsWith('data:')) {
      return { done: false };
    }

    const data = trimmed.slice('data:'.length).trim();
    if (data === '[DONE]') {
      return { done: true };
    }

    try {
      const parsed = JSON.parse(data) as OpenAIChatCompletionResponse;
      const content = extractStreamingContent(parsed);
      if (content) {
        chunks.push(content);
        this.emitAssistantChunk(content, true);
      }
      return parsed.usage
        ? { done: false, usage: mapOpenAIUsage(parsed.usage) }
        : { done: false };
    } catch {
      logger.debug('OpenAI-compatible local model: unparseable SSE data', { data });
      return { done: false };
    }
  }

  private chatRequestBody(
    messages: LocalModelChatMessage[],
    stream: boolean,
  ): OpenAICompatibleChatRequest {
    return {
      model: this.model,
      messages,
      stream,
      temperature: this.temperature,
    };
  }

  private url(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }

  private headers(options: { acceptJson?: boolean; contentJson?: boolean }): Record<string, string> {
    const headers: Record<string, string> = {};
    if (options.acceptJson) {
      headers['Accept'] = 'application/json';
    }
    if (options.contentJson) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private withResponse<T>(
    url: string,
    init: RequestInit,
    externalSignal: AbortSignal | undefined,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return withLocalModelFetchResponse(
      url, init, externalSignal, this.timeoutMs, this.timeoutMessage(), consume,
    );
  }

  private async parseToolTurnResponse(
    response: Response,
    signal: AbortSignal,
  ): Promise<OpenAIChatCompletionResponse> {
    try {
      return JSON.parse(await readLocalModelResponseText(
        response, MAX_LOCAL_MODEL_JSON_RESPONSE_BYTES,
        'OpenAI-compatible tool-turn response', signal,
      )) as OpenAIChatCompletionResponse;
    } catch (error) {
      if (error instanceof LocalModelToolResponseError || signal.aborted) throw error;
      throw new LocalModelToolResponseError('OpenAI-compatible endpoint returned malformed tool-turn JSON');
    }
  }

  private timeoutMessage(): string {
    return `OpenAI-compatible request timed out after ${this.timeoutMs}ms`;
  }
}

function mapOpenAIToolTurnMessage(message: LocalModelToolTurnMessage): OpenAIChatMessage {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
  if ('toolCalls' in message) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  return message;
}

function mapOpenAIToolDefinition(tool: LocalReviewToolDefinition): OpenAIToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function parseOpenAIToolCalls(value: unknown): LocalModelToolCall[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new LocalModelToolResponseError('OpenAI tool_calls must be an array');
  }
  return value.map((call) => {
    if (!call || typeof call !== 'object') {
      throw new LocalModelToolResponseError('OpenAI-compatible endpoint returned a malformed tool call');
    }
    const candidate = call as { id?: unknown; type?: unknown; function?: unknown };
    if (candidate.type !== 'function' || !candidate.function || typeof candidate.function !== 'object') {
      throw new LocalModelToolResponseError('OpenAI tool call is missing function data');
    }
    const fn = candidate.function as { name?: unknown; arguments?: unknown };
    if (typeof fn.arguments !== 'string') {
      throw new LocalModelToolResponseError('OpenAI tool call arguments must be JSON text');
    }
    let args: unknown;
    try {
      args = JSON.parse(fn.arguments);
    } catch {
      throw new LocalModelToolResponseError('OpenAI tool call arguments contain invalid JSON');
    }
    return normalizeLocalModelToolCall(candidate.id, fn.name, args);
  });
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function isStreamingUnsupportedError(status: number, body: string): boolean {
  if (![400, 404, 422, 501].includes(status)) {
    return false;
  }
  const normalized = body.toLowerCase();
  return /stream(?:ing)?[^a-z0-9]+(?:is\s+)?(?:not\s+supported|unsupported|not\s+implemented)/i
    .test(normalized)
    || /(?:not\s+supported|unsupported|not\s+implemented)[^a-z0-9]+stream(?:ing)?/i
      .test(normalized);
}

function extractStreamingContent(response: OpenAIChatCompletionResponse): string {
  return (response.choices ?? [])
    .map((choice) => choice.delta?.content ?? '')
    .join('');
}

function extractNonStreamingContent(response: OpenAIChatCompletionResponse): string {
  return (response.choices ?? [])
    .map((choice) => coerceMessageContent(choice.message?.content))
    .join('');
}

function coerceMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (
          part
          && typeof part === 'object'
          && 'text' in part
          && typeof (part as { text?: unknown }).text === 'string'
        ) {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function mapOpenAIUsage(usage: OpenAIUsage): CliUsage {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens
      ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
  };
}
