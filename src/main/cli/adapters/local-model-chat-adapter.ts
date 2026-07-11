import type { LocalModelEndpointProvider } from '../../../shared/types/local-model-runtime.types';
import {
  type LocalReviewToolDefinition,
} from '../../review/local-review.types';
import type {
  ContextUsage,
  FileAttachment,
  InstanceStatus,
  OutputMessage,
} from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { getLogger } from '../../logging/logger';
import {
  BaseCliAdapter,
  type AdapterRuntimeCapabilities,
  type CliAdapterConfig,
  type CliMessage,
  type CliResponse,
  type CliUsage,
  type InterruptResult,
} from './base-cli-adapter';

const logger = getLogger('LocalModelChatAdapter');

export interface LocalModelChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LocalModelToolCall {
  id: string;
  /** Untrusted model output; the bounded runner returns typed errors for unknown names. */
  name: string;
  arguments: unknown;
}

export type LocalModelToolTurnMessage =
  | LocalModelChatMessage
  | {
      role: 'assistant';
      content: string;
      toolCalls: readonly LocalModelToolCall[];
    }
  | {
      role: 'tool';
      content: string;
      toolCallId: string;
      toolName: string;
    };

export interface LocalModelToolTurnResult {
  content: string;
  toolCalls: LocalModelToolCall[];
  usage?: CliUsage;
}

/** Narrow client used by local review; ordinary local-model chat remains tool-free. */
export interface LocalModelToolTurnClient {
  sendToolTurn(
    messages: readonly LocalModelToolTurnMessage[],
    tools: readonly LocalReviewToolDefinition[],
    signal: AbortSignal,
  ): Promise<LocalModelToolTurnResult>;
}

export class LocalModelToolResponseError extends Error {
  readonly code = 'unreliable-tool-response';

  constructor(message: string) {
    super(message);
    this.name = 'LocalModelToolResponseError';
  }
}

export function normalizeLocalModelToolCall(
  id: unknown,
  name: unknown,
  args: unknown,
): LocalModelToolCall {
  if (typeof id !== 'string' || id.length === 0) {
    throw new LocalModelToolResponseError('Tool call is missing a non-empty id');
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new LocalModelToolResponseError('Tool call is missing a non-empty name');
  }
  return { id, name, arguments: args };
}

export interface LocalModelChatAdapter extends BaseCliAdapter {
  spawn(): Promise<number>;
  getEndpointProvider(): LocalModelEndpointProvider;
  getModelId(): string;
}

export interface BaseLocalModelChatAdapterOptions {
  endpointProvider: LocalModelEndpointProvider;
  model: string;
  systemPrompt?: string;
  contextWindow: number;
  sessionIdPrefix: string;
  errorLabel: string;
}

