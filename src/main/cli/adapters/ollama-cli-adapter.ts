/**
 * Ollama CLI Adapter - Connects to a local Ollama server via REST API
 * https://github.com/ollama/ollama
 *
 * Ollama is a local LLM server. Unlike other adapters that spawn CLI processes,
 * this adapter communicates via the Ollama REST API at http://localhost:11434.
 * Multi-turn conversation state is maintained in-memory via a messages array.
 *
 * Execution model: HTTP-per-message (like Gemini/Copilot in exec-per-message mode),
 * not a persistent CLI process. Each sendInput() call posts to the Ollama server.
 *
 * Requires a running Ollama daemon (`ollama serve` or the Ollama.app). The
 * adapter checks that the server is reachable in spawn().
 */

import * as http from 'node:http';
import {
  CliAdapterConfig,
  CliCapabilities,
  CliMessage,
  CliResponse,
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

const logger = getLogger('OllamaCliAdapter');

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 11434;
const DEFAULT_MODEL = 'llama3.2';

// ── Ollama API types ───────────────────────────────────────────────────────────

interface OllamaToolCall {
  id: string;
  function: {
    name: string;
    arguments: unknown;
  };
}

type OllamaChatMessage =
  | LocalModelChatMessage
  | { role: 'assistant'; content: string; tool_calls: OllamaToolCall[] }
  | { role: 'tool'; tool_name: string; content: string };

interface OllamaToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: boolean;
  tools?: OllamaToolDefinition[];
}

