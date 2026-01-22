/**
 * Base CLI Adapter - Abstract base class for all CLI tool adapters
 * Provides a common interface for spawning and managing CLI processes
 * (Claude Code, OpenAI Codex, Google Gemini, etc.)
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

/**
 * Configuration for CLI adapters
 */
export interface CliAdapterConfig {
  /** CLI executable command/path */
  command: string;
  /** Default arguments for the CLI */
  args?: string[];
  /** Working directory for the CLI process */
  cwd?: string;
  /** Default timeout in milliseconds */
  timeout?: number;
  /** Environment variables */
  env?: Record<string, string>;
  /** Maximum retry count on failure */
  maxRetries?: number;
  /** Support session persistence/resumption */
  sessionPersistence?: boolean;
}

/**
 * Capabilities supported by a CLI tool
 */
export interface CliCapabilities {
  /** Real-time output streaming */
  streaming: boolean;
  /** Can execute tools/functions */
  toolUse: boolean;
  /** Can read/write files */
  fileAccess: boolean;
  /** Can run shell commands */
  shellExecution: boolean;
  /** Supports multi-turn conversations */
  multiTurn: boolean;
  /** Can process images */
  vision: boolean;
  /** Can execute code */
  codeExecution: boolean;
  /** Maximum context window (tokens) */
  contextWindow: number;
  /** Supported output formats */
  outputFormats: string[];
}

/**
 * Message to send to a CLI
 */
export interface CliMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: CliAttachment[];
  metadata?: Record<string, unknown>;
}

/**
 * Attachment for CLI messages
 */
export interface CliAttachment {
  type: 'file' | 'image' | 'code';
  path?: string;
  content?: string;
  mimeType?: string;
  name?: string;
}

/**
 * Response from a CLI
 */
export interface CliResponse {
  id: string;
  content: string;
  role: 'assistant';
  toolCalls?: CliToolCall[];
  usage?: CliUsage;
  metadata?: Record<string, unknown>;
  /** Original CLI output for debugging */
  raw?: unknown;
}

/**
 * Tool call made by a CLI
 */
export interface CliToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
}

/**
 * Usage statistics from a CLI
 */
export interface CliUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cost?: number;
  duration?: number;
}

/**
 * Status of a CLI tool
 */
export interface CliStatus {
  available: boolean;
  version?: string;
  path?: string;
  authenticated?: boolean;
  error?: string;
}

/**
 * Events emitted by CLI adapters
 */
export type CliEvent =
  | 'output'      // Streaming content
  | 'tool_use'    // Tool invocation
  | 'tool_result' // Tool response
  | 'status'      // Status update
  | 'error'       // Error occurred
  | 'complete'    // Response finished
  | 'exit'        // Process exited
  | 'spawned';    // Process spawned

/**
 * Event handler types for CLI adapters
 */
export interface CliAdapterEvents {
  'output': (content: string) => void;
  'tool_use': (toolCall: CliToolCall) => void;
  'tool_result': (toolCall: CliToolCall) => void;
  'status': (status: string) => void;
  'error': (error: Error | string) => void;
  'complete': (response: CliResponse) => void;
  'exit': (code: number | null, signal: string | null) => void;
  'spawned': (pid: number) => void;
}

/**
 * Abstract base class for CLI adapters
 * All CLI tool adapters (Claude, Codex, Gemini, etc.) must extend this class
 */
export abstract class BaseCliAdapter extends EventEmitter {
  protected config: CliAdapterConfig;
  protected process: ChildProcess | null = null;
  protected sessionId: string | null = null;
  protected outputBuffer: string = '';

  constructor(config: CliAdapterConfig) {
    super();
    this.config = {
      timeout: 300000, // 5 minute default
      maxRetries: 2,
      sessionPersistence: true,
      ...config,
    };
  }

  // ============ Abstract Methods - Must be implemented by each CLI adapter ============

  /**
   * Get the name of this CLI adapter
   */
  abstract getName(): string;

  /**
   * Get the capabilities of this CLI tool
   */
  abstract getCapabilities(): CliCapabilities;