export abstract class BaseLocalModelChatAdapter
  extends BaseCliAdapter
  implements LocalModelChatAdapter {
  protected readonly endpointProvider: LocalModelEndpointProvider;
  protected readonly model: string;
  protected readonly systemPrompt?: string;
  protected readonly contextWindow: number;
  protected history: LocalModelChatMessage[] = [];

  private readonly errorLabel: string;
  private isSpawned = false;
  private activeAbortController: AbortController | null = null;
  private activeOutputMessageId: string | null = null;
  private activeAccumulatedContent = '';
  private cumulativeTokensUsed = 0;

  abstract spawn(): Promise<number>;

  constructor(
    config: CliAdapterConfig,
    options: BaseLocalModelChatAdapterOptions,
  ) {
    super(config);
    this.endpointProvider = options.endpointProvider;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt;
    this.contextWindow = options.contextWindow;
    this.errorLabel = options.errorLabel;
    this.sessionId = `${options.sessionIdPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  getEndpointProvider(): LocalModelEndpointProvider {
    return this.endpointProvider;
  }

  getModelId(): string {
    return this.model;
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

  protected override async sendInputImpl(
    message: string,
    attachments?: FileAttachment[],
  ): Promise<void> {
    if (!this.isSpawned) {
      throw new Error(`${this.getName()}: call spawn() before sendInput()`);
    }
    if (attachments && attachments.length > 0) {
      throw new Error(`${this.errorLabel} does not currently support attachments in orchestrator mode.`);
    }

    this.emit('status', 'busy' as InstanceStatus);

    try {
      const cliMessage: CliMessage = { role: 'user', content: message };
      const response = await this.sendMessage(cliMessage);
      this.emitContextUsage(response);
      this.emit('status', 'idle' as InstanceStatus);
      this.completeResponse(response);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Local model sendInput error', err, {
        adapter: this.getName(),
        endpointProvider: this.endpointProvider,
        model: this.model,
      });
      const errorMessage: OutputMessage = {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error',
        content: `${this.errorLabel} error: ${err.message}`,
        metadata: { error: err.message },
      };
      this.emit('output', errorMessage);
      this.emit('status', 'error' as InstanceStatus);
      this.emit('error', err);
    }
  }

  override interrupt(): InterruptResult {
    if (!this.activeAbortController || this.activeAbortController.signal.aborted) {
      return { status: 'no-active-turn', reason: 'No active local model request' };
    }
    this.activeAbortController.abort();
    return { status: 'accepted' };
  }

  override async terminate(): Promise<void> {
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.activeOutputMessageId = null;
    this.activeAccumulatedContent = '';
    this.isSpawned = false;
    this.history = [];
    this.emit('exit', 0, null);
  }

  override isRunning(): boolean {
    return this.isSpawned;
  }

  protected markLocalModelSpawned(): number {
    this.isSpawned = true;
    const fakePid = Math.floor(Math.random() * 100_000) + 10_000;
    this.emit('spawned', fakePid);
    this.emit('status', 'idle' as InstanceStatus);
    return fakePid;
  }

  protected seedHistoryFromSystemPrompt(): void {
    this.history = this.systemPrompt
      ? [{ role: 'system', content: this.systemPrompt }]
      : [];
  }

  protected buildMessages(newUserMessage: LocalModelChatMessage): LocalModelChatMessage[] {
    return [...this.history, newUserMessage];
  }

  protected appendAssistantTurn(
    userMessage: LocalModelChatMessage,
    assistantContent: string,
  ): void {
    this.history.push(userMessage, { role: 'assistant', content: assistantContent });
  }

  protected beginLocalModelTurn(): AbortSignal {
    if (this.activeAbortController && !this.activeAbortController.signal.aborted) {
      throw new Error('A local model request is already active');
    }
    this.activeAbortController = new AbortController();
    this.activeOutputMessageId = generateId();
    this.activeAccumulatedContent = '';
    return this.activeAbortController.signal;
  }

  protected endLocalModelTurn(signal: AbortSignal): void {
    if (this.activeAbortController?.signal === signal) {
      this.activeAbortController = null;
      this.activeOutputMessageId = null;
      this.activeAccumulatedContent = '';
    }
  }

  protected emitAssistantChunk(content: string, streaming: boolean): void {
    if (!content) {
      return;
    }
    this.activeAccumulatedContent += content;
    const output: OutputMessage = {
      id: this.activeOutputMessageId ?? generateId(),
      timestamp: Date.now(),
      type: 'assistant',
      content,
      metadata: {
        streaming,
        accumulatedContent: this.activeAccumulatedContent,
      },
    };
    this.emit('output', output);
    this.noteActivity();
  }

  private emitContextUsage(response: CliResponse): void {
    if (!response.usage) {
      return;
    }

    const inputTokens = response.usage.inputTokens ?? 0;
    const outputTokens = response.usage.outputTokens ?? 0;
    const turnTokens = response.usage.totalTokens ?? inputTokens + outputTokens;
    this.cumulativeTokensUsed += turnTokens;
    const contextWindow = this.getCapabilities().contextWindow || this.contextWindow;
    const contextUsage: ContextUsage = {
      used: Math.min(turnTokens, contextWindow),
      total: contextWindow,
      percentage: contextWindow > 0 ? Math.min((turnTokens / contextWindow) * 100, 100) : 0,
      cumulativeTokens: this.cumulativeTokensUsed,
    };
    this.emit('context', contextUsage);
  }
}
