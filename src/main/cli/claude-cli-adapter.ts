/**
 * Claude CLI Adapter - Spawns and manages Claude Code CLI processes
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { NdjsonParser } from './ndjson-parser';
import { InputFormatter } from './input-formatter';
import { processAttachments, buildMessageWithFiles } from './file-handler';
import type {
  CliStreamMessage,
  CliSpawnOptions,
  isAssistantMessage,
  isSystemMessage,
  isToolUseMessage,
  isToolResultMessage,
  isResultMessage,
  isErrorMessage,
  isInputRequiredMessage,
} from '../../shared/types/cli.types';
import type { OutputMessage, ContextUsage, InstanceStatus } from '../../shared/types/instance.types';
import { generateId } from '../../shared/utils/id-generator';

export interface CliAdapterEvents {
  'output': (message: OutputMessage) => void;
  'status': (status: InstanceStatus) => void;
  'context': (usage: ContextUsage) => void;
  'error': (error: Error) => void;
  'exit': (code: number | null, signal: string | null) => void;
  'spawned': (pid: number) => void;
}

export class ClaudeCliAdapter extends EventEmitter {
  private process: ChildProcess | null = null;
  private parser: NdjsonParser;
  private formatter: InputFormatter | null = null;
  private options: CliSpawnOptions;
  private sessionId: string;

  constructor(options: CliSpawnOptions) {
    super();
    this.options = options;
    this.sessionId = options.sessionId || generateId();
    this.parser = new NdjsonParser();
  }

  /**
   * Spawn the Claude CLI process
   */
  async spawn(): Promise<number> {
    if (this.process) {
      throw new Error('Process already spawned');
    }

    const args = this.buildArgs();

    this.process = spawn('claude', args, {
      cwd: this.options.workingDirectory,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

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

    this.emit('spawned', this.process.pid);
    return this.process.pid;
  }

  /**
   * Send a message to the CLI
   */
  async sendMessage(message: string, attachments?: any[]): Promise<void> {
    if (!this.formatter || !this.formatter.isWritable()) {
      throw new Error('CLI not ready for input');
    }

    // Separate images (inline) from other files (need file path)
    const imageAttachments = attachments?.filter(a => a.type?.startsWith('image/')) || [];
    const otherAttachments = attachments?.filter(a => !a.type?.startsWith('image/')) || [];

    let finalMessage = message;

    // For non-image files, save to working directory and add file paths to message
    if (otherAttachments.length > 0) {
      console.log('ClaudeCliAdapter: Processing non-image attachments...');
      const processed = await processAttachments(otherAttachments, this.sessionId, this.options.workingDirectory);
      finalMessage = buildMessageWithFiles(message, processed);
      console.log('ClaudeCliAdapter: Processed file attachments:', {
        totalFiles: processed.length,
        filePaths: processed.map((a) => a.filePath),
      });
    }

    // Images are sent inline via content blocks (like native Claude Code)
    if (imageAttachments.length > 0) {
      console.log('ClaudeCliAdapter: Sending', imageAttachments.length, 'images inline');
    }

    console.log('ClaudeCliAdapter: Sending message:', finalMessage.substring(0, 200));
    await this.formatter.sendMessage(finalMessage, imageAttachments.length > 0 ? imageAttachments : undefined);
    this.emit('status', 'busy');
  }

  /**
   * Terminate the CLI process
   */
  async terminate(graceful: boolean = true): Promise<void> {
    if (!this.process) return;

    if (graceful) {
      // Close stdin first to signal end of input
      this.formatter?.close();

      // Send SIGTERM
      this.process.kill('SIGTERM');

      // Wait for graceful shutdown
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          // Force kill if not terminated
          if (this.process) {
            this.process.kill('SIGKILL');
          }
          resolve();
        }, 5000);

        this.process?.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    } else {
      this.process.kill('SIGKILL');
    }
  }

  /**
   * Get the process ID
   */
  getPid(): number | null {
    return this.process?.pid || null;
  }

  /**
   * Get the session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Check if process is running
   */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /**
   * Build CLI arguments
   */
  private buildArgs(): string[] {
    const args = [
      '--print',  // Non-interactive mode (required for stream-json)
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',  // Accept JSON input via stdin
      '--verbose',
    ];

    // YOLO mode - auto-approve all permissions
    if (this.options.yoloMode) {
      args.push('--dangerously-skip-permissions');
    }

    if (this.options.resume && this.sessionId) {
      // Resume a previous session
      args.push('--resume', this.sessionId);
    } else if (this.sessionId) {
      // Start a new session with specific ID
      args.push('--session-id', this.sessionId);
    }

    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    if (this.options.maxTokens) {
      args.push('--max-tokens', this.options.maxTokens.toString());
    }

    if (this.options.allowedTools && this.options.allowedTools.length > 0) {
      args.push('--allowed-tools', this.options.allowedTools.join(','));
    }

    if (this.options.disallowedTools && this.options.disallowedTools.length > 0) {
      args.push('--disallowed-tools', this.options.disallowedTools.join(','));
    }

    if (this.options.systemPrompt) {
      args.push('--system-prompt', this.options.systemPrompt);
    }

    return args;
  }

  /**
   * Handle stdout data (NDJSON stream)
   */
  private handleStdout(chunk: Buffer): void {
    const raw = chunk.toString();
    console.log('CLI stdout raw:', raw.substring(0, 500)); // Log first 500 chars

    const messages = this.parser.parse(raw);
    console.log('CLI parsed messages:', messages.length);

    for (const message of messages) {
      console.log('CLI message type:', message.type);
      this.processCliMessage(message);
    }
  }

  /**
   * Handle stderr data
   */
  private handleStderr(chunk: Buffer): void {
    const errorText = chunk.toString().trim();
    console.log('CLI stderr:', errorText);

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

  /**
   * Handle process exit
   */
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

  /**
   * Process a parsed CLI message
   */
  private processCliMessage(message: CliStreamMessage): void {
    switch (message.type) {
      case 'assistant':
        // Extract content from nested structure: message.message.content[0].text
        const assistantMsg = message as any;
        let assistantContent = '';
        if (assistantMsg.message?.content) {
          // Content is an array of content blocks - only extract text blocks
          assistantContent = assistantMsg.message.content
            .filter((block: any) => block.type === 'text' && block.text)
            .map((block: any) => block.text)
            .join('');
        } else if (typeof assistantMsg.content === 'string') {
          // Fallback for direct content (in case format changes)
          assistantContent = assistantMsg.content;
        }
        // Only emit if there's actual text content (skip tool_use only messages)
        if (assistantContent.trim()) {
          this.emit('output', {
            id: generateId(),
            timestamp: message.timestamp || Date.now(),
            type: 'assistant',
            content: assistantContent,
          });
        }
        this.emit('status', 'busy');
        break;

      case 'user':
        // Skip tool_result messages from CLI (these are internal, not actual user input)
        // Actual user messages are emitted by InstanceManager.sendInput()
        const userMsg = message as any;
        if (userMsg.message?.content && Array.isArray(userMsg.message.content)) {
          // This is a tool_result message from CLI, skip it
          break;
        }
        // Only emit if content is a string (actual user message)
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
          this.emit('context', {
            used: message.usage.total_tokens,
            total: message.usage.max_tokens,
            percentage: message.usage.percentage,
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
        // Don't emit output - the result text duplicates the assistant message
        // Just emit the status change and store metadata for potential later use
        this.emit('status', 'idle');
        break;

      case 'error':
        this.emit('output', {
          id: generateId(),
          timestamp: message.timestamp || Date.now(),
          type: 'error',
          content: message.error.message,
          metadata: { code: message.error.code },
        });
        this.emit('status', 'error');
        break;

      case 'input_required':
        this.emit('status', 'waiting_for_input');
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
