import { BaseCliAdapter, CliAdapterConfig, CliCapabilities, CliMessage, CliResponse, CliStatus, AdapterRuntimeCapabilities } from './base-cli-adapter';
import { getLogger } from '../../logging/logger';
import type { FileAttachment } from '../../../shared/types/instance.types';

const logger = getLogger('CursorCliAdapter');

// ============ Cursor stream-JSON event types ============

interface CursorSystemInitEvent {
  type: 'system';
  subtype: 'init';
  session_id?: string;
  model?: string;
  cwd?: string;
  apiKeySource?: string;
  permissionMode?: string;
}

interface CursorUserEvent {
  type: 'user';
  message: { role: 'user'; content: unknown[] };
  session_id?: string;
}

interface CursorAssistantEvent {
  type: 'assistant';
  message: { role: 'assistant'; content: { type: 'text'; text: string }[] };
  session_id?: string;
  timestamp_ms?: number;
  model_call_id?: string;
}

interface CursorToolCallEvent {
  type: 'tool_call';
  subtype: 'started' | 'completed';
  call_id: string;
  tool_call: Record<string, unknown>;
  session_id?: string;
  is_error?: boolean;
}

interface CursorResultEvent {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  result?: string;
  session_id?: string;
  request_id?: string;
}

type CursorEvent =
  | CursorSystemInitEvent
  | CursorUserEvent
  | CursorAssistantEvent
  | CursorToolCallEvent
  | CursorResultEvent;

interface StreamContext {
  streamingMessageId(): string | null;
  setStreamingMessageId(id: string): void;
  appendStreamingContent(chunk: string): void;
  getStreamingContent(): string;
  markDeltaSeen(): void;
  hasDeltaSeen(): boolean;
}

// ============ Exported config interface ============

export interface CursorCliConfig {
  model?: string;
  workingDir?: string;
  systemPrompt?: string;
  yoloMode?: boolean;
  timeout?: number;
}

export class CursorCliAdapter extends BaseCliAdapter {
  private cliConfig: CursorCliConfig;

  /** Cursor's own session_id, captured from terminal `result` events for --resume. */
  private cursorSessionId: string | null = null;

  /** Feature flag: becomes false after unknown-flag fallback (see Task 16). */
  private partialOutputSupported = true;

  /** Ready gate — exec-per-message model has no persistent process. */
  private isSpawned = false;

