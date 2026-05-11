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
  BaseCliAdapter,
  AdapterRuntimeCapabilities,
  CliAdapterConfig,
  CliCapabilities,
  CliMessage,
  CliResponse,
} from './base-cli-adapter';
import { getLogger } from '../../logging/logger';
import type {
  ContextUsage,
  FileAttachment,
  InstanceStatus,
  OutputMessage,
} from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import type { CliStatus } from './base-cli-adapter';

const logger = getLogger('OllamaCliAdapter');

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 11434;
const DEFAULT_MODEL = 'llama3.2';

// ── Ollama API types ───────────────────────────────────────────────────────────

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: boolean;
}

interface OllamaChatResponseChunk {
  model: string;
  created_at: string;
  message: { role: 'assistant'; content: string };
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

export class OllamaCliAdapter extends BaseCliAdapter {
  private readonly ollamaConfig: OllamaCliConfig;
  private readonly host: string;
  private readonly port: number;
  private readonly model: string;

  /** Conversation history for multi-turn sessions. */
  private history: OllamaChatMessage[] = [];
  private isSpawned = false;
  private cumulativeTokensUsed = 0;

  constructor(config: OllamaCliConfig = {}) {
    const adapterConfig: CliAdapterConfig = {
      command: 'ollama',
      args: [],
      cwd: config.workingDir,
      timeout: config.timeout ?? 300_000,
      sessionPersistence: true,
    };
    super(adapterConfig);

    this.ollamaConfig = config;
    this.host = config.host ?? DEFAULT_HOST;
    this.port = config.port ?? DEFAULT_PORT;
    this.model = config.model ?? DEFAULT_MODEL;

    this.sessionId = `ollama-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

  override getRuntimeCapabilities(): AdapterRuntimeCapabilities {
    return {
      supportsResume: false,
      supportsForkSession: false,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
      selfManagedAutoCompaction: false,
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

    await this.postChatStream(messages, (chunk) => {
      contentChunks.push(chunk.message.content);
      if (chunk.done) {
        promptEvalCount = chunk.prompt_eval_count ?? 0;
        evalCount = chunk.eval_count ?? 0;
      }

      this.emit('output', {
        id: this.sessionId ?? generateId(),
        timestamp: Date.now(),
        type: 'assistant',
        content: chunk.message.content,
        metadata: { streaming: true },
      } satisfies OutputMessage);
    });

    const fullContent = contentChunks.join('');
    this.history.push(userMsg, { role: 'assistant', content: fullContent });

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

  async *sendMessageStream(message: CliMessage): AsyncIterable<string> {
    const userMsg: OllamaChatMessage = { role: 'user', content: message.content };
    const messages = this.buildMessages(userMsg);

    const chunks: string[] = [];
    const queue: (string | null)[] = [];
    let resolve: (() => void) | null = null;

    this.postChatStream(messages, (chunk) => {
      queue.push(chunk.message.content);
      if (chunk.done) queue.push(null);
      resolve?.();
    }).catch((err) => {
      queue.push(null);
      logger.error('Ollama stream error', err instanceof Error ? err : new Error(String(err)));
      resolve?.();
    });

    while (true) {
      while (queue.length > 0) {
        const item = queue.shift()!;
        if (item === null) {
          this.history.push(userMsg, { role: 'assistant', content: chunks.join('') });
          return;
        }
        chunks.push(item);
        yield item;
      }
      await new Promise<void>((r) => { resolve = r; });
      resolve = null;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected override async sendInputImpl(message: string, _attachments?: FileAttachment[]): Promise<void> {
    if (!this.isSpawned) {
      throw new Error('OllamaCliAdapter: call spawn() before sendInput()');
    }

    this.emit('status', 'busy' as InstanceStatus);

    try {
      const cliMessage: CliMessage = { role: 'user', content: message };
      const response = await this.sendMessage(cliMessage);

      if (response.usage) {
        const inputTokens = response.usage.inputTokens ?? 0;
        const outputTokens = response.usage.outputTokens ?? 0;
        const turnTokens = inputTokens + outputTokens;
        this.cumulativeTokensUsed += turnTokens;
        const contextWindow = this.getCapabilities().contextWindow;
        const contextUsage: ContextUsage = {
          used: Math.min(turnTokens, contextWindow),
          total: contextWindow,
          percentage: contextWindow > 0 ? Math.min((turnTokens / contextWindow) * 100, 100) : 0,
          cumulativeTokens: this.cumulativeTokensUsed,
        };
        this.emit('context', contextUsage);
      }

      this.emit('status', 'idle' as InstanceStatus);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Ollama sendInput error', err, { model: this.model });
      const errorMessage: OutputMessage = {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error',
        content: `Ollama error: ${err.message}`,
        metadata: { error: err.message },
      };
      this.emit('output', errorMessage);
      this.emit('status', 'error' as InstanceStatus);
    }
  }

  // ── Spawn / lifecycle ─────────────────────────────────────────────────────

  async spawn(): Promise<number> {
    if (this.isSpawned) {
      throw new Error('OllamaCliAdapter already spawned');
    }

    const status = await this.checkStatus();
    if (!status.available) {
      throw new Error(`Ollama not available: ${status.error}`);
    }

    // Verify the requested model is available; log a warning if not
    try {
      const tagsJson = await this.httpGet('/api/tags', 5_000);
      const tags = JSON.parse(tagsJson) as OllamaTagsResponse;
      const modelNames = tags.models.map((m) => m.name);
      const modelAvailable = modelNames.some(
        (name) => name === this.model || name.startsWith(`${this.model}:`),
      );
      if (!modelAvailable) {
        logger.warn('Requested Ollama model not found locally', {
          model: this.model,
          available: modelNames,
        });
      }
    } catch {
      // Non-fatal; the chat request will fail if the model is truly missing
    }

    // Seed history with system prompt if provided
    if (this.ollamaConfig.systemPrompt) {
      this.history = [{ role: 'system', content: this.ollamaConfig.systemPrompt }];
    }

    this.isSpawned = true;
    const fakePid = Math.floor(Math.random() * 100_000) + 10_000;
    this.emit('spawned', fakePid);
    this.emit('status', 'idle' as InstanceStatus);
    logger.info('Ollama adapter spawned', { model: this.model, host: this.host, port: this.port });

    return fakePid;
  }

  override async terminate(): Promise<void> {
    this.isSpawned = false;
    this.history = [];
    this.emit('exit', 0, null);
  }

  override isRunning(): boolean {
    return this.isSpawned;
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

  private buildMessages(newUserMessage: OllamaChatMessage): OllamaChatMessage[] {
    return [...this.history, newUserMessage];
  }
}