interface OllamaChatResponseChunk {
  model: string;
  created_at: string;
  message: { role: 'assistant'; content: string; tool_calls?: unknown };
  done: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaVersionResponse {
  version: string;
}

interface OllamaModel {
  name: string;
  model?: string;
  modified_at?: string;
  size?: number;
}

interface OllamaTagsResponse {
  models: OllamaModel[];
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface OllamaCliConfig {
  /** Model name to use (e.g. 'llama3.2', 'codellama', 'mistral'). Default: 'llama3.2'. */
  model?: string;
  /** Ollama server hostname. Default: 'localhost'. */
  host?: string;
  /** Ollama server port. Default: 11434. */
  port?: number;
  /** System prompt to prepend at the start of each conversation. */
  systemPrompt?: string;
  /** Request timeout in milliseconds. Default: 300000 (5 min). */
  timeout?: number;
  /** Working directory (not used for HTTP, stored for compatibility). */
  workingDir?: string;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class OllamaCliAdapter extends BaseLocalModelChatAdapter implements LocalModelToolTurnClient {
  /** B9: Ollama has no local process — it talks to the Ollama REST server. */
  protected override spawnMode: CliSpawnMode = 'http';

  private readonly host: string;
  private readonly port: number;

  constructor(config: OllamaCliConfig = {}) {
    const model = config.model ?? DEFAULT_MODEL;
    const adapterConfig: CliAdapterConfig = {
      command: 'ollama',
      args: [],
      cwd: config.workingDir,
      timeout: config.timeout ?? 300_000,
      sessionPersistence: true,
    };
    super(adapterConfig, {
      endpointProvider: 'ollama',
      model,
      systemPrompt: config.systemPrompt,
      contextWindow: 131_072,
      sessionIdPrefix: 'ollama',
      errorLabel: 'Ollama',
    });

    this.host = config.host ?? DEFAULT_HOST;
    this.port = config.port ?? DEFAULT_PORT;
  }

  // ── Abstract implementations ──────────────────────────────────────────────

  getName(): string {
    return 'ollama';
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
      contextWindow: 131_072, // Common for llama3.2; actual limit is model-dependent
      outputFormats: ['text', 'markdown'],
    };
  }

  async checkStatus(): Promise<CliStatus> {
    try {
      const versionJson = await this.httpGet('/api/version', 5_000);
      const version = (JSON.parse(versionJson) as OllamaVersionResponse).version;
      return { available: true, version, path: `http://${this.host}:${this.port}`, authenticated: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { available: false, error: `Ollama server not reachable at ${this.host}:${this.port}: ${msg}` };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected buildArgs(_message: CliMessage): string[] {
    return [];
  }

  parseOutput(raw: string): CliResponse {
    try {
      const parsed = JSON.parse(raw) as OllamaChatResponseChunk;
      return {
        id: this.generateResponseId(),
        content: parsed.message?.content ?? raw,
        role: 'assistant',
        usage: {
          inputTokens: parsed.prompt_eval_count,
          outputTokens: parsed.eval_count,
          totalTokens: (parsed.prompt_eval_count ?? 0) + (parsed.eval_count ?? 0),
        },
        raw: parsed,
      };
    } catch {
      return { id: this.generateResponseId(), content: raw, role: 'assistant' };
    }
  }

  async sendMessage(message: CliMessage): Promise<CliResponse> {
    const userMsg: OllamaChatMessage = { role: 'user', content: message.content };
    const messages = this.buildMessages(userMsg);

    const contentChunks: string[] = [];
    let promptEvalCount = 0;
    let evalCount = 0;

    const signal = this.beginLocalModelTurn();
    try {
      await this.postChatStream(messages, signal, (chunk) => {
        contentChunks.push(chunk.message.content);
        if (chunk.done) {
          promptEvalCount = chunk.prompt_eval_count ?? 0;
          evalCount = chunk.eval_count ?? 0;
        }

        this.emitAssistantChunk(chunk.message.content, true);
      });
    } finally {
      this.endLocalModelTurn(signal);
    }

    const fullContent = contentChunks.join('');
    this.appendAssistantTurn(userMsg, fullContent);

    return {
      id: this.generateResponseId(),
      content: fullContent,
      role: 'assistant',
      usage: {
        inputTokens: promptEvalCount,
        outputTokens: evalCount,
        totalTokens: promptEvalCount + evalCount,
      },
    };
  }

  async sendToolTurn(
    messages: readonly LocalModelToolTurnMessage[],
    tools: readonly LocalReviewToolDefinition[],
    signal: AbortSignal,
  ): Promise<LocalModelToolTurnResult> {
    const requestMessages = messages.map(mapOllamaToolTurnMessage);
    const body = {
      model: this.model,
      messages: requestMessages,
      stream: false,
      tools: tools.map(mapOllamaToolDefinition),
    } satisfies OllamaChatRequest;
    const parsed = parseOllamaToolTurnResponse(await this.postChat(body, signal));
    const toolCalls = parsed.toolCalls;
    const inputTokens = parsed.prompt_eval_count;
    const outputTokens = parsed.eval_count;
    return {
      content: parsed.content,
      toolCalls,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
      },
    };
  }

  async *sendMessageStream(message: CliMessage): AsyncIterable<string> {
    const userMsg: OllamaChatMessage = { role: 'user', content: message.content };
    const messages = this.buildMessages(userMsg);

    const chunks: string[] = [];
    const queue: (string | null)[] = [];
    let resolve: (() => void) | null = null;

    const signal = this.beginLocalModelTurn();
    this.postChatStream(messages, signal, (chunk) => {
      queue.push(chunk.message.content);
      if (chunk.done) queue.push(null);
      resolve?.();
    })
      .catch((err) => {
        queue.push(null);
        logger.error('Ollama stream error', err instanceof Error ? err : new Error(String(err)));
        resolve?.();
      })
      .finally(() => {
        this.endLocalModelTurn(signal);
      });

    while (true) {
      while (queue.length > 0) {
        const item = queue.shift()!;
        if (item === null) {
          this.appendAssistantTurn(userMsg, chunks.join(''));
          return;
        }
        chunks.push(item);
        yield item;
      }
      await new Promise<void>((r) => { resolve = r; });
      resolve = null;
    }
  }

  // ── Spawn / lifecycle ─────────────────────────────────────────────────────

  async spawn(): Promise<number> {
    if (this.isRunning()) {
      throw new Error('OllamaCliAdapter already spawned');
    }

    const status = await this.checkStatus();
    if (!status.available) {
      throw new Error(`Ollama not available: ${status.error}`);
    }

    const tagsJson = await this.httpGet('/api/tags', 5_000);
    const tags = JSON.parse(tagsJson) as OllamaTagsResponse;
    const modelNames = tags.models.map((m) => m.name);
    const modelAvailable = modelNames.some(
      (name) => name === this.model || name.startsWith(`${this.model}:`),
    );
    if (!modelAvailable) {
      throw new Error(`${this.model} is no longer available from Ollama.`);
    }

    this.seedHistoryFromSystemPrompt();

    const fakePid = this.markLocalModelSpawned();
    logger.info('Ollama adapter spawned', { model: this.model, host: this.host, port: this.port });

    return fakePid;
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  private httpGet(path: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        { hostname: this.host, port: this.port, path, headers: { Accept: 'application/json' } },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => resolve(data));
        },
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new Error(`Ollama HTTP GET ${path} timed out after ${timeoutMs}ms`));
      });
      req.on('error', reject);
    });
  }

  private postChatStream(
    messages: OllamaChatMessage[],
    signal: AbortSignal,
    onChunk: (chunk: OllamaChatResponseChunk) => void,
  ): Promise<void> {
    const body = JSON.stringify({
      model: this.model,
      messages,
      stream: true,
    } satisfies OllamaChatRequest);

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: this.host,
          port: this.port,
          path: '/api/chat',
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          if (res.statusCode !== undefined && res.statusCode >= 400) {
            let errorBody = '';
            res.on('data', (chunk: Buffer) => { errorBody += chunk.toString(); });
            res.on('end', () => reject(new Error(`Ollama API error ${res.statusCode}: ${errorBody}`)));
            return;
          }

          let partial = '';
          res.on('data', (chunk: Buffer) => {
            partial += chunk.toString();
            const lines = partial.split('\n');
            partial = lines.pop() ?? '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                const parsed = JSON.parse(trimmed) as OllamaChatResponseChunk;
                onChunk(parsed);
              } catch {
                logger.debug('Ollama: unparseable NDJSON line', { line: trimmed });
              }
            }
          });

          res.on('end', () => {
            // Flush any remaining partial line
            if (partial.trim()) {
              try {
                const parsed = JSON.parse(partial.trim()) as OllamaChatResponseChunk;
                onChunk(parsed);
              } catch {
                // ignore
              }
            }
            resolve();
          });

          res.on('error', reject);
        },
      );

      req.setTimeout(this.config.timeout ?? 300_000, () => {
        req.destroy();
        reject(new Error(`Ollama chat request timed out after ${this.config.timeout}ms`));
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private postChat(
    requestBody: OllamaChatRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    const body = JSON.stringify(requestBody);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: this.host,
          port: this.port,
          path: '/api/chat',
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let responseBody = '';
          res.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
          res.on('end', () => {
            if (res.statusCode !== undefined && res.statusCode >= 400) {
              reject(new Error(`Ollama API error ${res.statusCode}: ${responseBody}`));
              return;
            }
            try {
              resolve(JSON.parse(responseBody) as unknown);
            } catch {
              reject(new LocalModelToolResponseError('Ollama returned malformed tool-turn JSON'));
            }
          });
          res.on('error', reject);
        },
      );
      req.setTimeout(this.config.timeout ?? 300_000, () => {
        req.destroy();
        reject(new Error(`Ollama chat request timed out after ${this.config.timeout}ms`));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

function mapOllamaToolTurnMessage(message: LocalModelToolTurnMessage): OllamaChatMessage {
  if (message.role === 'tool') {
    return { role: 'tool', tool_name: message.toolName, content: message.content };
  }
  if ('toolCalls' in message) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return message;
}

function mapOllamaToolDefinition(tool: LocalReviewToolDefinition): OllamaToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function parseOllamaToolCalls(value: unknown): LocalModelToolCall[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new LocalModelToolResponseError('Ollama tool_calls must be an array');
  }
  return value.map((call) => {
    if (!call || typeof call !== 'object') {
      throw new LocalModelToolResponseError('Ollama returned a malformed tool call');
    }
    const candidate = call as { id?: unknown; function?: unknown };
    if (!candidate.function || typeof candidate.function !== 'object') {
      throw new LocalModelToolResponseError('Ollama tool call is missing function data');
    }
    const fn = candidate.function as { name?: unknown; arguments?: unknown };
    if (!Object.prototype.hasOwnProperty.call(fn, 'arguments')) {
      throw new LocalModelToolResponseError('Ollama tool call is missing arguments');
    }
    return normalizeLocalModelToolCall(candidate.id, fn.name, fn.arguments);
  });
}

function parseOllamaToolTurnResponse(value: unknown): {
  content: string;
  toolCalls: LocalModelToolCall[];
  prompt_eval_count?: number;
  eval_count?: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalModelToolResponseError('Ollama tool turn must be a response object');
  }
  const response = value as {
    message?: unknown;
    prompt_eval_count?: unknown;
    eval_count?: unknown;
  };
  if (!response.message || typeof response.message !== 'object' || Array.isArray(response.message)) {
    throw new LocalModelToolResponseError('Ollama tool turn is missing an assistant message');
  }
  const message = response.message as {
    role?: unknown;
    content?: unknown;
    tool_calls?: unknown;
  };
  if (message.role !== 'assistant') {
    throw new LocalModelToolResponseError('Ollama tool-turn message must have the assistant role');
  }
  const toolCalls = parseOllamaToolCalls(message.tool_calls);
  const content = typeof message.content === 'string'
    ? message.content
    : message.content == null && toolCalls.length > 0
      ? ''
      : null;
  if (content === null) {
    throw new LocalModelToolResponseError(
      'Ollama assistant content must be a string unless valid tool calls are present',
    );
  }
  return {
    content,
    toolCalls,
    ...(typeof response.prompt_eval_count === 'number'
      ? { prompt_eval_count: response.prompt_eval_count }
      : {}),
    ...(typeof response.eval_count === 'number' ? { eval_count: response.eval_count } : {}),
  };
}