  /**
   * Check if the CLI is available and properly configured
   */
  abstract checkStatus(): Promise<CliStatus>;

  /**
   * Send a message and get a response (non-streaming)
   */
  abstract sendMessage(message: CliMessage): Promise<CliResponse>;

  /**
   * Send a message and stream the response
   */
  abstract sendMessageStream(message: CliMessage): AsyncIterable<string>;

  /**
   * Parse raw CLI output into a standardized response
   */
  abstract parseOutput(raw: string): CliResponse;

  /**
   * Build CLI arguments for a given message
   */
  protected abstract buildArgs(message: CliMessage): string[];

  // ============ Common Methods with Default Implementations ============

  /**
   * Initialize the CLI adapter (verify availability)
   */
  async initialize(): Promise<void> {
    const status = await this.checkStatus();
    if (!status.available) {
      throw new Error(`${this.getName()} CLI not available: ${status.error || 'Unknown error'}`);
    }
  }

  /**
   * Terminate the CLI process
   */
  async terminate(graceful: boolean = true): Promise<void> {
    if (!this.process) return;

    if (graceful) {
      // Send SIGTERM first
      this.process.kill('SIGTERM');

      // Wait for graceful shutdown with timeout
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process && !this.process.killed) {
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

    this.process = null;
    this.outputBuffer = '';
  }

  /**
   * Interrupt the CLI process (like Ctrl+C)
   * Sends SIGINT to the process to interrupt current operation
   * This pauses Claude's work without terminating the process
   */
  interrupt(): boolean {
    if (!this.process || this.process.killed) {
      return false;
    }

    try {
      // Send SIGINT (equivalent to Ctrl+C in terminal)
      this.process.kill('SIGINT');
      // Note: Don't emit status here - the instance manager handles status updates
      // after interrupt. The CLI will emit 'waiting_for_input' when it's ready.
      return true;
    } catch (error) {
      console.error('Failed to interrupt process:', error);
      return false;
    }
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Set the session ID
   */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  /**
   * Check if a process is currently running
   */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /**
   * Get the process ID if running
   */
  getPid(): number | null {
    return this.process?.pid || null;
  }

  /**
   * Get the adapter configuration
   */
  getConfig(): CliAdapterConfig {
    return { ...this.config };
  }

  // ============ Protected Helper Methods ============

  /**
   * Spawn a CLI process with given arguments
   */
  protected spawnProcess(args: string[]): ChildProcess {
    const fullArgs = [...(this.config.args || []), ...args];

    // Extend PATH to include common CLI installation directories
    // This is needed for packaged Electron apps where PATH may be limited
    const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || '';
    const additionalPaths = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      `${homeDir}/.local/bin`,
      `${homeDir}/.npm-global/bin`,
      `${homeDir}/.nvm/versions/node/current/bin`,
      '/usr/bin',
      '/bin',
    ].filter(Boolean);

    const currentPath = process.env['PATH'] || '';
    const extendedPath = [...additionalPaths, currentPath].join(':');

    const proc = spawn(this.config.command, fullArgs, {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env, PATH: extendedPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (proc.pid) {
      this.emit('spawned', proc.pid);
    }

    return proc;
  }

  /**
   * Generate a unique response ID
   */
  protected generateResponseId(): string {
    const prefix = this.getName().toLowerCase().replace(/\s+/g, '-');
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Estimate token usage from content length (rough approximation)
   */
  protected estimateTokens(content: string): number {
    // Rough estimate: ~4 characters per token
    return Math.ceil(content.length / 4);
  }

  /**
   * Create a timeout promise
   */
  protected createTimeout(ms: number, message: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    });
  }

  /**
   * Run with timeout wrapper
   */
  protected async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs?: number
  ): Promise<T> {
    const timeout = timeoutMs || this.config.timeout || 300000;
    return Promise.race([
      promise,
      this.createTimeout(timeout, `${this.getName()} CLI timeout after ${timeout}ms`),
    ]);
  }
}
