import { EventEmitter } from 'events';
import { observeAdapterRuntimeEvents } from '../main/providers/adapter-runtime-event-bridge';
import { toOutputMessageFromProviderOutputEvent } from '../main/providers/provider-output-event';
import { OllamaCliAdapter } from '../main/cli/adapters/ollama-cli-adapter';
import { OpenAICompatibleChatAdapter } from '../main/cli/adapters/openai-compatible-chat-adapter';
import type {
  CliResponse,
  InterruptResult,
} from '../main/cli/adapters/base-cli-adapter';
import type { LocalModelChatAdapter } from '../main/cli/adapters/local-model-chat-adapter';
import type { FileAttachment } from '../shared/types/instance.types';
import type { LocalModelEndpointProvider } from '../shared/types/local-model-runtime.types';
import {
  LMSTUDIO_LOCAL_BASE_URL,
  OLLAMA_LOCAL_BASE_URL,
} from './local-model-config';

export interface LocalModelSessionStartParams {
  sessionId: string;
  endpointProvider: LocalModelEndpointProvider;
  endpointId: string;
  modelId: string;
  workingDirectory?: string;
  systemPrompt?: string;
}

export interface LocalModelSessionSendInputParams {
  sessionId: string;
  message: string;
  attachments?: FileAttachment[];
}

export interface LocalModelSessionIdParams {
  sessionId: string;
}

type WorkerLocalModelAdapter = EventEmitter & Pick<
  LocalModelChatAdapter,
  'spawn' | 'sendInput' | 'terminate' | 'interrupt' | 'getEndpointProvider' | 'getModelId'
>;

export interface LocalModelSessionManagerDeps {
  createAdapter?: (params: LocalModelSessionStartParams) => WorkerLocalModelAdapter;
  maxSessions?: number;
}

interface ManagedLocalModelSession {
  sessionId: string;
  adapter: WorkerLocalModelAdapter;
  cleanupRuntimeObserver: () => void;
}

export class LocalModelSessionManager extends EventEmitter {
  private readonly sessions = new Map<string, ManagedLocalModelSession>();
  private readonly createAdapter: (params: LocalModelSessionStartParams) => WorkerLocalModelAdapter;
  private readonly maxSessions: number;

  constructor(deps: LocalModelSessionManagerDeps = {}) {
    super();
    this.maxSessions = deps.maxSessions ?? 4;
    this.createAdapter = deps.createAdapter ?? createDefaultLocalModelAdapter;
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  async start(params: LocalModelSessionStartParams): Promise<{ sessionId: string }> {
    if (this.sessions.has(params.sessionId)) {
      throw new Error(`Local model session already exists: ${params.sessionId}`);
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Worker at local model session capacity (${this.maxSessions} sessions)`);
    }

    const adapter = this.createAdapter(params);
    const cleanupRuntimeObserver = this.observeAdapter(params.sessionId, adapter);
    this.sessions.set(params.sessionId, {
      sessionId: params.sessionId,
      adapter,
      cleanupRuntimeObserver,
    });

    try {
      await adapter.spawn();
      return { sessionId: params.sessionId };
    } catch (error) {
      this.removeSession(params.sessionId);
      throw error;
    }
  }

  async sendInput(params: LocalModelSessionSendInputParams): Promise<void> {
    const session = this.requireSession(params.sessionId);
    await session.adapter.sendInput(params.message, params.attachments);
  }

  async terminate(params: LocalModelSessionIdParams): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      return;
    }

    this.removeSession(params.sessionId);
    await session.adapter.terminate();
  }

  async interrupt(params: LocalModelSessionIdParams): Promise<InterruptResult> {
    const session = this.requireSession(params.sessionId);
    return session.adapter.interrupt();
  }

  async terminateAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      this.removeSession(session.sessionId);
    }
    await Promise.allSettled(sessions.map((session) => session.adapter.terminate()));
  }

  private observeAdapter(sessionId: string, adapter: WorkerLocalModelAdapter): () => void {
    return observeAdapterRuntimeEvents(adapter, ({ event, eventId, rawPayload, timestamp }) => {
      switch (event.kind) {
        case 'output':
          this.emit(
            'instance:output',
            sessionId,
            toOutputMessageFromProviderOutputEvent(event, { eventId, timestamp }),
          );
          break;
        case 'status':
          this.emit('instance:stateChange', sessionId, event.status);
          break;
        case 'context':
          this.emit('instance:context', sessionId, {
            used: event.used,
            total: event.total,
            percentage: event.percentage,
          });
          break;
        case 'complete':
          this.emit('instance:complete', sessionId, rawPayload as CliResponse);
          break;
        case 'exit':
          this.removeSession(sessionId);
          this.emit('instance:exit', sessionId, { code: event.code, signal: event.signal });
          break;
        default:
          break;
      }
    });
  }

  private requireSession(sessionId: string): ManagedLocalModelSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Local model session not found: ${sessionId}`);
    }
    return session;
  }

  private removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.cleanupRuntimeObserver();
    this.sessions.delete(sessionId);
  }
}

function createDefaultLocalModelAdapter(
  params: LocalModelSessionStartParams,
): WorkerLocalModelAdapter {
  if (params.endpointProvider === 'ollama') {
    assertEndpointId(params.endpointProvider, params.endpointId, 'ollama');
    const url = new URL(OLLAMA_LOCAL_BASE_URL);
    return new OllamaCliAdapter({
      model: params.modelId,
      host: url.hostname,
      port: Number(url.port || 11434),
      systemPrompt: params.systemPrompt,
      workingDir: params.workingDirectory,
    });
  }

  assertEndpointId(params.endpointProvider, params.endpointId, 'openai-compatible');
  return new OpenAICompatibleChatAdapter({
    baseUrl: LMSTUDIO_LOCAL_BASE_URL,
    model: params.modelId,
    systemPrompt: params.systemPrompt,
    workingDir: params.workingDirectory,
  });
}

function assertEndpointId(
  provider: LocalModelEndpointProvider,
  endpointId: string,
  expected: string,
): void {
  if (endpointId !== expected) {
    throw new Error(`Unsupported ${provider} endpoint id on worker: ${endpointId}`);
  }
}
