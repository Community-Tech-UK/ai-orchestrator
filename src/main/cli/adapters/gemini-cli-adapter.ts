/**
 * Gemini CLI Adapter - Spawns and manages Google Gemini CLI processes
 * https://github.com/google-gemini/gemini-cli
 *
 * Uses positional prompt for non-interactive mode with JSON output.
 * Also provides spawn/sendInput interface for compatibility with InstanceManager.
 */

import {
  BaseCliAdapter,
  CliAdapterConfig,
  CliCapabilities,
  CliStatus,
  CliMessage,
  CliResponse,
  CliToolCall,
  CliUsage
} from './base-cli-adapter';
import type {
  OutputMessage,
  ContextUsage,
  InstanceStatus,
  ThinkingContent
} from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { extractThinkingContent, ThinkingBlock } from '../../../shared/utils/thinking-extractor';

/**
 * Gemini CLI specific configuration
 */
export interface GeminiCliConfig {
  /** Model to use (gemini-2.0-flash, gemini-1.5-pro, etc.) */
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
  /** Alias for yolo (used by adapter factory) */
  yoloMode?: boolean;
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

  constructor(config: GeminiCliConfig = {}) {
    const adapterConfig: CliAdapterConfig = {
      command: 'gemini',
      args: [],
      cwd: config.workingDir,
      timeout: config.timeout || 300000,
      sessionPersistence: true
    };
    super(adapterConfig);

    // Handle yoloMode alias
    this.cliConfig = {
      ...config,
      yolo: config.yolo ?? config.yoloMode
    };
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
      vision: true, // Gemini supports images
      codeExecution: true,
      contextWindow: 1000000, // Gemini 1.5 Pro has 1M+ context
      outputFormats: ['text', 'json', 'markdown']
    };
  }

  async checkStatus(): Promise<CliStatus> {
    return new Promise((resolve) => {
      const proc = this.spawnProcess(['--version']);
      let output = '';

      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });
      proc.stderr?.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0 || output.includes('gemini')) {
          const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
          resolve({
            available: true,
            version: versionMatch?.[1] || 'unknown',
            path: 'gemini',
            authenticated: !output.includes('not authenticated')
          });
        } else {
          resolve({
            available: false,
            error: `Gemini CLI not found or not configured: ${output}`
          });
        }
      });

      proc.on('error', (err) => {
        resolve({
          available: false,
          error: `Failed to spawn gemini: ${err.message}`
        });
      });

      setTimeout(() => {
        proc.kill();
        resolve({
          available: false,
          error: 'Timeout checking Gemini CLI'
        });
      }, 5000);
    });
  }

  async sendMessage(message: CliMessage): Promise<CliResponse> {
    const startTime = Date.now();
    this.outputBuffer = '';

    return new Promise((resolve, reject) => {
      const args = this.buildArgs(message);
      this.process = this.spawnProcess(args);

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
            const event = JSON.parse(line);
            // Handle Gemini stream-json event types
            // Assistant messages: {"type":"message","role":"assistant","content":"..."}
            let newContent = '';
            if (
              event.type === 'message' &&
              event.role === 'assistant' &&
              event.content
            ) {
              newContent = event.content;
            } else if (event.type === 'text' && event.text) {
              newContent = event.text;
            }

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
        // Only emit as error if it's actually an error
        if (
          errorStr.includes('error') ||
          errorStr.includes('Error') ||
          errorStr.includes('fatal')
        ) {
          this.emit('error', errorStr);
        }
      });

      this.process.on('close', (code) => {
        const duration = Date.now() - startTime;

        if (code === 0 || this.outputBuffer) {
          const response = this.parseOutput(this.outputBuffer);
          response.usage = {
            ...response.usage,
            duration
          };
          this.emit('complete', response);
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

    // Gemini uses positional prompt, close stdin
    if (this.process.stdin) {
      this.process.stdin.end();
    }

    const stdout = this.process.stdout;
    if (!stdout) return;

    for await (const chunk of stdout) {
      const chunkStr = chunk.toString();
      // Parse stream-json and extract content
      const lines = chunkStr.split('\n').filter((l: string) => l.trim());
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          // Assistant messages: {"type":"message","role":"assistant","content":"..."}
          if (
            event.type === 'message' &&
            event.role === 'assistant' &&
            event.content
          ) {
            yield event.content;
          } else if (event.type === 'text' && event.text) {
            yield event.text;
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
    let content =
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
        const event = JSON.parse(line);
        if (
          event.type === 'message' &&
          event.role === 'assistant' &&
          event.content
        ) {
          contentParts.push(event.content);
        } else if (event.type === 'text' && event.text) {
          contentParts.push(event.text);
        }
      } catch {
        // Not JSON, skip
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
      console.warn('[Security] YOLO mode enabled for Gemini CLI instance', {
        sessionId: this.sessionId,
        model: this.cliConfig.model
      });
      args.push('--yolo');
    }

    // Handle attachments - Gemini doesn't have --file, but images work differently
    // Images would need to be handled via the prompt or a different mechanism

    // Add the prompt as positional argument (required for non-interactive mode)
    if (message.content) {
      args.push(message.content);
    }

    return args;
  }

  // ============ Private Helper Methods ============

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
    // Try to extract usage from Gemini result event
    // Format: {"type":"result","stats":{"total_tokens":...,"input_tokens":...,"output_tokens":...}}
    const lines = raw.split('\n').filter((l) => l.trim());

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'result' && event.stats) {
          return {
            inputTokens: event.stats.input_tokens || event.stats.input || 0,
            outputTokens: event.stats.output_tokens || 0,
            totalTokens: event.stats.total_tokens || 0
          };
        }
      } catch {
        // Not JSON, continue
      }
    }

    // Fallback: estimate from content
    const tokens = this.estimateTokens(raw);
    return {
      outputTokens: tokens,
      totalTokens: tokens
    };
  }

  // ============ InstanceManager Compatibility API ============
  // These methods provide the spawn/sendInput pattern expected by InstanceManager
  // Unlike Claude CLI which maintains a persistent process, Gemini runs exec per message

  private isSpawned: boolean = false;
  private totalTokensUsed: number = 0;

  /**
   * "Spawn" the CLI adapter - marks it as ready to receive messages.
   * Unlike Claude CLI, Gemini doesn't maintain a persistent process.
   * Each sendInput() will exec a new command.
   */
  async spawn(): Promise<number> {
    if (this.isSpawned) {
      throw new Error('Adapter already spawned');
    }

    this.isSpawned = true;
    // Generate a fake PID to maintain API compatibility
    const fakePid = Math.floor(Math.random() * 100000) + 10000;
    this.emit('spawned', fakePid);
    this.emit('status', 'idle' as InstanceStatus);

    return fakePid;
  }

  /**
   * Send a message to Gemini via exec command.
   * Each call spawns a new process.
   */
  async sendInput(message: string, attachments?: any[]): Promise<void> {
    if (!this.isSpawned) {
      throw new Error('Adapter not spawned - call spawn() first');
    }

    this.emit('status', 'busy' as InstanceStatus);

    try {
      // Build attachments for CliMessage format
      const cliAttachments = attachments?.map((a) => ({
        type: a.type?.startsWith('image/')
          ? ('image' as const)
          : ('file' as const),
        path: a.path,
        content: a.data,
        mimeType: a.type,
        name: a.name
      }));

      const cliMessage: CliMessage = {
        role: 'user',
        content: message,
        attachments: cliAttachments
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

      // Update context/usage tracking
      if (response.usage) {
        this.totalTokensUsed += response.usage.totalTokens || 0;
        const contextUsage: ContextUsage = {
          used: this.totalTokensUsed,
          total: 1000000, // Gemini 1.5 Pro has 1M+ context
          percentage: Math.min((this.totalTokensUsed / 1000000) * 100, 100)
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
      this.emit(
        'error',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * Override terminate to clean up spawned state
   */
  override async terminate(graceful: boolean = true): Promise<void> {
    await super.terminate(graceful);
    this.isSpawned = false;
    this.totalTokensUsed = 0;
  }
}
