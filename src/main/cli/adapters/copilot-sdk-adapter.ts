/**
 * Copilot SDK Adapter - Wraps @github/copilot-sdk for orchestrator integration
 *
 * Unlike other adapters that spawn CLI processes directly, this uses the SDK
 * which manages the Copilot CLI process internally via JSON-RPC.
 */

import { EventEmitter } from 'events';
import { resolve, dirname, join } from 'path';
import { pathToFileURL } from 'url';
import type {
  OutputMessage,
  ContextUsage,
  InstanceStatus,
  ThinkingContent
} from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { extractThinkingContent } from '../../../shared/utils/thinking-extractor';

// Import SDK types dynamically to handle cases where SDK is not installed
type CopilotClientType = import('@github/copilot-sdk').CopilotClient;
type CopilotSessionType = import('@github/copilot-sdk').CopilotSession;

// Cache the SDK module once loaded
let cachedSdk: { CopilotClient: new (options?: any) => CopilotClientType } | null = null;

/**
 * Find the SDK directory by walking up from node_modules
 * This avoids using require.resolve which is blocked by the SDK's exports field
 */
function findSdkPath(): string {
  // Start from this file's directory and find node_modules/@github/copilot-sdk
  let currentDir = __dirname;

  // Walk up to find node_modules
  while (currentDir !== dirname(currentDir)) {
    const sdkPath = join(currentDir, 'node_modules', '@github', 'copilot-sdk', 'dist', 'index.js');
    try {
      require('fs').accessSync(sdkPath);
      return sdkPath;
    } catch {
      currentDir = dirname(currentDir);
    }
  }

  // Fallback: try from process.cwd()
  const cwdSdkPath = join(process.cwd(), 'node_modules', '@github', 'copilot-sdk', 'dist', 'index.js');
  return cwdSdkPath;
}

/**
 * Helper to dynamically import the Copilot SDK ESM module from CommonJS context
 * The SDK is ESM-only, so we need to import it via file:// URL
 * We use indirect eval to prevent TypeScript from transpiling import() to require()
 */
