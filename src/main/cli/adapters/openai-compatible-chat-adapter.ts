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
} from './local-model-chat-adapter';
import { getLogger } from '../../logging/logger';
import type { CliSpawnMode, CliStatus } from './base-cli-adapter';

const logger = getLogger('OpenAICompatibleChatAdapter');

const DEFAULT_BASE_URL = 'http://127.0.0.1:1234';
const DEFAULT_MODEL = 'local-model';
const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_TEMPERATURE = 0.2;

interface OpenAICompatibleChatRequest {
  model: string;
  messages: LocalModelChatMessage[];
  stream: boolean;
  temperature: number;
}

interface OpenAIChatChoiceDelta {
  delta?: {
    content?: string;
  };
  message?: {
    role?: string;
    content?: unknown;
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
  data?: Array<{ id?: string }>;
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

export class OpenAICompatibleChatAdapter extends BaseLocalModelChatAdapter {
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
      const response = await this.fetchWithTimeout(this.url('/v1/models'), {
        method: 'GET',
        headers: this.headers({ acceptJson: true }),
      });
      if (!response.ok) {
        const body = await safeReadText(response);
        return {
          available: false,
          error: `OpenAI-compatible endpoint not reachable at ${this.baseUrl}: HTTP ${response.status}${body ? `: ${body}` : ''}`,
        };
      }
      const parsed = await response.json() as OpenAIModelsResponse;
      const models = (parsed.data ?? [])
        .map((model) => model.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      return {
        available: true,
        path: this.baseUrl,
        authenticated: true,
        metadata: {
          endpointId: this.endpointId,
          models,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        available: false,
        error: `OpenAI-compatible endpoint not reachable at ${this.baseUrl}: ${message}`,
      };
    }
  }

  protected buildArgs(_message: CliMessage): string[] {
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
    const response = await this.fetchWithTimeout(this.url('/v1/chat/completions'), {
      method: 'POST',
      headers: this.headers({ acceptJson: true, contentJson: true }),
      body: JSON.stringify(body),
    }, signal);

    if (!response.ok) {
      const errorBody = await safeReadText(response);
      if (isStreamingUnsupportedError(response.status, errorBody)) {
        return this.postNonStreamingChat(messages, signal);
      }
      throw new Error(`OpenAI-compatible chat error ${response.status}: ${errorBody}`);
    }

    return this.readSseResponse(response);
  }

  private async postNonStreamingChat(
    messages: LocalModelChatMessage[],
    signal: AbortSignal,
  ): Promise<CliResponse> {
    const body = this.chatRequestBody(messages, false);
    const response = await this.fetchWithTimeout(this.url('/v1/chat/completions'), {
      method: 'POST',
      headers: this.headers({ acceptJson: true, contentJson: true }),
      body: JSON.stringify(body),
    }, signal);

    if (!response.ok) {
      const errorBody = await safeReadText(response);
      throw new Error(`OpenAI-compatible non-streaming chat error ${response.status}: ${errorBody}`);
    }

    const parsed = await response.json() as OpenAIChatCompletionResponse;
    const content = extractNonStreamingContent(parsed);
    this.emitAssistantChunk(content, false);
    return {
      id: this.generateResponseId(),
      content,
      role: 'assistant',
      ...(parsed.usage ? { usage: mapOpenAIUsage(parsed.usage) } : {}),
      raw: parsed,
    };
  }

  private async readSseResponse(response: Response): Promise<CliResponse> {
    if (!response.body) {
      throw new Error('OpenAI-compatible streaming response did not include a body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let usage: CliUsage | undefined;
    let partial = '';
    let doneSeen = false;

    while (!doneSeen) {
      const read = await reader.read();
      if (read.done) {
        break;
      }
      partial += decoder.decode(read.value, { stream: true });
      const lines = partial.split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const line of lines) {
        const result = this.handleSseLine(line, chunks);
        if (result.usage) {
          usage = result.usage;
        }
        if (result.done) {
          doneSeen = true;
          break;
        }
      }
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

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(this.timeoutMessage()));
    }, this.timeoutMs);

    const onExternalAbort = (): void => {
      controller.abort(externalSignal?.reason);
    };
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (isAbortSignalRealmError(error)) {
        return this.fetchWithoutSignalWithTimeout(url, init);
      }
      if (timedOut) {
        throw new Error(this.timeoutMessage());
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private fetchWithoutSignalWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const fallbackInit: RequestInit = { ...init };
    delete fallbackInit.signal;

    return new Promise<Response>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(this.timeoutMessage())), this.timeoutMs);

      fetch(url, fallbackInit)
        .then(resolve, reject)
        .finally(() => clearTimeout(timeout));
    });
  }

  private timeoutMessage(): string {
    return `OpenAI-compatible request timed out after ${this.timeoutMs}ms`;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
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

function isAbortSignalRealmError(error: unknown): boolean {
  return error instanceof TypeError
    && error.message.includes('Expected signal')
    && error.message.includes('AbortSignal');
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
