/**
 * Codex CLI Adapter - Spawns and manages OpenAI Codex CLI processes
 * https://github.com/openai/codex
 *
 * Uses `codex exec` for non-interactive execution with JSONL output.
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
} from './base-cli-adapter';
import type { OutputMessage, ContextUsage, InstanceStatus, ThinkingContent } from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { extractThinkingContent, ThinkingBlock } from '../../../shared/utils/thinking-extractor';

/**
 * Codex CLI specific configuration
 */
export interface CodexCliConfig {
  /** Model to use (gpt-4, o3, etc.) */
  model?: string;
  /** Approval mode: suggest, auto-edit, or full-auto */
  approvalMode?: 'suggest' | 'auto-edit' | 'full-auto';
  /** Sandbox mode: read-only, workspace-write, or danger-full-access */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Working directory */
  workingDir?: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** System prompt */
  systemPrompt?: string;
}

/**
 * Events emitted by CodexCliAdapter (for InstanceManager compatibility)
 */
export interface CodexCliAdapterEvents {
  'output': (message: OutputMessage) => void;
  'status': (status: InstanceStatus) => void;
  'context': (usage: ContextUsage) => void;
  'error': (error: Error) => void;
  'exit': (code: number | null, signal: string | null) => void;
  'spawned': (pid: number) => void;
}

/**
 * Codex CLI Adapter - Implementation for OpenAI Codex CLI
 */
export class CodexCliAdapter extends BaseCliAdapter {
  private cliConfig: CodexCliConfig;

