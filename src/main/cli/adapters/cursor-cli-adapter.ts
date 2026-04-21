import { BaseCliAdapter, CliAdapterConfig, CliCapabilities, CliMessage, CliResponse, CliStatus, AdapterRuntimeCapabilities } from './base-cli-adapter';
import { getLogger } from '../../logging/logger';
import type { ContextUsage, FileAttachment, OutputMessage } from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { extractThinkingContent } from '../../../shared/utils/thinking-extractor';

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

interface ResultState {
  /** Captured so retry paths (Tasks 21, 22) can replay the message. */
  message: CliMessage;
  /** Promise resolve handle from sendMessage's Promise constructor. */
  resolver: (r: CliResponse) => void;
  /** Promise reject handle from sendMessage's Promise constructor. */
  rejecter: (e: Error) => void;
  /** Set true after the first terminal event (result or error) is consumed. */
  completed: boolean;
  /** Task 21 — set true once adapter retried without --resume. Prevents retry loops. */
  retriedWithoutResume: boolean;
  /** Task 22 — set true once adapter retried without --stream-partial-output. */
  retriedWithoutPartial: boolean;
}

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

  /** Active call state — holds resolver/rejecter for the in-flight sendMessage promise. */
  private activeResultState: ResultState | null = null;

  /** Timestamp (ms) when the current sendMessage call was initiated. */
  private activeStartTime = 0;

  /** Active per-turn fallback timeout handle; cleared across retries so it doesn't leak. */
  private activeTimeout: NodeJS.Timeout | null = null;

  /**
   * Errors whose `result` string triggers a one-shot retry without --resume
   * (Task 21). Matches cursor-agent's "invalid session id", "session not found",
   * and "session expired" phrasings case-insensitively.
   */
  private readonly RESUME_FAILURE_PATTERN = /invalid session id|session not found|session expired/i;

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
    return new Promise((resolve) => {
      const proc = this.spawnProcess(['--version']);
      let output = '';
      let errorOutput = '';

      proc.stdout?.on('data', (data) => {
        output += (data as Buffer).toString();
      });
      proc.stderr?.on('data', (data) => {
        errorOutput += (data as Buffer).toString();
      });

      const timer = setTimeout(() => {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* ignored */
        }
        resolve({
          available: false,
          error: 'Timeout checking Cursor CLI',
        });
      }, 5000);

      proc.on('close', (code) => {
        clearTimeout(timer);
        const combined = `${output}\n${errorOutput}`;
        // cursor-agent emits versions like "2026.04.17-787b533"; the dotted
        // date fragment matches \d+\.\d+\.\d+ which is what we capture.
        const versionMatch = combined.match(/(\d+\.\d+\.\d+)/);

        if (code === 0 || versionMatch) {
          resolve({
            available: true,
            version: versionMatch?.[1] ?? 'unknown',
            path: 'cursor-agent',
            // --version doesn't actually probe auth; treat a successful
            // binary invocation as "authenticated enough" for the status
            // check. Real auth errors surface via stderr/keychain handlers.
            authenticated: true,
          });
        } else {
          resolve({
            available: false,
            error: `Cursor CLI not found or failed (exit ${code}): ${combined.trim() || 'no output'}`,
          });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          available: false,
          error: `Failed to launch cursor-agent: ${err.message}`,
        });
      });
    });
  }

  override async sendMessage(message: CliMessage): Promise<CliResponse> {
    if (message.attachments?.length) {
      throw new Error('Cursor adapter does not support attachments in orchestrator mode.');
    }
    if (!this.isSpawned) {
      throw new Error('Cursor adapter not spawned; call spawn() before sendMessage.');
    }

    return new Promise<CliResponse>((resolve, reject) => {
      const resultState: ResultState = {
        message,
        resolver: resolve,
        rejecter: reject,
        completed: false,
        retriedWithoutResume: false,
        retriedWithoutPartial: false,
      };
      this.dispatchTurn(message, resultState);
    });
  }

  /**
   * Spawn cursor-agent for one turn and wire the NDJSON stream + exit paths
   * onto `resultState`. Reusable from both sendMessage (first attempt) and
   * retryCurrentMessage (Task 21 resume-failure fallback, future Task 22
   * partial-output fallback).
   *
   * Idempotency — when called for a retry, the previous turn's child process
   * may still exist. We strip its listeners before overwriting `this.process`
   * so stale 'close' / 'error' callbacks don't corrupt the retry's state, and
   * we reset `resultState.completed` because handleResultEvent flipped it to
   * true before asking us to retry.
   */
  private dispatchTurn(message: CliMessage, resultState: ResultState): void {
    // Detach any previous turn's listeners so its eventual 'close' / 'error'
    // / stdout / stderr cannot mutate activeResultState / this.process after
    // the retry spawn. We also clear stdout/stderr listeners because their
    // 'data' handlers capture this.outputBuffer by reference and would
    // otherwise pollute the retry's buffer.
    if (this.process) {
      this.process.stdout?.removeAllListeners();
      this.process.stderr?.removeAllListeners();
      this.process.removeAllListeners();
      this.process = null;
    }
    if (this.activeTimeout) {
      clearTimeout(this.activeTimeout);
      this.activeTimeout = null;
    }

    // Reset per-turn state. resultState is reused across retry, so explicitly
    // flip `completed` back to false — handleResultEvent set it true on the
    // previous terminal event.
    resultState.completed = false;
    this.activeStartTime = Date.now();
    this.activeResultState = resultState;
    this.outputBuffer = '';

    const args = this.buildArgs(message);
    logger.debug('Spawning cursor-agent', {
      args: this.redactPromptForLog(args),
      hasResumeId: !!this.cursorSessionId,
    });
    this.process = this.spawnProcess(args);

    // Handle spawn errors (e.g., ENOENT when binary doesn't exist)
    this.process.on('error', (err: NodeJS.ErrnoException) => {
      const rs = this.activeResultState;
      this.activeResultState = null;
      this.process = null;
      if (this.activeTimeout) {
        clearTimeout(this.activeTimeout);
        this.activeTimeout = null;
      }
      if (rs && !rs.completed) {
        rs.completed = true;
        if (err.code === 'ENOENT') {
          rs.rejecter(new Error(
            'cursor-agent not found on PATH. Install from https://cursor.com/cli ' +
            '(curl https://cursor.com/install -fsSL | bash).',
          ));
        } else {
          rs.rejecter(new Error(`Failed to spawn cursor-agent: ${err.message}`));
        }
      }
    });

    // cursor-agent reads prompt from positional arg, not stdin — close immediately.
    if (this.process.stdin) {
      this.process.stdin.end();
    }

    // Per-turn streaming state
    let streamingMessageId: string | null = null;
    let streamingContent = '';
    let hasReceivedDeltas = false;

    // StreamContext is hoisted above the line-buffer loop so we allocate it
    // once per turn rather than once per NDJSON line. The closures still
    // capture the per-turn mutable state declared above.
    const ctx: StreamContext = {
      streamingMessageId: () => streamingMessageId,
      setStreamingMessageId: (id) => { streamingMessageId = id; },
      appendStreamingContent: (c) => { streamingContent += c; },
      getStreamingContent: () => streamingContent,
      markDeltaSeen: () => { hasReceivedDeltas = true; },
      hasDeltaSeen: () => hasReceivedDeltas,
    };

    // Line-buffered NDJSON parsing — cursor-agent emits one JSON object per line
    // on stdout under --output-format stream-json.
    let lineBuffer = '';
    let stderrBuffer = '';

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

        this.handleCursorEvent(event, ctx);
      }
    });

    this.process.stderr?.on('data', (data) => {
      const chunk = (data as Buffer).toString();
      // Always accumulate — Task 22's --stream-partial-output fallback scans
      // this buffer on non-zero exit. Do this BEFORE any filtering.
      stderrBuffer += chunk;

      // Keychain remediation — specific signature matched first, because any
      // Keychain error text also contains "failed" and would otherwise be
      // eaten by the generic branch below.
      if (/SecItemCopyMatching|keychain|login item/i.test(chunk)) {
        this.emit('output', {
          id: generateId(),
          timestamp: Date.now(),
          type: 'error',
          content:
            "Cursor CLI couldn't read its credentials from Keychain. " +
            'Try re-running `cursor-agent login`, grant Keychain access when prompted, ' +
            'or set `CURSOR_API_KEY` in your environment.',
          metadata: { recoverable: false, kind: 'keychain' },
        } as OutputMessage);
        logger.warn('cursor-agent keychain issue', { text: chunk.trim() });
        return;
      }

      // Generic error path — banners/info also hit stderr; only escalate if
      // the text looks like a real error. Emit an error OutputMessage so
      // consumers can surface it alongside other turn events.
      if (/error|fatal|failed/i.test(chunk)) {
        this.emit('output', {
          id: generateId(),
          timestamp: Date.now(),
          type: 'error',
          content: chunk.trim(),
          metadata: { recoverable: false, kind: 'stderr' },
        } as OutputMessage);
        logger.warn('cursor-agent stderr', { text: chunk.trim() });
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

      const duration = Date.now() - this.activeStartTime;

      if (code !== 0 && code !== null) {
        const rs = this.activeResultState;

        // Feature-detect fallback for --stream-partial-output. If the installed
        // cursor-agent doesn't recognize the flag, retry once without it and
        // cache the fallback on the adapter so subsequent turns also skip it.
        if (
          rs &&
          !rs.completed &&
          this.partialOutputSupported &&
          !rs.retriedWithoutPartial &&
          /(?:unknown|unrecognized)\s+(?:flag|option|argument).*--stream-partial-output|--stream-partial-output.*(?:unknown|unrecognized)/i.test(stderrBuffer)
        ) {
          logger.info('cursor-agent rejected --stream-partial-output; disabling and retrying');
          this.partialOutputSupported = false;
          rs.retriedWithoutPartial = true;
          // Pre-clean state — dispatchTurn's cleanup prologue handles listeners,
          // but we set these to null so the retry's cleanup is a no-op rather
          // than racing with the already-fired close event.
          this.process = null;
          if (this.activeTimeout) {
            clearTimeout(this.activeTimeout);
            this.activeTimeout = null;
          }
          this.activeResultState = null;
          this.retryCurrentMessage(rs);
          return;
        }

        this.process = null;
        this.activeResultState = null;
        if (this.activeTimeout) {
          clearTimeout(this.activeTimeout);
          this.activeTimeout = null;
        }
        if (rs && !rs.completed) {
          rs.completed = true;
          rs.rejecter(new Error(`cursor-agent exited with code ${code}: ${stderrBuffer.trim() || 'no stderr'}`));
        }
        return;
      }

      // If handleResultEvent already completed the call, don't double-resolve.
      if (this.activeResultState?.completed) {
        this.process = null;
        this.activeResultState = null;
        if (this.activeTimeout) {
          clearTimeout(this.activeTimeout);
          this.activeTimeout = null;
        }
        return;
      }

      // Fallback: close arrived without a terminal result event. Synthesize a
      // minimal CliResponse via parseOutput (Tasks 17+ keep parseOutput a stub;
      // this path is only exercised if cursor-agent exits unexpectedly).
      const response = this.parseOutput(this.outputBuffer);
      response.usage = { ...response.usage, duration };
      this.emit('complete', response);
      const rs = this.activeResultState;
      this.process = null;
      this.activeResultState = null;
      if (this.activeTimeout) {
        clearTimeout(this.activeTimeout);
        this.activeTimeout = null;
      }
      if (rs) {
        rs.completed = true;
        rs.resolver(response);
      }
    });

    // Fallback per-call timeout — belt and braces on top of BaseCliAdapter's
    // stream-idle watchdog (which only fires when stdout is silent).
    const timeoutMs = this.cliConfig.timeout ?? this.config.timeout ?? 300_000;
    this.activeTimeout = setTimeout(() => {
      if (this.process) {
        try {
          this.process.kill('SIGTERM');
        } catch {
          /* ignored */
        }
        const rs = this.activeResultState;
        this.activeResultState = null;
        this.activeTimeout = null;
        if (rs && !rs.completed) {
          rs.completed = true;
          rs.rejecter(new Error(`Cursor CLI timeout after ${timeoutMs}ms`));
        }
      }
    }, timeoutMs);
  }

  /**
   * Resume-failure retry hook (Task 21). Replays the current turn's message
   * through dispatchTurn, which handles cleanup of the previous spawn.
   */
  private retryCurrentMessage(resultState: ResultState): void {
    this.dispatchTurn(resultState.message, resultState);
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
        if (this.activeResultState) {
          this.handleResultEvent(event, this.activeResultState, this.activeStartTime);
        }
        break;
    }
  }

  // Stub handlers — Task 18/19/20 will fill bodies.

  private handleAssistantEvent(event: CursorAssistantEvent, ctx: StreamContext): void {
    const text = event.message?.content?.[0]?.text ?? '';
    if (!text) return;

    let messageId = ctx.streamingMessageId();
    if (!messageId) {
      messageId = generateId();
      ctx.setStreamingMessageId(messageId);
    }

    const isDelta = !!event.timestamp_ms || !!event.model_call_id;
    if (isDelta) {
      ctx.markDeltaSeen();
      ctx.appendStreamingContent(text);
      const current = ctx.getStreamingContent();
      const extracted = extractThinkingContent(current);
      this.emit('output', {
        id: messageId,
        timestamp: Date.now(),
        type: 'assistant',
        content: text,
        metadata: { streaming: true, accumulatedContent: extracted.response, thinkingExtracted: true },
        thinking: extracted.thinking.length > 0 ? extracted.thinking : undefined,
      } as OutputMessage);
      return;
    }

    // Final (non-delta) assistant event — apply dedupe rule.
    const streamed = ctx.getStreamingContent();
    if (ctx.hasDeltaSeen() && streamed.length > 0) {
      if (text === streamed || streamed.startsWith(text)) {
        // final ⊆ streamed — emit terminal flush only, no new text.
        this.emitAssistantFlush(messageId, streamed);
        return;
      }
      if (text.startsWith(streamed)) {
        // final extends streamed — emit suffix delta, then flush.
        const suffix = text.slice(streamed.length);
        if (suffix) {
          ctx.appendStreamingContent(suffix);
          const extracted = extractThinkingContent(ctx.getStreamingContent());
          this.emit('output', {
            id: messageId,
            timestamp: Date.now(),
            type: 'assistant',
            content: suffix,
            metadata: { streaming: true, accumulatedContent: extracted.response, thinkingExtracted: true },
            thinking: extracted.thinking.length > 0 ? extracted.thinking : undefined,
          } as OutputMessage);
        }
        this.emitAssistantFlush(messageId, ctx.getStreamingContent());
        return;
      }
      // Unexpected — concat safely (defensive; don't lose text).
      logger.warn('Cursor assistant final does not extend or equal streamed content; concatenating');
      ctx.appendStreamingContent(text);
      this.emitAssistantFlush(messageId, ctx.getStreamingContent());
      return;
    }

    // No deltas seen — final is the only emission.
    ctx.appendStreamingContent(text);
    this.emitAssistantFlush(messageId, text);
  }

  private emitAssistantFlush(messageId: string, fullContent: string): void {
    const extracted = extractThinkingContent(fullContent);
    this.emit('output', {
      id: messageId,
      timestamp: Date.now(),
      type: 'assistant',
      content: '',
      metadata: { streaming: false, accumulatedContent: extracted.response, thinkingExtracted: true },
      thinking: extracted.thinking.length > 0 ? extracted.thinking : undefined,
    } as OutputMessage);
  }

  private extractToolName(toolCall: Record<string, unknown>): { name: string; input: unknown } {
    const keys = Object.keys(toolCall);
    if (keys.length === 0) return { name: 'unknown_tool', input: null };
    const firstKey = keys[0];
    const stripped = firstKey.replace(/ToolCall$/, '');
    const name = stripped.length === 0 ? 'unknown_tool' : stripped.charAt(0).toLowerCase() + stripped.slice(1);
    return { name: name || 'unknown_tool', input: toolCall[firstKey] };
  }

  private handleToolCallEvent(event: CursorToolCallEvent): void {
    const { name, input } = this.extractToolName(event.tool_call ?? {});
    const callId = event.call_id;

    if (event.subtype === 'started') {
      this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: 'tool_use',
        content: `Using tool: ${name}`,
        metadata: { toolName: name, callId, input },
      } as OutputMessage);
      return;
    }

    // subtype === 'completed'
    const innerValue = (input ?? {}) as Record<string, unknown>;
    const rawError = innerValue['error'];
    const innerError: unknown =
      rawError !== undefined && rawError !== null
        ? rawError
        : innerValue['success'] === false
          ? 'failed'
          : undefined;
    const failed = event.is_error === true || innerError !== undefined;

    this.emit('output', {
      id: generateId(),
      timestamp: Date.now(),
      type: 'tool_result',
      content: failed
        ? `Tool ${name} failed${innerError !== undefined ? `: ${String(innerError)}` : ''}`
        : `Tool ${name} completed`,
      metadata: { toolName: name, callId, success: !failed, output: innerValue, error: innerError },
    } as OutputMessage);

    if (failed) {
      this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error',
        content: `Tool ${name} failed: ${String(innerError ?? 'unknown error')}`,
        metadata: { toolName: name, callId },
      } as OutputMessage);
    }
  }

  private handleResultEvent(event: CursorResultEvent, resultState: ResultState, startTime: number): void {
    if (resultState.completed) return;
    resultState.completed = true;

    // 1. Capture session_id for subsequent --resume (even on error — harmless).
    if (event.session_id) this.cursorSessionId = event.session_id;

    // 2. Emit directional context usage.
    const durationMs = event.duration_ms ?? (Date.now() - startTime);
    // NOTE: this is a raw NDJSON-stream byte estimate (bytes/4), not true model
    // output tokens. Cursor does not emit per-turn token counts, so we provide
    // this as a directional signal only. Consumers computing cost should treat
    // it as an upper-bound noise floor.
    const outputTokens = this.estimateTokens(this.outputBuffer);
    const contextWindow = this.getCapabilities().contextWindow;
    const used = Math.min(outputTokens, contextWindow);
    const contextUsage: ContextUsage = {
      used,
      total: contextWindow,
      percentage: contextWindow > 0 ? Math.min((used / contextWindow) * 100, 100) : 0,
    };
    this.emit('context', contextUsage);

    // 3. Branch on is_error.
    if (event.is_error) {
      const errMsg = event.result ?? 'Cursor returned is_error without a result message';

      // Task 21 — Resume-failure fallback: if the error looks like a stale
      // session_id and we haven't already retried this turn, clear the resume
      // id, notify the user, and re-spawn without --resume.
      if (
        this.cursorSessionId &&
        !resultState.retriedWithoutResume &&
        this.RESUME_FAILURE_PATTERN.test(errMsg)
      ) {
        logger.info('Cursor session expired; clearing and retrying once without --resume', {
          prevSessionId: this.cursorSessionId,
        });
        this.cursorSessionId = null;
        resultState.retriedWithoutResume = true;
        this.emit('output', {
          id: generateId(),
          timestamp: Date.now(),
          type: 'error',
          content: 'Previous Cursor session expired; starting fresh.',
          metadata: { recoverable: true, retryKind: 'resume-fallback' },
        } as OutputMessage);
        this.retryCurrentMessage(resultState);
        return;
      }

      this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error',
        content: errMsg,
        metadata: { sessionId: event.session_id, requestId: event.request_id },
      } as OutputMessage);
      resultState.rejecter(new Error(errMsg));
      return;
    }

    // 4. Success — construct CliResponse, emit 'complete', resolve.
    const response: CliResponse = {
      id: this.generateResponseId(),
      content: event.result ?? '',
      role: 'assistant',
      usage: { duration: durationMs, outputTokens },
      metadata: { sessionId: event.session_id, requestId: event.request_id },
      raw: this.outputBuffer,
    };
    this.emit('complete', response);
    resultState.resolver(response);
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
   * "Spawn" the adapter — validates cursor-agent is available and marks the
   * adapter ready. The Cursor CLI runs exec-per-message, so there is no
   * persistent process. Each sendMessage() spawns a fresh child.
   */
  async spawn(): Promise<number> {
    if (this.isSpawned) {
      throw new Error('Adapter already spawned');
    }

    const status = await this.checkStatus();
    if (!status.available) {
      throw new Error(
        `cursor-agent not available: ${status.error ?? 'cursor-agent command not found'}. ` +
        `Install from https://cursor.com/cli (curl https://cursor.com/install -fsSL | bash).`,
      );
    }

    this.isSpawned = true;
    // Synthetic PID — no persistent process to attach to. Each sendMessage()
    // spawns a child whose real PID is available via getPid() while in flight.
    const fakePid = Math.floor(Math.random() * 100_000) + 10_000;
    this.emit('spawned', fakePid);
    this.emit('status', 'idle');
    return fakePid;
  }

  /**
   * Terminate the adapter. Clears cursor-specific session state; the parent
   * class terminates any in-flight spawned child.
   */
  override async terminate(graceful = true): Promise<void> {
    const wasSpawned = this.isSpawned;
    await super.terminate(graceful);
    this.isSpawned = false;
    this.cursorSessionId = null;
    this.partialOutputSupported = true; // reset feature flag for next spawn
    this.activeResultState = null;
    if (this.activeTimeout) {
      clearTimeout(this.activeTimeout);
      this.activeTimeout = null;
    }
    if (wasSpawned) {
      this.emit('status', 'terminated');
    }
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