  constructor(config: CursorCliConfig = {}) {
    const adapterConfig: CliAdapterConfig = {
      command: 'cursor-agent',
      args: [],
      cwd: config.workingDir,
      timeout: config.timeout ?? 300_000,
      sessionPersistence: true,
    };
    super(adapterConfig);
    this.cliConfig = { ...config };
    this.sessionId = `cursor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  getName(): string { return 'cursor-cli'; }

  getCapabilities(): CliCapabilities {
    return {
      streaming: true,
      toolUse: true,
      fileAccess: true,
      shellExecution: true,
      multiTurn: true,
      vision: false,
      codeExecution: true,
      contextWindow: 200_000,
      outputFormats: ['text', 'json', 'stream-json'],
    };
  }

  override getRuntimeCapabilities(): AdapterRuntimeCapabilities {
    return {
      supportsResume: true,
      supportsForkSession: false,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
    };
  }

  async checkStatus(): Promise<CliStatus> {
    return { available: false, error: 'stub: implement in Phase 4' };
  }

  override async sendMessage(message: CliMessage): Promise<CliResponse> {
    if (message.attachments?.length) {
      throw new Error('Cursor adapter does not support attachments in orchestrator mode.');
    }
    if (!this.isSpawned) {
      throw new Error('Cursor adapter not spawned; call spawn() before sendMessage.');
    }

    const startTime = Date.now();
    this.outputBuffer = '';

    return new Promise<CliResponse>((resolve, reject) => {
      const args = this.buildArgs(message);
      logger.debug('Spawning cursor-agent', {
        args: this.redactPromptForLog(args),
        hasResumeId: !!this.cursorSessionId,
      });
      this.process = this.spawnProcess(args);

      // Handle spawn errors (e.g., ENOENT when binary doesn't exist)
      this.process.on('error', (err) => {
        this.process = null;
        reject(new Error(`Failed to spawn cursor-agent: ${err.message}`));
      });

      // cursor-agent reads prompt from positional arg, not stdin — close immediately.
      if (this.process.stdin) {
        this.process.stdin.end();
      }

      // Per-turn streaming state
      let streamingMessageId: string | null = null;
      let streamingContent = '';
      let hasReceivedDeltas = false;

      // Line-buffered NDJSON parsing — cursor-agent emits one JSON object per line
      // on stdout under --output-format stream-json.
      let lineBuffer = '';

      this.process.stdout?.on('data', (data) => {
        const chunk = (data as Buffer).toString();
        this.outputBuffer += chunk;
        lineBuffer += chunk;

        // Split into complete lines; keep the last partial line for next chunk.
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let event: CursorEvent;
          try {
            event = JSON.parse(trimmed) as CursorEvent;
          } catch {
            // Non-JSON output (shouldn't happen under --output-format stream-json,
            // but banners or similar can sneak through). Skip.
            continue;
          }

          const ctx: StreamContext = {
            streamingMessageId: () => streamingMessageId,
            setStreamingMessageId: (id) => { streamingMessageId = id; },
            appendStreamingContent: (c) => { streamingContent += c; },
            getStreamingContent: () => streamingContent,
            markDeltaSeen: () => { hasReceivedDeltas = true; },
            hasDeltaSeen: () => hasReceivedDeltas,
          };

          this.handleCursorEvent(event, ctx);
        }
      });

      this.process.stderr?.on('data', (data) => {
        const errorStr = (data as Buffer).toString();
        // Heuristic: the CLI writes banners/info to stderr too. Only escalate
        // if it looks like a real error. Task 23 will expand this.
        if (/error|fatal|failed/i.test(errorStr)) {
          logger.warn('cursor-agent stderr', { text: errorStr.trim() });
        }
      });

      this.process.on('close', (code) => {
        // Flush any final partial line (shouldn't have JSON mid-object under
        // --stream because each event is newline-terminated, but be safe).
        if (lineBuffer.trim()) {
          try {
            JSON.parse(lineBuffer.trim());
          } catch {
            /* drop incomplete trailing line */
          }
          lineBuffer = '';
        }

        const duration = Date.now() - startTime;

        if (code !== 0 && code !== null) {
          this.process = null;
          reject(new Error(`cursor-agent exited with code ${code}`));
          return;
        }

        const response = this.parseOutput(this.outputBuffer);
        response.usage = { ...response.usage, duration };
        this.emit('complete', response);
        this.process = null;
        resolve(response);
      });

      // Fallback per-call timeout — belt and braces on top of BaseCliAdapter's
      // stream-idle watchdog (which only fires when stdout is silent).
      const timeoutMs = this.cliConfig.timeout ?? this.config.timeout ?? 300_000;
      const timeout = setTimeout(() => {
        if (this.process) {
          try {
            this.process.kill('SIGTERM');
          } catch {
            /* ignored */
          }
          reject(new Error(`Cursor CLI timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.process.on('close', () => clearTimeout(timeout));
    });
  }

  async *sendMessageStream(_message: CliMessage): AsyncIterable<string> {
    void _message;
    throw new Error('CursorCliAdapter: stub — not yet implemented');
    yield ''; // unreachable; required by the `require-yield` lint rule on generator functions
  }

  parseOutput(raw: string): CliResponse {
    // Minimal implementation for Task 17 — Tasks 18-20 will refine this
    // once assistant/result events are being captured into structured data.
    return {
      id: this.generateResponseId(),
      content: '',
      role: 'assistant',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      raw,
    };
  }

  protected override buildArgs(message: CliMessage): string[] {
    const args: string[] = [
      '-p',
      '--output-format', 'stream-json',
      '--force',
      '--sandbox', 'disabled',
    ];

    if (this.partialOutputSupported) {
      args.push('--stream-partial-output');
    }

    const model = this.cliConfig.model;
    const isAutoSentinel = !model || model.toLowerCase() === 'auto';
    if (!isAutoSentinel) {
      args.push('--model', model);
    }

    if (this.cursorSessionId) {
      args.push('--resume', this.cursorSessionId);
    }

    const prompt = this.cliConfig.systemPrompt
      ? `${this.cliConfig.systemPrompt}\n\n${message.content}`
      : message.content;
    args.push(prompt);

    return args;
  }

  // ============ NDJSON event dispatcher ============

  private handleCursorEvent(event: CursorEvent, ctx: StreamContext): void {
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          if (event.session_id) this.cursorSessionId = event.session_id;
          this.emit('status', 'busy');
        }
        break;
      case 'user':
        // Ignore — our own prompt echoed back.
        break;
      case 'assistant':
        this.handleAssistantEvent(event, ctx);
        break;
      case 'tool_call':
        this.handleToolCallEvent(event);
        break;
      case 'result':
        this.handleResultEvent(event);
        break;
    }
  }

  // Stub handlers — Task 18/19/20 will fill bodies.

  private handleAssistantEvent(_event: CursorAssistantEvent, _ctx: StreamContext): void {
    // Implementation in Task 18.
    void _event; void _ctx;
  }

  private handleToolCallEvent(_event: CursorToolCallEvent): void {
    // Implementation in Task 19.
    void _event;
  }

  private handleResultEvent(_event: CursorResultEvent): void {
    // Implementation in Task 20.
    void _event;
  }

  /**
   * Redact the prompt body from arg logs. The prompt is the last positional arg
   * (cursor-agent has no --prompt flag). This is cursor-specific and intentionally
   * differs from copilot's flag-based redaction.
   */
  private redactPromptForLog(args: string[]): string[] {
    if (args.length === 0) return args;
    const out = [...args];
    const tail = out[out.length - 1];
    if (typeof tail === 'string') {
      out[out.length - 1] = `<redacted ${tail.length} chars>`;
    }
    return out;
  }

  // ============ InstanceManager Compatibility API ============

  /**
   * Stub spawn — will be implemented in Phase 4.
   */
  async spawn(): Promise<number> {
    throw new Error('CursorCliAdapter: stub — not yet implemented');
  }

  /**
   * Stub sendInput — will be implemented in Phase 4.
   */
  async sendInput(_message: string, _attachments?: FileAttachment[]): Promise<void> {
    void _message;
    void _attachments;
    throw new Error('CursorCliAdapter: stub — not yet implemented');
  }
}
