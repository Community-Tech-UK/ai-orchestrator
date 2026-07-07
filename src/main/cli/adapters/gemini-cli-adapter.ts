/**
 * Gemini CLI Adapter - Spawns and manages Google Gemini CLI processes
 * https://github.com/google-gemini/gemini-cli
 *
 * Uses positional prompt for non-interactive mode with JSON output.
 * Also provides spawn/sendInput interface for compatibility with InstanceManager.
 */

import {
  BaseCliAdapter,
  AdapterRuntimeCapabilities,
  CliAdapterConfig,
  CliCapabilities,
  CliStatus,
  CliMessage,
  CliResponse,
  CliToolCall,
  CliUsage,
  type ResumeAttemptResult,
} from './base-cli-adapter';
import { rmSync } from 'fs';
import { dirname } from 'path';
import { getLogger } from '../../logging/logger';
import type {
  OutputMessage,
  ContextUsage,
  InstanceStatus,
  FileAttachment
} from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { computeTokenCost } from '../../../shared/data/model-pricing';
import { extractThinkingContent, ThinkingBlock } from '../../../shared/utils/thinking-extractor';
import { wrapRtkAwareness } from '../rtk/rtk-awareness';
import {
  geminiApiErrorMessage,
  geminiAssistantText,
  geminiErrorText,
  geminiEventType,
  geminiResultText,
  geminiToolName,
  geminiUsageTotals,
  logGeminiParseFailure,
  parseGeminiNdjsonEvent,
  parseGeminiStreamingEvent,
} from './gemini-json';
import { probeVersionStatus } from './cli-status-probe';

const logger = getLogger('GeminiCliAdapter');

/**
 * Gemini CLI specific configuration
 */
export interface GeminiCliConfig {
  /** Model to use (gemini-3.1-pro-preview, gemini-3-pro-preview, gemini-3-flash-preview, gemini-2.5-pro, etc.) */
  model?: string;
  /** Run in sandbox mode */
  sandbox?: boolean;
  /** Working directory */
  workingDir?: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Auto-approve mode (YOLO) */
  yolo?: boolean;
  /** Output format: text, json, stream-json */
  outputFormat?: 'text' | 'json' | 'stream-json';
  /** System prompt */
  systemPrompt?: string;
  /** Extra environment variables for Gemini CLI subprocesses. */
  env?: Record<string, string>;
  /** Temporary Browser Gateway settings path created by the adapter factory. */
  browserGatewaySettingsPath?: string;
  /** Alias for yolo (used by adapter factory) */
  yoloMode?: boolean;
  /** When true, prepend the RTK awareness prompt to message content so the
   *  model prefixes shell commands with `rtk`. Gemini runs exec-per-message
   *  so the awareness is reinjected on every call (it's small — ~500 chars). */
  rtkEnabled?: boolean;
}

/**
 * Events emitted by GeminiCliAdapter (for InstanceManager compatibility)
 */
export interface GeminiCliAdapterEvents {
  output: (message: OutputMessage) => void;
  status: (status: InstanceStatus) => void;
  context: (usage: ContextUsage) => void;
  error: (error: Error) => void;
  exit: (code: number | null, signal: string | null) => void;
  spawned: (pid: number) => void;
}

/**
 * Gemini CLI Adapter - Implementation for Google Gemini CLI
 */
export class GeminiCliAdapter extends BaseCliAdapter {
  private cliConfig: GeminiCliConfig;
  private readonly browserGatewaySettingsPath?: string;
  /** Running total of tokens used across all turns */
  private cumulativeTokensUsed = 0;
  /**
   * Running USD cost across all turns. Gemini's CLI reports no dollar cost, so
   * we price the real per-turn input/output split with the shared pricing table
   * and surface the cumulative total via `costEstimate` on context events.
   */
  private cumulativeCostUsd = 0;