async function importCopilotSdk(): Promise<{ CopilotClient: new (options?: any) => CopilotClientType }> {
  if (cachedSdk) {
    return cachedSdk;
  }

  // Find the SDK path without using require.resolve (which is blocked by exports)
  const sdkIndexPath = findSdkPath();
  const sdkUrl = pathToFileURL(sdkIndexPath).href;

  console.log('[CopilotSdkAdapter] Importing SDK from:', sdkUrl);

  try {
    // Use indirect eval to create a real ESM import that TypeScript won't transpile to require()
    // This is the only reliable way to load ESM modules from CommonJS in Node.js
    // The (0, eval) pattern ensures it runs in global scope
    const importModule = (0, eval)('(async (u) => await import(u))') as (url: string) => Promise<any>;
    const sdk = await importModule(sdkUrl);
    cachedSdk = sdk;
    console.log('[CopilotSdkAdapter] SDK loaded successfully');
    return sdk;
  } catch (error) {
    console.error('[CopilotSdkAdapter] Failed to import SDK:', error);
    throw new Error(`Failed to load Copilot SDK: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * CLI capabilities interface (matching base-cli-adapter pattern)
 */
export interface CliCapabilities {
  streaming: boolean;
  toolUse: boolean;
  fileAccess: boolean;
  shellExecution: boolean;
  multiTurn: boolean;
  vision: boolean;
  codeExecution: boolean;
  contextWindow: number;
  outputFormats: string[];
}

/**
 * CLI status interface
 */
export interface CliStatus {
  available: boolean;
  version?: string;
  authenticated?: boolean;
  path?: string;
  error?: string;
}

/**
 * Copilot SDK configuration
 */
export interface CopilotSdkConfig {
  /** Model to use (gpt-5, claude-sonnet-4.5, etc.) */
  model?: string;
  /** Working directory */
  workingDir?: string;
  /** System prompt */
  systemPrompt?: string;
  /** YOLO mode (auto-approve all actions) */
  yoloMode?: boolean;
  /** Timeout in milliseconds */
  timeout?: number;
}

/**
 * Events emitted by CopilotSdkAdapter
 */
export interface CopilotSdkAdapterEvents {
  output: (message: OutputMessage) => void;
  status: (status: InstanceStatus) => void;
  context: (usage: ContextUsage) => void;
  error: (error: Error) => void;
  exit: (code: number | null, signal: string | null) => void;
  spawned: (pid: number) => void;
}

/**
 * Copilot SDK Adapter - Implementation using @github/copilot-sdk
 */
export class CopilotSdkAdapter extends EventEmitter {
  private client: CopilotClientType | null = null;
  private session: CopilotSessionType | null = null;
  private config: CopilotSdkConfig;
  private sessionId: string;
  private isSpawned: boolean = false;
  private totalTokensUsed: number = 0;
  private unsubscribeFromSession: (() => void) | null = null;

  constructor(config: CopilotSdkConfig = {}) {
    super();
    this.config = config;
    this.sessionId = `copilot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  getName(): string {
    return 'copilot-sdk';
  }

  getCapabilities(): CliCapabilities {
    return {
      streaming: true,
      toolUse: true,
      fileAccess: true,
      shellExecution: true,
      multiTurn: true,
      vision: true,
      codeExecution: true,
      contextWindow: 128000,
      outputFormats: ['text', 'json']
    };
  }

  async checkStatus(): Promise<CliStatus> {
    try {
      // Dynamically import the SDK using helper for ESM/CommonJS interop
      const { CopilotClient } = await importCopilotSdk();

      // Try to create a temporary client to verify CLI availability
      const testClient = new CopilotClient({ autoStart: false });

      try {
        await testClient.start();
        const status = await testClient.getStatus();
        const authStatus = await testClient.getAuthStatus();
        await testClient.stop();

        return {
          available: true,
          version: status.version,
          authenticated: authStatus.isAuthenticated,
          path: 'copilot'
        };
      } catch (err) {
        // Try to stop the client in case it partially started
        try { await testClient.stop(); } catch { /* ignore */ }
        throw err;
      }
    } catch (error) {
      return {
        available: false,
        error:
          error instanceof Error ? error.message : 'Copilot CLI not available'
      };
    }
  }

  async spawn(): Promise<number> {
    if (this.isSpawned) {
      throw new Error('Adapter already spawned');
    }

    console.log('[CopilotSdkAdapter] spawn() called with config:', {
      workingDir: this.config.workingDir,
      model: this.config.model,
      hasSystemPrompt: !!this.config.systemPrompt,
      yoloMode: this.config.yoloMode,
      timeout: this.config.timeout
    });

    try {
      // Dynamically import the SDK using helper for ESM/CommonJS interop
      console.log('[CopilotSdkAdapter] Importing @github/copilot-sdk...');
      const { CopilotClient } = await importCopilotSdk();
      console.log('[CopilotSdkAdapter] SDK imported successfully');

      // Create the Copilot client
      console.log('[CopilotSdkAdapter] Creating CopilotClient...');
      const client = new CopilotClient({
        autoStart: true,
        autoRestart: true,
        cwd: this.config.workingDir
      });
      this.client = client;
      console.log('[CopilotSdkAdapter] CopilotClient created');

      // Start the client
      console.log('[CopilotSdkAdapter] Starting client...');
      await client.start();
      console.log('[CopilotSdkAdapter] Client started successfully');

      // Create a session with streaming enabled
      console.log('[CopilotSdkAdapter] Creating session with model:', this.config.model || 'gpt-4');
      const session = await client.createSession({
        model: this.config.model || 'gpt-4',
        systemMessage: this.config.systemPrompt
          ? {
              mode: 'append' as const,
              content: this.config.systemPrompt
            }
          : undefined,
        streaming: true
      });
      this.session = session;
      console.log('[CopilotSdkAdapter] Session created with ID:', session.sessionId);

      // Set up event forwarding from SDK to orchestrator events
      this.setupEventForwarding();

      this.isSpawned = true;

      // Generate a fake PID since SDK doesn't expose the underlying process PID
      const fakePid = Math.floor(Math.random() * 100000) + 10000;
      console.log('[CopilotSdkAdapter] Spawn complete, fake PID:', fakePid);
      this.emit('spawned', fakePid);
      this.emit('status', 'idle' as InstanceStatus);

      return fakePid;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      console.error('[CopilotSdkAdapter] spawn() failed:', errorMessage);
      console.error('[CopilotSdkAdapter] Error stack:', errorStack);

      // Provide a more helpful error message for common issues
      let userFriendlyError = errorMessage;
      if (errorMessage.includes('ENOENT') || errorMessage.includes('spawn copilot')) {
        userFriendlyError = 'GitHub Copilot CLI not found. Please install it with: npm install -g @github/copilot-cli';
      } else if (errorMessage.includes('Failed to start CLI server')) {
        userFriendlyError = 'Failed to start Copilot CLI server. Make sure the Copilot CLI is properly installed and you are authenticated with GitHub.';
      } else if (errorMessage.includes('protocol version mismatch')) {
        userFriendlyError = 'Copilot CLI version mismatch. Please update the CLI with: npm update -g @github/copilot-cli';
      }

      this.emit('error', new Error(`Failed to spawn Copilot: ${userFriendlyError}`));
      throw new Error(userFriendlyError);
    }
  }

  // Track if we've received streaming deltas for the current message
  private hasReceivedStreamingDeltas = false;
  // Accumulate streaming content for a single message
  private streamingMessageId: string | null = null;
  private streamingContent = '';
  // Track reasoning/thinking for the current message
  private currentMessageReasoning: ThinkingContent[] = [];

  private setupEventForwarding(): void {
    if (!this.session) return;

    this.unsubscribeFromSession = this.session.on((event) => {
      switch (event.type) {
        case 'assistant.message':
          // Complete message received
          // Only emit if we haven't been streaming (to avoid duplicate content)
          if (!this.hasReceivedStreamingDeltas) {
            // Also extract any inline thinking from content
            const extracted = extractThinkingContent(event.data.content);
            const allThinking = [
              ...this.currentMessageReasoning,
              ...extracted.thinking.map(t => ({
                ...t,
                timestamp: Date.now()
              }))
            ];

            const outputMessage: OutputMessage = {
              id: generateId(),
              timestamp: Date.now(),
              type: 'assistant',
              content: extracted.response,
              // Include all thinking blocks
              thinking: allThinking.length > 0 ? allThinking : undefined,
              thinkingExtracted: true
            };
            this.emit('output', outputMessage);
          }
          // Reset streaming state for next message
          this.hasReceivedStreamingDeltas = false;
          this.streamingMessageId = null;
          this.streamingContent = '';
          this.currentMessageReasoning = []; // Reset reasoning
          this.emit('status', 'idle' as InstanceStatus);
          break;

        case 'assistant.message_delta':
          // Streaming delta - emit as partial output
          if (event.data.deltaContent) {
            this.hasReceivedStreamingDeltas = true;
            // Use the same message ID for all deltas in one message
            if (!this.streamingMessageId) {
              this.streamingMessageId = generateId();
            }
            this.streamingContent += event.data.deltaContent;

            // Extract thinking from accumulated content
            const extracted = extractThinkingContent(this.streamingContent);
            const allThinking = [...this.currentMessageReasoning, ...extracted.thinking];

            this.emit('output', {
              id: this.streamingMessageId,
              timestamp: Date.now(),
              type: 'assistant',
              content: event.data.deltaContent,
              metadata: { streaming: true, accumulatedContent: extracted.response },
              thinking: allThinking.length > 0 ? allThinking : undefined,
              thinkingExtracted: true
            } as OutputMessage);
          }
          break;

        case 'tool.execution_start':
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_use',
            content: `Using tool: ${event.data.toolName}`,
            metadata: { toolName: event.data.toolName, toolCallId: event.data.toolCallId }
          } as OutputMessage);
          break;

        case 'tool.execution_complete':
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_result',
            content: event.data.success ? 'Tool completed successfully' : 'Tool failed',
            metadata: { toolCallId: event.data.toolCallId, success: event.data.success }
          } as OutputMessage);
          break;

        case 'session.idle':
          this.emit('status', 'idle' as InstanceStatus);
          break;

        case 'session.error':
          this.emit('error', new Error(event.data.message));
          break;

        case 'assistant.reasoning':
          // Capture reasoning as thinking content (will be included in next message)
          if (event.data.content) {
            this.currentMessageReasoning.push({
              id: generateId(),
              content: event.data.content,
              format: 'sdk',
              timestamp: Date.now()
            });
            console.log('[CopilotSdkAdapter] Captured reasoning block, total:', this.currentMessageReasoning.length);
          }
          break;

        case 'assistant.usage':
          // Update token usage
          if (event.data.inputTokens || event.data.outputTokens) {
            this.totalTokensUsed += (event.data.inputTokens || 0) + (event.data.outputTokens || 0);
            const contextUsage: ContextUsage = {
              used: this.totalTokensUsed,
              total: 128000,
              percentage: Math.min((this.totalTokensUsed / 128000) * 100, 100)
            };
            this.emit('context', contextUsage);
          }
          break;
      }
    });
  }

  async sendInput(message: string, attachments?: { name: string; type?: string; mimeType?: string; data?: string; path?: string }[]): Promise<void> {
    console.log('[CopilotSdkAdapter] sendInput called:', {
      messageLength: message?.length,
      attachmentsCount: attachments?.length,
      isSpawned: this.isSpawned,
      hasSession: !!this.session
    });

    if (!this.isSpawned || !this.session) {
      const error = new Error('Adapter not spawned - call spawn() first');
      console.error('[CopilotSdkAdapter] sendInput failed:', error.message);
      throw error;
    }

    this.emit('status', 'busy' as InstanceStatus);

    try {
      // Build the message options
      const messageOptions: { prompt: string; attachments?: { type: 'file' | 'directory'; path: string; displayName?: string }[] } = {
        prompt: message
      };

      if (attachments?.length) {
        // Filter to only include attachments with valid paths
        const validAttachments = attachments.filter(a => a.path);
        if (validAttachments.length > 0) {
          messageOptions.attachments = validAttachments.map((a) => ({
            type: 'file' as const,
            path: a.path!,
            displayName: a.name
          }));
        }
      }

      console.log('[CopilotSdkAdapter] Calling session.sendAndWait with timeout:', this.config.timeout || 60000);
      // Send and wait for completion with configured timeout
      const result = await this.session.sendAndWait(messageOptions, this.config.timeout || 60000);
      console.log('[CopilotSdkAdapter] sendAndWait completed, result:', result ? 'has content' : 'no content');

      // Context usage is updated via the assistant.usage event
    } catch (error) {
      console.error('[CopilotSdkAdapter] sendInput error:', error instanceof Error ? error.message : String(error));
      const errorMessage: OutputMessage = {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error',
        content: error instanceof Error ? error.message : String(error)
      };
      this.emit('output', errorMessage);
      this.emit('status', 'error' as InstanceStatus);
      this.emit(
        'error',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  interrupt(): boolean {
    // The SDK doesn't have a direct abort method on the session
    // Best we can do is destroy and recreate
    if (!this.session || !this.client) return false;

    try {
      // Destroy current session and recreate
      this.session.destroy().catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  async terminate(graceful: boolean = true): Promise<void> {
    // Unsubscribe from session events
    if (this.unsubscribeFromSession) {
      this.unsubscribeFromSession();
      this.unsubscribeFromSession = null;
    }

    // Destroy session
    if (this.session) {
      try {
        await this.session.destroy();
      } catch {
        // Ignore errors during cleanup
      }
    }

    // Stop client
    if (this.client) {
      try {
        if (graceful) {
          await this.client.stop();
        } else {
          await this.client.forceStop();
        }
      } catch {
        // Ignore errors during cleanup
      }
    }

    this.client = null;
    this.session = null;
    this.isSpawned = false;
    this.totalTokensUsed = 0;
    this.currentMessageReasoning = [];

    this.emit('exit', 0, null);
  }

  getSessionId(): string {
    return this.sessionId;
  }

  isRunning(): boolean {
    return this.isSpawned && this.client !== null;
  }

  getPid(): number | null {
    // SDK doesn't expose the underlying process PID
    return null;
  }

  /**
   * Lists available models from the Copilot CLI.
   * Requires the CLI to be authenticated.
   * @returns Array of available model info from the SDK
   */
  async listAvailableModels(): Promise<CopilotModelInfo[]> {
    try {
      const { CopilotClient } = await importCopilotSdk();

      // If we already have a client, use it
      if (this.client) {
        const models = await this.client.listModels();
        return models.map((m: any) => ({
          id: m.id,
          name: m.name,
          supportsVision: m.capabilities?.supports?.vision ?? false,
          contextWindow: m.capabilities?.limits?.max_context_window_tokens ?? 128000,
          enabled: m.policy?.state === 'enabled'
        }));
      }

      // Otherwise create a temporary client to fetch models
      const tempClient = new CopilotClient({ autoStart: false });
      try {
        await tempClient.start();
        const models = await tempClient.listModels();
        await tempClient.stop();
        return models.map((m: any) => ({
          id: m.id,
          name: m.name,
          supportsVision: m.capabilities?.supports?.vision ?? false,
          contextWindow: m.capabilities?.limits?.max_context_window_tokens ?? 128000,
          enabled: m.policy?.state === 'enabled'
        }));
      } catch (err) {
        try { await tempClient.stop(); } catch { /* ignore */ }
        throw err;
      }
    } catch (error) {
      console.error('[CopilotSdkAdapter] Failed to list models:', error);
      // Return default models if we can't fetch from the CLI
      return COPILOT_DEFAULT_MODELS;
    }
  }
}

/**
 * Simplified model info for orchestrator use
 */
export interface CopilotModelInfo {
  id: string;
  name: string;
  supportsVision: boolean;
  contextWindow: number;
  enabled: boolean;
}

/**
 * Default Copilot models (used as fallback when CLI is unavailable)
 * These are the latest and best models available through GitHub Copilot
 */
export const COPILOT_DEFAULT_MODELS: CopilotModelInfo[] = [
  // Flagship tier - latest and best models
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', supportsVision: true, contextWindow: 200000, enabled: true },
  { id: 'o3', name: 'OpenAI o3', supportsVision: true, contextWindow: 200000, enabled: true },
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro', supportsVision: true, contextWindow: 2000000, enabled: true },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', supportsVision: true, contextWindow: 2000000, enabled: true },
  // High performance tier
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', supportsVision: true, contextWindow: 200000, enabled: true },
  { id: 'gpt-4o', name: 'GPT-4o', supportsVision: true, contextWindow: 128000, enabled: true },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', supportsVision: true, contextWindow: 1000000, enabled: true },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', supportsVision: true, contextWindow: 1000000, enabled: true },
  // Fast tier
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', supportsVision: true, contextWindow: 200000, enabled: true },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', supportsVision: true, contextWindow: 128000, enabled: true },
  { id: 'gemini-2.0-flash-lite', name: 'Gemini Flash Lite', supportsVision: true, contextWindow: 1000000, enabled: true },
];