  constructor(config: CodexCliConfig = {}) {
    const adapterConfig: CliAdapterConfig = {
      command: 'codex',
      args: [],
      cwd: config.workingDir,
      timeout: config.timeout || 300000,
      sessionPersistence: true,
    };
    super(adapterConfig);

    this.cliConfig = config;
    this.sessionId = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // ============ BaseCliAdapter Abstract Implementations ============

  getName(): string {
    return 'codex-cli';
  }

  getCapabilities(): CliCapabilities {
    return {
      streaming: true,
      toolUse: true,
      fileAccess: true,
      shellExecution: true,
      multiTurn: true,
      vision: false, // Explicitly blocked in orchestrator mode
      codeExecution: true,
      contextWindow: 128000, // GPT-4 context window
      outputFormats: ['text', 'json'],
    };
  }

  override getRuntimeCapabilities(): AdapterRuntimeCapabilities {
    return {
      supportsResume: false,
      supportsForkSession: false,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: false,
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
        if (code === 0 || output.includes('codex')) {
          const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
          resolve({
            available: true,
            version: versionMatch?.[1] || 'unknown',
            path: 'codex',
            authenticated: true, // Codex handles its own auth
          });
        } else {
          resolve({
            available: false,
            error: `Codex CLI not found or not configured: ${output}`,
          });
        }
      });

      proc.on('error', (err) => {
        resolve({
          available: false,
          error: `Failed to spawn codex: ${err.message}`,
        });
      });

      setTimeout(() => {
        proc.kill();
        resolve({
          available: false,
          error: 'Timeout checking Codex CLI',
        });
      }, 5000);
    });
  }

  async sendMessage(message: CliMessage): Promise<CliResponse> {
    if (message.attachments && message.attachments.length > 0) {
      throw new Error('Codex adapter does not support attachments in orchestrator mode.');
    }

    const startTime = Date.now();
    this.outputBuffer = '';

    return new Promise((resolve, reject) => {
      const args = this.buildArgs(message);
      this.process = this.spawnProcess(args);

      // For `codex exec`, the prompt is passed as an argument, not via stdin
      // Close stdin since we're not using it
      if (this.process.stdin) {
        this.process.stdin.end();
      }

      this.process.stdout?.on('data', (data) => {
        const chunk = data.toString();
        this.outputBuffer += chunk;

        // Parse JSONL events and extract content
        const lines = chunk.split('\n').filter((l: string) => l.trim());
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            // Handle Codex exec event types
            if (event.type === 'item.completed' && event.item?.text) {
              this.emit('output', event.item.text);
            } else if (event.type === 'message' && event.content) {
              this.emit('output', event.content);
            } else if (event.type === 'agent_message' && event.message?.content) {
              this.emit('output', event.message.content);
            }
          } catch {
            // Not JSON, may be plain text output - emit if it's not empty
            if (line.trim() && !line.startsWith('{')) {
              this.emit('output', line);
            }
          }
        }
      });

      this.process.stderr?.on('data', (data) => {
        const errorStr = data.toString();
        // Surface MCP / startup progress as info output so users see what's happening
        const lines = errorStr.split('\n').filter((l: string) => l.trim());
        for (const line of lines) {
          const trimmed = line.trim();
          // Hard errors → emit as error
          if (/\b(fatal|FATAL)\b/.test(trimmed) ||
              (/\b(error|Error|ERROR)\b/.test(trimmed) && !trimmed.startsWith('mcp:'))) {
            this.emit('error', trimmed);
          } else if (trimmed.startsWith('mcp:') || trimmed.includes('starting') || trimmed.includes('ready') || trimmed.includes('failed')) {
            // MCP loading / startup status → surface as system output
            this.emit('output', `[codex] ${trimmed}`);
          }
        }
      });

      this.process.on('close', (code) => {
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
          reject(new Error(`Codex exited with code ${code}`));
        }
        this.process = null;
      });

      // Timeout handling
      const timeout = setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGTERM');
          reject(new Error('Codex CLI timeout'));
        }
      }, this.config.timeout);

      this.process.on('close', () => clearTimeout(timeout));
    });
  }

  async *sendMessageStream(message: CliMessage): AsyncIterable<string> {
    const args = this.buildArgs(message);
    this.process = this.spawnProcess(args);

    // For `codex exec`, the prompt is passed as an argument, not via stdin
    if (this.process.stdin) {
      this.process.stdin.end();
    }

    const stdout = this.process.stdout;
    if (!stdout) return;

    for await (const chunk of stdout) {
      const chunkStr = chunk.toString();
      // Parse JSONL and extract content
      const lines = chunkStr.split('\n').filter((l: string) => l.trim());
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          // Handle Codex exec event types
          if (event.type === 'item.completed' && event.item?.text) {
            yield event.item.text;
          } else if (event.type === 'message' && event.content) {
            yield event.content;
          } else if (event.type === 'agent_message' && event.message?.content) {
            yield event.message.content;
          }
        } catch {
          // Not JSON, yield if it looks like content
          if (line.trim() && !line.startsWith('{')) {
            yield line;
          }
        }
      }
    }
  }

  parseOutput(raw: string): CliResponse & { thinking?: ThinkingBlock[] } {
    const id = this.generateResponseId();

    // Try to parse JSONL output first
    let content = this.extractContentFromJsonl(raw);
    const toolCalls = this.extractToolCalls(raw);
    const usage = this.extractUsage(raw);

    // If no JSONL content, use cleaned raw
    if (!content) {
      content = this.cleanContent(raw);
    }

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
      thinking: extracted.thinking.length > 0 ? extracted.thinking : undefined,
    };
  }

  /**
   * Extract content from JSONL output format
   * Codex exec outputs events in format:
   * - {"type":"item.completed","item":{"id":"...","type":"agent_message","text":"..."}}
   * - {"type":"turn.completed","usage":{...}}
   */
  private extractContentFromJsonl(raw: string): string {
    const contentParts: string[] = [];
    const lines = raw.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        // Handle Codex exec event types
        if (event.type === 'item.completed' && event.item?.text) {
          contentParts.push(event.item.text);
        } else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.message?.content) {
          contentParts.push(event.item.message.content);
        } else if (event.type === 'message' && event.content) {
          contentParts.push(event.content);
        } else if (event.type === 'agent_message' && event.message?.content) {
          contentParts.push(event.message.content);
        } else if (event.type === 'text' && event.text) {
          contentParts.push(event.text);
        } else if (event.type === 'completion' && event.content) {
          contentParts.push(event.content);
        }
      } catch {
        /* intentionally ignored: non-JSON lines are skipped during output parsing */
      }
    }

    return contentParts.join('\n');
  }

  protected buildArgs(message: CliMessage): string[] {
    // Use `codex exec` for non-interactive execution
    const args: string[] = ['exec'];

    // Model selection
    if (this.cliConfig.model) {
      args.push('--model', this.cliConfig.model);
    }

    // Enable JSONL output for easier parsing
    args.push('--json');

    // Approval mode / sandbox settings
    if (this.cliConfig.approvalMode === 'full-auto') {
      // --full-auto is a convenience flag that sets sandbox to workspace-write
      args.push('--full-auto');
    } else if (this.cliConfig.sandboxMode) {
      args.push('--sandbox', this.cliConfig.sandboxMode);
    }

    // Working directory
    if (this.cliConfig.workingDir) {
      args.push('--cd', this.cliConfig.workingDir);
    }

    // Skip git repo check in case we're running outside a repo
    args.push('--skip-git-repo-check');

    // Add the prompt as a positional argument (required for exec)
    if (message.content) {
      args.push(message.content);
    }

    return args;
  }

  // ============ Private Helper Methods ============

  private extractToolCalls(raw: string): CliToolCall[] {
    const toolCalls: CliToolCall[] = [];

    // Pattern for Codex tool execution blocks
    // Codex uses formats like [TOOL: name]...[/TOOL]
    const toolPattern = /\[TOOL:\s*(\w+)\]([\s\S]*?)\[\/TOOL\]/g;
    let match;

    while ((match = toolPattern.exec(raw)) !== null) {
      toolCalls.push({
        id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: match[1],
        arguments: { raw: match[2].trim() },
      });
    }

    // Also check for code block patterns that may indicate tool use
    const codePattern = /```(\w+)\n([\s\S]*?)```/g;
    while ((match = codePattern.exec(raw)) !== null) {
      const lang = match[1].toLowerCase();
      if (['bash', 'shell', 'sh'].includes(lang)) {
        toolCalls.push({
          id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: 'execute',
          arguments: { command: match[2].trim() },
        });
      }
    }

    return toolCalls;
  }

  private cleanContent(raw: string): string {
    // Use the shared extractor for consistent handling of thinking content
    const { response } = extractThinkingContent(raw);

    // Also remove tool blocks and status lines
    return response
      .replace(/\[TOOL:\s*\w+\][\s\S]*?\[\/TOOL\]/g, '')
      .replace(/\[Codex\].*$/gm, '') // Remove status lines
      .trim();
  }

  private extractUsage(raw: string): CliUsage {
    // Try to extract usage from JSONL turn.completed event
    const lines = raw.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'turn.completed' && event.usage) {
          return {
            inputTokens: event.usage.input_tokens || 0,
            outputTokens: event.usage.output_tokens || 0,
            totalTokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0),
          };
        }
      } catch {
        /* intentionally ignored: non-JSON lines are skipped during token count parsing */
      }
    }

    // Fallback: try to extract from raw text
    const tokensMatch = raw.match(/tokens:\s*(\d+)/i);
    const tokens = tokensMatch ? parseInt(tokensMatch[1]) : this.estimateTokens(raw);

    return {
      outputTokens: tokens,
      totalTokens: tokens,
    };
  }

  // ============ InstanceManager Compatibility API ============
  // These methods provide the spawn/sendInput pattern expected by InstanceManager
  // Unlike Claude CLI which maintains a persistent process, Codex runs exec per message

  private isSpawned: boolean = false;

  /**
   * "Spawn" the CLI adapter - marks it as ready to receive messages.
   * Unlike Claude CLI, Codex doesn't maintain a persistent process.
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
   * Send a message to Codex via exec command.
   * Each call spawns a new process.
   */
  async sendInput(message: string, attachments?: any[]): Promise<void> {
    if (!this.isSpawned) {
      throw new Error('Adapter not spawned - call spawn() first');
    }

    if (attachments && attachments.length > 0) {
      throw new Error('Codex adapter does not support attachments in orchestrator mode.');
    }

    this.emit('status', 'busy' as InstanceStatus);

    // Emit a startup notice so the UI shows progress instead of a blank spinner
    const startupNotice: OutputMessage = {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content: '[codex] Starting Codex CLI... (this may take a moment if MCP servers are loading)',
    };
    this.emit('output', startupNotice);

    try {
      const cliMessage: CliMessage = {
        role: 'user',
        content: message,
      };

      // Execute the command
      const response = await this.sendMessage(cliMessage) as CliResponse & { thinking?: ThinkingBlock[] };

      // Emit output as OutputMessage for InstanceManager
      if (response.content) {
        // Convert ThinkingBlock to ThinkingContent for OutputMessage
        const thinkingContent: ThinkingContent[] | undefined = response.thinking?.map(block => ({
          id: block.id,
          content: block.content,
          format: block.format,
          timestamp: block.timestamp || Date.now(),
        }));

        const outputMessage: OutputMessage = {
          id: generateId(),
          timestamp: Date.now(),
          type: 'assistant',
          content: response.content,
          thinking: thinkingContent,
          thinkingExtracted: true,
        };
        this.emit('output', outputMessage);
      }

      // Emit tool uses if any
      if (response.toolCalls) {
        for (const tool of response.toolCalls) {
          const toolMessage: OutputMessage = {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_use',
            content: `Using tool: ${tool.name}`,
            metadata: { ...tool } as Record<string, unknown>,
          };
          this.emit('output', toolMessage);
        }
      }

      // Update context usage using current-turn occupancy, not cumulative lifetime usage.
      // In exec-per-message mode, summing turn usage can falsely hit compaction thresholds.
      if (response.usage) {
        const usedTokens = response.usage.inputTokens !== undefined ||
          response.usage.outputTokens !== undefined
          ? (response.usage.inputTokens || 0) + (response.usage.outputTokens || 0)
          : (response.usage.totalTokens || 0);
        const contextWindow = this.getCapabilities().contextWindow;
        const contextUsage: ContextUsage = {
          used: usedTokens,
          total: contextWindow,
          percentage: Math.min((usedTokens / contextWindow) * 100, 100),
        };
        this.emit('context', contextUsage);
      }

      this.emit('status', 'idle' as InstanceStatus);
    } catch (error) {
      const errorMessage: OutputMessage = {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error',
        content: error instanceof Error ? error.message : String(error),
      };
      this.emit('output', errorMessage);
      this.emit('status', 'error' as InstanceStatus);
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Override terminate to clean up spawned state
   */
  override async terminate(graceful: boolean = true): Promise<void> {
    await super.terminate(graceful);
    this.isSpawned = false;
  }
}