  constructor(config: GeminiCliConfig = {}) {
    const adapterConfig: CliAdapterConfig = {
      command: 'gemini',
      args: [],
      cwd: config.workingDir,
      timeout: config.timeout || 300000,
      env: config.env,
      sessionPersistence: true
    };
    super(adapterConfig);

    // Handle yoloMode alias
    this.cliConfig = {
      ...config,
      yolo: config.yolo ?? config.yoloMode
    };
    this.browserGatewaySettingsPath = config.browserGatewaySettingsPath;
    this.sessionId = `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // ============ BaseCliAdapter Abstract Implementations ============

  getName(): string {
    return 'gemini-cli';
  }

  getCapabilities(): CliCapabilities {
    return {
      streaming: true,
      toolUse: true,
      fileAccess: true,
      shellExecution: true,
      multiTurn: true,
      vision: false, // Attachment-based vision is not wired in orchestrator mode
      codeExecution: true,
      contextWindow: 1000000, // Gemini Pro has 1M+ context
      outputFormats: ['text', 'json', 'markdown']
    };
  }

  override getRuntimeCapabilities(): AdapterRuntimeCapabilities {
    return {
      supportsResume: false,
      supportsForkSession: false,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
    };
  }

  getResumeAttemptResult(): ResumeAttemptResult | null {
    return null; // Gemini is stateless and does not support native resume
  }

  async checkStatus(): Promise<CliStatus> {
    return probeVersionStatus({
      spawn: () => this.spawnProcess(['--version']),
      path: 'gemini',
      timeoutError: 'Timeout checking Gemini CLI',
      spawnError: (err) => `Failed to spawn gemini: ${err.message}`,
      unavailableError: ({ output }) => `Gemini CLI not found or not configured: ${output}`,
      isAvailable: ({ code, output }) => code === 0 || output.includes('gemini'),
      authenticated: ({ output }) => !output.includes('not authenticated'),
    });
  }

  async sendMessage(message: CliMessage): Promise<CliResponse> {
    if (message.attachments && message.attachments.length > 0) {
      throw new Error('Gemini adapter does not currently support attachments in orchestrator mode.');
    }

    const startTime = Date.now();
    this.outputBuffer = '';

    return new Promise((resolve, reject) => {
      const args = this.buildArgs(message);
      this.process = this.spawnProcess(args);

      // Handle spawn errors (e.g., ENOENT when binary doesn't exist)
      this.process.on('error', (err) => {
        this.process = null;
        reject(new Error(`Failed to spawn gemini CLI: ${err.message}`));
      });

      // Gemini uses positional prompt, close stdin
      if (this.process.stdin) {
        this.process.stdin.end();
      }

      // Track streaming state for this response - use consistent ID and accumulate content
      const streamingMessageId = generateId();
      let accumulatedContent = '';

      this.process.stdout?.on('data', (data) => {
        const chunk = data.toString();
        this.outputBuffer += chunk;

        // Parse stream-json output and extract content
        const lines = chunk.split('\n').filter((l: string) => l.trim());
        for (const line of lines) {
          try {
            const event = parseGeminiNdjsonEvent(line);
            if (!event) {
              logGeminiParseFailure(logger, line);
              throw new Error('Invalid JSON stream line');
            }
            // Handle Gemini stream-json event types.
            // Primary content events:
            //   {"type":"message","role":"assistant","content":"..."}
            //   {"type":"text","text":"..."}
            const newContent = geminiAssistantText(event);

            if (newContent) {
              accumulatedContent += newContent;
              this.emit('output', {
                id: streamingMessageId,
                timestamp: Date.now(),
                type: 'assistant',
                content: newContent,
                metadata: {
                  streaming: true,
                  accumulatedContent
                }
              } as OutputMessage);
              continue;
            }

            // Tool activity events — surface as tool_use / tool_result so the
            // orchestrator (and child summary builder) can see what the model
            // was actually doing. Without this, a Gemini child that only ran
            // tools and hit an error never produces any visible output and
            // shows up to the parent as "Child exited without producing any
            // output." The exact event shape varies across gemini-cli
            // versions, so we accept several common variants.
            const eventType = geminiEventType(event);
            if (
              eventType === 'tool_call' ||
              eventType === 'tool_use' ||
              eventType === 'tool.execution_start'
            ) {
              const toolName = geminiToolName(event);
              this.emit('output', {
                id: generateId(),
                timestamp: Date.now(),
                type: 'tool_use',
                content: `Using tool: ${toolName}`,
                metadata: { toolName, raw: event },
              } as OutputMessage);
              continue;
            }

            // Tool failures — explicit error variants first, then generic
            // tool_result events that carry an error payload.
            if (
              eventType === 'tool_error' ||
              eventType === 'tool.execution_error' ||
              (eventType === 'tool_result' && event['error'] !== undefined && event['error'] !== null)
            ) {
              const toolName = geminiToolName(event);
              const errText = geminiErrorText(event);
              const content = `Tool ${toolName} failed: ${errText}`;
              this.emit('output', {
                id: generateId(),
                timestamp: Date.now(),
                type: 'error',
                content,
                metadata: { toolName, raw: event },
              } as OutputMessage);
              continue;
            }

            if (
              eventType === 'tool_result' ||
              eventType === 'tool.execution_complete'
            ) {
              const toolName = geminiToolName(event);
              const resultText = geminiResultText(event);
              this.emit('output', {
                id: generateId(),
                timestamp: Date.now(),
                type: 'tool_result',
                content: `Tool ${toolName}: ${resultText.slice(0, 500)}`,
                metadata: { toolName, raw: event },
              } as OutputMessage);
              continue;
            }

            // Generic error events that aren't tool-scoped.
            if (eventType === 'error' || (eventType === 'result' && event['status'] === 'error')) {
              const errText = geminiErrorText(event);
              this.emit('output', {
                id: generateId(),
                timestamp: Date.now(),
                type: 'error',
                content: errText,
                metadata: { raw: event },
              } as OutputMessage);
              continue;
            }
          } catch {
            // Not JSON, emit raw if it looks like content
            if (
              line.trim() &&
              !line.startsWith('{') &&
              !line.includes('YOLO mode')
            ) {
              accumulatedContent += line;
              this.emit('output', {
                id: streamingMessageId,
                timestamp: Date.now(),
                type: 'assistant',
                content: line,
                metadata: {
                  streaming: true,
                  accumulatedContent
                }
              } as OutputMessage);
            }
          }
        }
      });

      this.process.stderr?.on('data', (data) => {
        const errorStr = data.toString();
        const trimmed = errorStr.trim();
        if (!trimmed) return;

        // Surface stderr as a visible error message in the buffer so the
        // parent instance (and handleChildExit's summary fallback) can see
        // why the child failed. Without this, Gemini tool errors written to
        // stderr vanish entirely. Treat anything that looks like an error
        // as an `error` output so it's both visible and captured by the
        // child-result storage fallback path.
        const looksLikeError =
          /error|fatal|failed|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|Exception/i.test(trimmed);

        if (looksLikeError) {
          const error = new Error(trimmed);
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'error',
            content: trimmed.slice(0, 2000),
          } as OutputMessage);
          this.emitErrorIfObserved(error);
        } else {
          // Non-error stderr (debug banners, version notices). Still surface
          // in case it contains useful diagnostic info, but as a system note
          // rather than an error.
          logger.debug('gemini stderr', { text: trimmed.slice(0, 500) });
        }
      });

      this.process.on('close', (code) => {
        const duration = Date.now() - startTime;

        // Check for API error in stream-json output (e.g., ModelNotFoundError)
        const apiError = this.extractApiError(this.outputBuffer);
        if (apiError) {
          this.emitErrorIfObserved(new Error(apiError));
          this.emit('output', {
            id: streamingMessageId,
            timestamp: Date.now(),
            type: 'error',
            content: apiError,
          } as OutputMessage);
          this.process = null;
          reject(new Error(apiError));
          return;
        }

        if (code === 0 || this.outputBuffer) {
          const response = this.parseOutput(this.outputBuffer);
          response.usage = {
            ...response.usage,
            duration
          };
          this.completeResponse(response);
          resolve(response);
        } else {
          reject(new Error(`Gemini exited with code ${code}`));
        }
        this.process = null;
      });

      // Timeout handling
      const timeout = setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGTERM');
          reject(new Error('Gemini CLI timeout'));
        }
      }, this.config.timeout);

      this.process.on('close', () => clearTimeout(timeout));
    });
  }

  async *sendMessageStream(message: CliMessage): AsyncIterable<string> {
    const args = this.buildArgs(message);
    this.process = this.spawnProcess(args);

    // Handle spawn errors (e.g., ENOENT when binary doesn't exist)
    let spawnError: Error | null = null;
    this.process.on('error', (err) => {
      spawnError = new Error(`Failed to spawn gemini CLI: ${err.message}`);
      this.emitErrorIfObserved(spawnError);
      this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error',
        content: spawnError.message,
      } as OutputMessage);
      this.process = null;
    });

    // Gemini uses positional prompt, close stdin
    if (this.process.stdin) {
      this.process.stdin.end();
    }

    const stdout = this.process.stdout;
    if (!stdout) return;

    for await (const chunk of stdout) {
      if (spawnError) return;
      const chunkStr = chunk.toString();
      // Parse stream-json and extract content
      const lines = chunkStr.split('\n').filter((l: string) => l.trim());
      for (const line of lines) {
        try {
          const event = parseGeminiNdjsonEvent(line);
          if (!event) {
            logGeminiParseFailure(logger, line);
            throw new Error('Invalid JSON stream line');
          }
          // Assistant messages: {"type":"message","role":"assistant","content":"..."}
          const text = geminiAssistantText(event);
          if (text) {
            yield text;
          }
        } catch {
          // Not JSON, yield if it looks like content
          if (
            line.trim() &&
            !line.startsWith('{') &&
            !line.includes('YOLO mode')
          ) {
            yield line;
          }
        }
      }
    }
  }

  parseOutput(raw: string): CliResponse & { thinking?: ThinkingBlock[] } {
    const id = this.generateResponseId();
    const toolCalls = this.extractToolCalls(raw);
    const content =
      this.extractContentFromStreamJson(raw) || this.cleanContent(raw);
    const usage = this.extractUsage(raw);

    // Extract thinking content from the response
    const extracted = extractThinkingContent(content);

    return {
      id,
      content: extracted.response, // Use cleaned response without thinking
      role: 'assistant',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      raw,
      // Include thinking blocks if found
      thinking: extracted.thinking.length > 0 ? extracted.thinking : undefined
    };
  }

  /**
   * Extract content from Gemini stream-json output
   * Format: {"type":"message","role":"assistant","content":"..."}
   */
  private extractContentFromStreamJson(raw: string): string {
    const contentParts: string[] = [];
    const lines = raw.split('\n').filter((l) => l.trim());

    for (const line of lines) {
      try {
        const event = parseGeminiStreamingEvent(line);
        if (!event) {
          logGeminiParseFailure(logger, line);
          continue;
        }
        const text = geminiAssistantText(event);
        if (text) {
          contentParts.push(text);
        }
      } catch {
        /* intentionally ignored: non-JSON lines are skipped during output parsing */
      }
    }

    return contentParts.join('\n');
  }

  protected buildArgs(message: CliMessage): string[] {
    const args: string[] = [];

    // Model selection (optional - Gemini will use default if not specified)
    if (this.cliConfig.model) {
      args.push('--model', this.cliConfig.model);
    }

    // Output format for easier parsing
    args.push('--output-format', this.cliConfig.outputFormat || 'stream-json');

    // Sandbox mode
    if (this.cliConfig.sandbox) {
      args.push('--sandbox');
    }

    // YOLO mode (auto-approve all actions)
    if (this.cliConfig.yolo) {
      logger.warn('YOLO mode enabled for Gemini CLI instance', {
        sessionId: this.sessionId,
        model: this.cliConfig.model
      });
      args.push('--yolo');
    }

    // Handle attachments - Gemini doesn't have --file, but images work differently
    // Images would need to be handled via the prompt or a different mechanism

    // Add the prompt as positional argument (required for non-interactive mode).
    // When RTK is enabled, prepend the awareness block so the model prefixes
    // shell commands with `rtk`. Gemini has no programmatic PreToolUse hook;
    // each call is a fresh process so awareness is injected every turn.
    if (message.content) {
      const promptText = this.cliConfig.rtkEnabled
        ? `${wrapRtkAwareness()}\n\n${message.content}`
        : message.content;
      args.push(promptText);
    }

    return args;
  }

  // ============ Private Helper Methods ============

  private emitErrorIfObserved(error: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
      return;
    }

    logger.warn('Gemini CLI error without listener', { error: error.message });
  }

  /**
   * Check stream-json output for an API error result event.
   * Format: {"type":"result","status":"error","error":{"type":"Error","message":"..."}}
   * Returns the error message string if found, null otherwise.
   */
  private extractApiError(raw: string): string | null {
    const lines = raw.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      try {
        const event = parseGeminiNdjsonEvent(line);
        if (!event) {
          logGeminiParseFailure(logger, line);
          continue;
        }
        const apiError = geminiApiErrorMessage(event);
        if (apiError) {
          return apiError;
        }
      } catch {
        /* intentionally ignored: non-JSON lines are skipped during output parsing */
      }
    }
    return null;
  }

  private extractToolCalls(raw: string): CliToolCall[] {
    const toolCalls: CliToolCall[] = [];

    // Gemini tool patterns (based on typical CLI output format)
    // Pattern 1: ```tool\nfunctionName({...})\n```
    const toolPattern = /```tool\n(\w+)\(([\s\S]*?)\)\n```/g;
    let match;

    while ((match = toolPattern.exec(raw)) !== null) {
      try {
        toolCalls.push({
          id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: match[1],
          arguments: JSON.parse(match[2] || '{}')
        });
      } catch {
        toolCalls.push({
          id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: match[1],
          arguments: { raw: match[2] }
        });
      }
    }

    // Pattern 2: Function call blocks
    const funcPattern = /\[Function:\s*(\w+)\]\s*\n([\s\S]*?)\[\/Function\]/g;
    while ((match = funcPattern.exec(raw)) !== null) {
      try {
        toolCalls.push({
          id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: match[1],
          arguments: JSON.parse(match[2] || '{}')
        });
      } catch {
        toolCalls.push({
          id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: match[1],
          arguments: { raw: match[2] }
        });
      }
    }

    return toolCalls;
  }

  private cleanContent(raw: string): string {
    // Use the shared extractor for consistent handling of thinking content
    const { response } = extractThinkingContent(raw);

    // Also remove tool blocks and status prefixes
    return response
      .replace(/```tool\n[\s\S]*?\n```/g, '')
      .replace(/\[Function:\s*\w+\][\s\S]*?\[\/Function\]/g, '')
      .replace(/^\[.*?\]\s*/gm, '') // Remove status prefixes like [INFO], [DEBUG]
      .trim();
  }

  private extractUsage(raw: string): CliUsage {
    // Try to extract usage from Gemini stream-json events.
    // The Gemini CLI may emit token usage in several formats:
    //   1. {"type":"result","stats":{"total_tokens":N,"input_tokens":N,"output_tokens":N}}
    //   2. {"type":"result","usageMetadata":{"promptTokenCount":N,"candidatesTokenCount":N,"totalTokenCount":N}}
    //   3. {"type":"turn.completed","usage":{"input_tokens":N,"output_tokens":N}}
    //   4. Any event with a top-level "usage" object
    const lines = raw.split('\n').filter((l) => l.trim());

    for (const line of lines) {
      try {
        const event = parseGeminiNdjsonEvent(line);
        if (!event) {
          logGeminiParseFailure(logger, line);
          continue;
        }

        const usage = geminiUsageTotals(event);
        if (usage) {
          return usage;
        }
      } catch {
        /* intentionally ignored: non-JSON lines are skipped during token count parsing */
      }
    }

    // Fallback: estimate from content (both input and output)
    const outputTokens = this.estimateTokens(raw);
    return {
      inputTokens: 0,
      outputTokens,
      totalTokens: outputTokens
    };
  }

  // ============ InstanceManager Compatibility API ============
  // These methods provide the spawn/sendInput pattern expected by InstanceManager
  // Unlike Claude CLI which maintains a persistent process, Gemini runs exec per message

  private isSpawned = false;

  /**
   * "Spawn" the CLI adapter - marks it as ready to receive messages.
   * Unlike Claude CLI, Gemini doesn't maintain a persistent process.
   * Each sendInput() will exec a new command.
   */
  async spawn(): Promise<number> {
    if (this.isSpawned) {
      throw new Error('Adapter already spawned');
    }

    // Validate the Gemini CLI is available before claiming "spawned"
    const status = await this.checkStatus();
    if (!status.available) {
      throw new Error(`Gemini CLI not available: ${status.error || 'gemini command not found'}`);
    }

    this.isSpawned = true;
    // Use a stable fake PID (Gemini runs exec-per-message, no persistent process)
    const fakePid = Math.floor(Math.random() * 100000) + 10000;
    this.emit('spawned', fakePid);
    this.emit('status', 'idle' as InstanceStatus);

    return fakePid;
  }

  /**
   * Send a message to Gemini via exec command.
   * Each call spawns a new process.
   */
  protected override async sendInputImpl(message: string, attachments?: FileAttachment[]): Promise<void> {
    if (!this.isSpawned) {
      throw new Error('Adapter not spawned - call spawn() first');
    }

    if (attachments && attachments.length > 0) {
      throw new Error('Gemini adapter does not currently support attachments in orchestrator mode.');
    }

    this.emit('status', 'busy' as InstanceStatus);

    try {
      const cliMessage: CliMessage = {
        role: 'user',
        content: message,
      };

      // Execute the command
      // Note: sendMessage() already emits OutputMessages during streaming,
      // so we don't need to emit the final content again
      const response = await this.sendMessage(cliMessage);

      // Emit tool uses if any
      if (response.toolCalls) {
        for (const tool of response.toolCalls) {
          const toolMessage: OutputMessage = {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_use',
            content: `Using tool: ${tool.name}`,
            metadata: { ...tool } as Record<string, unknown>
          };
          this.emit('output', toolMessage);
        }
      }

      // Per-turn occupancy: Gemini's CLI reports input_tokens for this turn,
      // which already includes the full conversation history sent to the model.
      // Use that as `used` (NOT the cumulative lifetime spend) so the bar
      // reflects current context-window occupancy and doesn't grow unboundedly.
      if (response.usage) {
        const inputTokens = response.usage.inputTokens || 0;
        const outputTokens = response.usage.outputTokens || 0;
        const turnTokens = inputTokens || outputTokens
          ? inputTokens + outputTokens
          : (response.usage.totalTokens || 0);
        this.cumulativeTokensUsed += turnTokens;
        // Gemini's CLI reports no dollar cost, so price the real per-turn split
        // with the shared table and accumulate it for the context bar.
        this.cumulativeCostUsd += computeTokenCost(this.cliConfig.model, {
          inputTokens,
          outputTokens,
        });
        const contextWindow = this.getCapabilities().contextWindow;
        const used = Math.min(turnTokens, contextWindow);
        const contextUsage: ContextUsage = {
          used,
          total: contextWindow,
          percentage: contextWindow > 0 ? Math.min((used / contextWindow) * 100, 100) : 0,
          cumulativeTokens: this.cumulativeTokensUsed,
          costEstimate: this.cumulativeCostUsd,
        };
        this.emit('context', contextUsage);
      }

      this.emit('status', 'idle' as InstanceStatus);
    } catch (error) {
      const errorMessage: OutputMessage = {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error',
        content: error instanceof Error ? error.message : String(error)
      };
      this.emit('output', errorMessage);
      this.emit('status', 'error' as InstanceStatus);
      this.emitErrorIfObserved(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Override terminate to clean up spawned state
   */
  override async terminate(graceful = true): Promise<void> {
    const wasSpawned = this.isSpawned;
    await super.terminate(graceful);
    this.cleanupBrowserGatewaySettings();
    this.isSpawned = false;
    // Emit exit event for cleanup (archive, adapter removal, etc.)
    // Only emit if we were actually spawned to avoid spurious events
    if (wasSpawned) {
      this.emit('exit', 0, null);
    }
  }

  private cleanupBrowserGatewaySettings(): void {
    if (!this.browserGatewaySettingsPath) {
      return;
    }
    rmSync(dirname(this.browserGatewaySettingsPath), { recursive: true, force: true });
  }
}
