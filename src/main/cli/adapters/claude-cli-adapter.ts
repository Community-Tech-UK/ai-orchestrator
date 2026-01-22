/**
 * Claude CLI Adapter - Spawns and manages Claude Code CLI processes
 * Extends BaseCliAdapter for multi-CLI support
 */

import { ChildProcess } from 'child_process';
import {
  BaseCliAdapter,
  CliAdapterConfig,
  CliCapabilities,
  CliStatus,
  CliMessage,
  CliResponse,
  CliToolCall,
  CliUsage,
} from './base-cli-adapter';
import { NdjsonParser } from '../ndjson-parser';
import { InputFormatter } from '../input-formatter';
import { processAttachments, buildMessageWithFiles } from '../file-handler';
import type { CliStreamMessage } from '../../../shared/types/cli.types';
import type { OutputMessage, ContextUsage, InstanceStatus } from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { MODEL_PRICING } from '../../../shared/types/provider.types';

/**
 * Claude CLI specific spawn options
 */
export interface ClaudeCliSpawnOptions {
  sessionId?: string;
  workingDirectory?: string;
  model?: string;
  maxTokens?: number;
  yoloMode?: boolean;
  resume?: boolean;
  forkSession?: boolean; // When resuming, create a new session ID instead of reusing
  allowedTools?: string[];
  disallowedTools?: string[];
  systemPrompt?: string;
}

/**
 * Events emitted by ClaudeCliAdapter (backward compatible)
 */
export interface ClaudeCliAdapterEvents {
  'output': (message: OutputMessage) => void;
  'status': (status: InstanceStatus) => void;
  'context': (usage: ContextUsage) => void;
  'error': (error: Error) => void;
  'exit': (code: number | null, signal: string | null) => void;
  'spawned': (pid: number) => void;
}

/**
 * Claude CLI Adapter - Implementation for Claude Code CLI
 */
export class ClaudeCliAdapter extends BaseCliAdapter {
  private parser: NdjsonParser;
  private formatter: InputFormatter | null = null;
  private spawnOptions: ClaudeCliSpawnOptions;

  constructor(options: ClaudeCliSpawnOptions = {}) {
    const config: CliAdapterConfig = {
      command: 'claude',
      args: [],
      cwd: options.workingDirectory,
      timeout: 300000,
      sessionPersistence: true,
    };
    super(config);

    this.spawnOptions = options;
    this.sessionId = options.sessionId || generateId();
    this.parser = new NdjsonParser();
  }

  // ============ BaseCliAdapter Abstract Implementations ============

