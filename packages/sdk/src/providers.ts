// Re-export the normalized runtime event contract from @contracts.
// SDK consumers should prefer these types for new integrations.
export type {
  ProviderRuntimeEvent,
  ProviderRuntimeEventEnvelope,
  ProviderEventKind,
  ProviderOutputEvent,
  ProviderToolUseEvent,
  ProviderToolResultEvent,
  ProviderStatusEvent,
  ProviderContextEvent,
  ProviderErrorEvent,
  ProviderExitEvent,
  ProviderSpawnedEvent,
  ProviderCompleteEvent,
} from '@contracts/types/provider-runtime-events';

export type ProviderType =
  | 'claude-cli'
  | 'anthropic-api'
  | 'openai'
  | 'openai-compatible'
  | 'ollama'
  | 'google'
  | 'amazon-bedrock'
  | 'azure';

export interface ProviderCapabilities {
  toolExecution: boolean;
  streaming: boolean;
  multiTurn: boolean;
  vision: boolean;
  fileAttachments: boolean;
  functionCalling: boolean;
  builtInCodeTools: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderType;
  contextWindow: number;
  maxOutputTokens: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  capabilities: Partial<ProviderCapabilities>;
}

export interface ProviderConfig {
  type: ProviderType;
  name: string;
  enabled: boolean;
  apiKey?: string;
  apiEndpoint?: string;
  defaultModel?: string;
  models?: ModelInfo[];
  options?: Record<string, unknown>;
}

export interface ProviderStatus {
  type: ProviderType;
  available: boolean;
  authenticated: boolean;
  error?: string;
  models?: ModelInfo[];
}

export interface ProviderAttachment {
  type: 'image' | 'file' | 'code';
  name: string;
  mimeType: string;
  data: string;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
  estimatedCost?: number;
}

/**
 * Legacy provider event type.
 *
 * @deprecated Use {@link ProviderRuntimeEvent} from `@contracts/types` instead.
 * The contracts-based type provides richer, provider-agnostic event coverage.
 * This type is retained for backward compatibility and will be removed in a
 * future version.
 */
export interface ProviderSessionOptions {
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  workingDirectory: string;
  sessionId?: string;
  resume?: boolean;
  toolsEnabled?: boolean;
  yoloMode?: boolean;
}

export interface ProviderOutputMessage {
  id: string;
  timestamp: number;
  type: 'assistant' | 'user' | 'system' | 'tool_use' | 'tool_result' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
}

export type ProviderInstanceStatus =
  | 'initializing'
  | 'ready'
  | 'idle'
  | 'busy'
  | 'waiting_for_input'
  | 'respawning'
  | 'hibernating'
  | 'hibernated'
  | 'waking'
  | 'degraded'
  | 'error'
  | 'failed'
  | 'terminated';

export interface ProviderContextUsage {
  used: number;
  total: number;
  percentage: number;
  cumulativeTokens?: number;
  costEstimate?: number;
}

export interface ProviderEvents {
  output: (message: ProviderOutputMessage) => void;
  status: (status: ProviderInstanceStatus) => void;
  context: (usage: ProviderContextUsage) => void;
  error: (error: Error) => void;
  exit: (code: number | null, signal: string | null) => void;
  spawned: (pid: number | null) => void;
}

export abstract class BaseProvider {
  protected config: ProviderConfig;
  protected sessionId: string;
  protected isActive = false;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.sessionId = '';
  }

  abstract getType(): ProviderType;
  abstract getCapabilities(): ProviderCapabilities;
  abstract checkStatus(): Promise<ProviderStatus>;
  abstract initialize(options: ProviderSessionOptions): Promise<void>;
  abstract sendMessage(message: string, attachments?: ProviderAttachment[]): Promise<void>;
  abstract terminate(graceful?: boolean): Promise<void>;

  getSessionId(): string {
    return this.sessionId;
  }

  isRunning(): boolean {
    return this.isActive;
  }

  getUsage(): ProviderUsage | null {
    return null;
  }

  getPid(): number | null {
    return null;
  }
}

export type ProviderFactory = (config: ProviderConfig) => BaseProvider;