  getName(): string {
    return 'claude-cli';
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
      contextWindow: 200000, // Claude 3.5 context window
      outputFormats: ['ndjson', 'text', 'json'],
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
        if (code === 0 || output.includes('claude')) {
          const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
          resolve({
            available: true,
            version: versionMatch?.[1] || 'unknown',
            path: 'claude',
            authenticated: true, // Claude CLI handles auth internally
          });
        } else {
          resolve({
            available: false,
            error: `Claude CLI not found or not configured: ${output}`,
          });
        }
      });

      proc.on('error', (err) => {
        resolve({
          available: false,
          error: `Failed to spawn claude: ${err.message}`,
        });
      });

      // Timeout
      setTimeout(() => {
        proc.kill();
        resolve({
          available: false,
          error: 'Timeout checking Claude CLI',
        });
      }, 5000);
    });
  }

  async sendMessage(message: CliMessage): Promise<CliResponse> {
    const startTime = Date.now();
    this.outputBuffer = '';

    return new Promise(async (resolve, reject) => {
      const args = this.buildArgs(message);
      this.process = this.spawnProcess(args);

      // Set up stdin formatter
      if (this.process.stdin) {
        this.formatter = new InputFormatter(this.process.stdin);
      }

      // Prepare message content with file attachments
      let finalMessage = message.content;
      const imageAttachments = message.attachments?.filter(a =>
        a.mimeType?.startsWith('image/') || a.type === 'image'
      ) || [];
      const otherAttachments = message.attachments?.filter(a =>
        !a.mimeType?.startsWith('image/') && a.type !== 'image'
      ) || [];

      // Process non-image attachments
      if (otherAttachments.length > 0 && this.config.cwd) {
        const processed = await processAttachments(
          otherAttachments.map(a => ({
            type: a.mimeType || 'text/plain',
            name: a.name || 'attachment',
            data: a.content || '',
            size: a.content?.length || 0,
          })),
          this.sessionId || generateId(),
          this.config.cwd
        );
        finalMessage = buildMessageWithFiles(message.content, processed);
      }

      // Send the message
      if (this.formatter && this.formatter.isWritable()) {
        await this.formatter.sendMessage(
          finalMessage,
          imageAttachments.length > 0
            ? imageAttachments.map(a => ({
                type: a.mimeType || 'image/png',
                name: a.name || 'image',
                data: a.content || '',
                size: a.content?.length || 0,
              }))
            : undefined
        );
      }

      // Handle stdout (NDJSON stream)
      this.process.stdout?.on('data', (chunk: Buffer) => {
        const raw = chunk.toString();
        this.outputBuffer += raw;

        const messages = this.parser.parse(raw);
        for (const msg of messages) {
          this.processCliMessage(msg);
        }
      });

      // Handle stderr
      this.process.stderr?.on('data', (chunk: Buffer) => {
        this.emit('error', new Error(chunk.toString().trim()));
      });

      // Handle exit
      this.process.on('close', (code) => {
        // Flush remaining buffer
        const remaining = this.parser.flush();
        for (const msg of remaining) {
          this.processCliMessage(msg);
        }

        const duration = Date.now() - startTime;

        if (code === 0 || this.outputBuffer) {
          const response = this.parseOutput(this.outputBuffer);
          response.usage = {
            ...response.usage,
            duration,
          };
          this.emit('complete', response);
          resolve(response);
        } else {
          reject(new Error(`Claude CLI exited with code ${code}`));
        }

        this.process = null;
        this.formatter = null;
        this.parser.reset();
      });

      // Timeout handling
      const timeout = setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGTERM');
          reject(new Error('Claude CLI timeout'));
        }
      }, this.config.timeout);

      this.process.on('close', () => clearTimeout(timeout));
    });
  }

  async *sendMessageStream(message: CliMessage): AsyncIterable<string> {
    const args = this.buildArgs(message);
    this.process = this.spawnProcess(args);

    // Set up stdin formatter
    if (this.process.stdin) {
      this.formatter = new InputFormatter(this.process.stdin);
    }

    // Send the message
    if (this.formatter && this.formatter.isWritable()) {
      await this.formatter.sendMessage(message.content);
    }

    const stdout = this.process.stdout;
    if (!stdout) return;

    for await (const chunk of stdout) {
      const raw = chunk.toString();
      const messages = this.parser.parse(raw);

      for (const msg of messages) {
        if (msg.type === 'assistant' && (msg as any).message?.content) {
          const content = (msg as any).message.content
            .filter((block: any) => block.type === 'text' && block.text)
            .map((block: any) => block.text)
            .join('');
          if (content) {
            yield content;
          }
        }
      }
    }
  }

  parseOutput(raw: string): CliResponse {
    const id = this.generateResponseId();
    const toolCalls: CliToolCall[] = [];
    let content = '';
    let usage: CliUsage = {};

    // Parse all NDJSON lines
    const lines = raw.split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);

        if (msg.type === 'assistant' && msg.message?.content) {
          // Extract text content
          const textContent = msg.message.content
            .filter((block: any) => block.type === 'text' && block.text)
            .map((block: any) => block.text)
            .join('');
          if (textContent) {
            content += textContent;
          }

          // Extract tool uses
          const toolUses = msg.message.content.filter(
            (block: any) => block.type === 'tool_use'
          );
          for (const tool of toolUses) {
            toolCalls.push({
              id: tool.id || generateId(),
              name: tool.name,
              arguments: tool.input || {},
            });
          }
        }

        if (msg.type === 'system' && msg.subtype === 'context_usage' && msg.usage) {
          usage = {
            totalTokens: msg.usage.total_tokens,
          };
        }
      } catch {
        // Ignore non-JSON lines
      }
    }

    return {
      id,
      content: content.trim(),
      role: 'assistant',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      raw,
    };
  }

  protected buildArgs(message: CliMessage): string[] {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
    ];

    // YOLO mode - auto-approve all permissions
    if (this.spawnOptions.yoloMode) {
      args.push('--dangerously-skip-permissions');
    }

    if (this.spawnOptions.resume && this.sessionId) {
      args.push('--resume', this.sessionId);
      // Fork session creates a new session ID while preserving conversation history
      if (this.spawnOptions.forkSession) {
        args.push('--fork-session');
      }
    } else if (this.sessionId) {
      args.push('--session-id', this.sessionId);
    }

    if (this.spawnOptions.model) {
      args.push('--model', this.spawnOptions.model);
    }

    if (this.spawnOptions.maxTokens) {
      args.push('--max-tokens', this.spawnOptions.maxTokens.toString());
    }

    if (this.spawnOptions.allowedTools && this.spawnOptions.allowedTools.length > 0) {
      args.push('--allowed-tools', this.spawnOptions.allowedTools.join(','));
    }

    if (this.spawnOptions.disallowedTools && this.spawnOptions.disallowedTools.length > 0) {
      args.push('--disallowed-tools', this.spawnOptions.disallowedTools.join(','));
    }

    if (this.spawnOptions.systemPrompt) {
      args.push('--system-prompt', this.spawnOptions.systemPrompt);
    }

    return args;
  }

  // ============ Legacy API Methods (Backward Compatibility) ============

  /**
   * Spawn the Claude CLI process (legacy API)
   */
  async spawn(): Promise<number> {
    if (this.process) {
      throw new Error('Process already spawned');
    }

    const args = this.buildArgs({ role: 'user', content: '' });

    this.process = this.spawnProcess(args);

    if (!this.process.pid) {
      throw new Error('Failed to spawn Claude CLI process');
    }

    // Set up stdin formatter
    if (this.process.stdin) {
      this.formatter = new InputFormatter(this.process.stdin);
    }

    // Set up stdout handler (NDJSON stream)
    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.handleStdout(chunk);
    });

    // Set up stderr handler
    this.process.stderr?.on('data', (chunk: Buffer) => {
      this.handleStderr(chunk);
    });

    // Set up exit handler
    this.process.on('exit', (code, signal) => {
      this.handleExit(code, signal);
    });

    // Set up error handler
    this.process.on('error', (error) => {
      this.emit('error', error);
    });

    return this.process.pid;
  }

  /**
   * Send a message to the CLI (legacy API)
   */
  async sendInput(message: string, attachments?: any[]): Promise<void> {
    if (!this.formatter || !this.formatter.isWritable()) {
      throw new Error('CLI not ready for input');
    }

    // Separate images (inline) from other files (need file path)
    const imageAttachments = attachments?.filter(a => a.type?.startsWith('image/')) || [];
    const otherAttachments = attachments?.filter(a => !a.type?.startsWith('image/')) || [];

    let finalMessage = message;

    // For non-image files, save to working directory and add file paths to message
    if (otherAttachments.length > 0 && this.config.cwd) {
      const processed = await processAttachments(
        otherAttachments,
        this.sessionId || generateId(),
        this.config.cwd
      );
      finalMessage = buildMessageWithFiles(message, processed);
    }

    await this.formatter.sendMessage(finalMessage, imageAttachments.length > 0 ? imageAttachments : undefined);
    this.emit('status', 'busy' as InstanceStatus);
  }

  // ============ Private Helper Methods ============

  private handleStdout(chunk: Buffer): void {
    const raw = chunk.toString();
    const messages = this.parser.parse(raw);

    for (const message of messages) {
      this.processCliMessage(message);
    }
  }

  private handleStderr(chunk: Buffer): void {
    const errorText = chunk.toString().trim();
    if (errorText) {
      const errorMessage: OutputMessage = {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error',
        content: errorText,
      };
      this.emit('output', errorMessage);
    }
  }

  private handleExit(code: number | null, signal: string | null): void {
    // Flush any remaining parser buffer
    const remaining = this.parser.flush();
    for (const message of remaining) {
      this.processCliMessage(message);
    }

    this.process = null;
    this.formatter = null;
    this.parser.reset();

    this.emit('exit', code, signal);
  }

  private processCliMessage(message: CliStreamMessage): void {
    switch (message.type) {
      case 'assistant':
        const assistantMsg = message as any;
        let assistantContent = '';
        if (assistantMsg.message?.content) {
          assistantContent = assistantMsg.message.content
            .filter((block: any) => block.type === 'text' && block.text)
            .map((block: any) => block.text)
            .join('');
        } else if (typeof assistantMsg.content === 'string') {
          assistantContent = assistantMsg.content;
        }
        if (assistantContent.trim()) {
          this.emit('output', {
            id: generateId(),
            timestamp: message.timestamp || Date.now(),
            type: 'assistant',
            content: assistantContent,
          });
        }

        // Extract context usage from assistant message (for real-time updates)
        if (assistantMsg.message?.usage) {
          const usage = assistantMsg.message.usage;
          const totalUsedTokens = (usage.input_tokens || 0) +
                                 (usage.output_tokens || 0) +
                                 (usage.cache_read_input_tokens || 0);

          // Default context window - will be updated by result message
          const contextWindow = 200000;
          const percentage = (totalUsedTokens / contextWindow) * 100;

          this.emit('context', {
            used: totalUsedTokens,
            total: contextWindow,
            percentage: Math.min(percentage, 100),
          });
        }

        this.emit('status', 'busy' as InstanceStatus);
        break;

      case 'user':
        const userMsg = message as any;
        if (userMsg.message?.content && Array.isArray(userMsg.message.content)) {
          break;
        }
        if (typeof message.content === 'string' && message.content.trim()) {
          this.emit('output', {
            id: generateId(),
            timestamp: message.timestamp || Date.now(),
            type: 'user',
            content: message.content,
          });
        }
        break;

      case 'system':
        if (message.subtype === 'context_usage' && message.usage) {
          const modelId = this.spawnOptions.model || 'claude-sonnet-4-20250514';
          const pricing = MODEL_PRICING[modelId] || { input: 3.0, output: 15.0 };

          const totalTokens = message.usage.total_tokens;
          const estimatedInputTokens = Math.floor(totalTokens * 0.7);
          const estimatedOutputTokens = totalTokens - estimatedInputTokens;

          const inputCost = (estimatedInputTokens / 1_000_000) * pricing.input;
          const outputCost = (estimatedOutputTokens / 1_000_000) * pricing.output;
          const costEstimate = inputCost + outputCost;

          this.emit('context', {
            used: message.usage.total_tokens,
            total: message.usage.max_tokens,
            percentage: message.usage.percentage,
            costEstimate,
          });
        }
        if (message.session_id) {
          this.sessionId = message.session_id;
        }
        if (message.content) {
          this.emit('output', {
            id: generateId(),
            timestamp: message.timestamp || Date.now(),
            type: 'system',
            content: message.content,
          });
        }
        break;

      case 'tool_use':
        this.emit('output', {
          id: generateId(),
          timestamp: message.timestamp || Date.now(),
          type: 'tool_use',
          content: `Using tool: ${message.tool.name}`,
          metadata: message.tool,
        });
        break;

      case 'tool_result':
        this.emit('output', {
          id: generateId(),
          timestamp: message.timestamp || Date.now(),
          type: 'tool_result',
          content: message.content,
          metadata: {
            tool_use_id: message.tool_use_id,
            is_error: message.is_error,
          },
        });
        break;

      case 'result':
        const resultMsg = message as any;

        // Extract context usage from result message
        if (resultMsg.modelUsage || resultMsg.usage) {
          // Get the model's context window from modelUsage if available
          let contextWindow = 200000; // Default
          let totalUsedTokens = 0;

          if (resultMsg.modelUsage) {
            // modelUsage is keyed by model name, get the first one
            const modelKeys = Object.keys(resultMsg.modelUsage);
            if (modelKeys.length > 0) {
              const modelData = resultMsg.modelUsage[modelKeys[0]];
              contextWindow = modelData.contextWindow || 200000;
              // Total used = input + output + cache reads (cache reads count toward context)
              totalUsedTokens = (modelData.inputTokens || 0) +
                               (modelData.outputTokens || 0) +
                               (modelData.cacheReadInputTokens || 0);
            }
          } else if (resultMsg.usage) {
            totalUsedTokens = (resultMsg.usage.input_tokens || 0) +
                             (resultMsg.usage.output_tokens || 0) +
                             (resultMsg.usage.cache_read_input_tokens || 0);
          }

          const percentage = (totalUsedTokens / contextWindow) * 100;
          const costEstimate = resultMsg.total_cost_usd || 0;

          this.emit('context', {
            used: totalUsedTokens,
            total: contextWindow,
            percentage: Math.min(percentage, 100),
            costEstimate,
          });
        }

        this.emit('status', 'idle' as InstanceStatus);
        break;

      case 'error':
        this.emit('output', {
          id: generateId(),
          timestamp: message.timestamp || Date.now(),
          type: 'error',
          content: message.error.message,
          metadata: { code: message.error.code },
        });
        this.emit('status', 'error' as InstanceStatus);
        break;

      case 'input_required':
        this.emit('status', 'waiting_for_input' as InstanceStatus);
        if (message.prompt) {
          this.emit('output', {
            id: generateId(),
            timestamp: message.timestamp || Date.now(),
            type: 'system',
            content: message.prompt,
          });
        }
        break;
    }
  }
}
