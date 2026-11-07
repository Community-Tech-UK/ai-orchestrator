/**
 * Antigravity CLI Adapter — spawns and manages Google Antigravity CLI (`agy`).
 *
 * Replaces the retired Google Gemini CLI adapter. Antigravity runs one process
 * per message in non-interactive print mode
 * (`agy --output-format stream-json --print <prompt>`). It exposes the same
 * spawn/sendInput surface the InstanceManager expects.
 *
 * stream-json reports every step of the turn (see antigravity-stream-json.ts),
 * so the transcript shows each tool call, its result and the reply text as they
 * happen, and usage comes from agy's own token counts. It also lets a turn run
 * for as long as it keeps making progress: until 7 November 2026 this adapter
 * read plain text, which arrives only when the turn ends, and stopped every
 * turn at a fixed five minutes, cutting off long jobs that were still working.
 */

import {
  BaseCliAdapter,
  type AdapterInputDispatch,
  AdapterRuntimeCapabilities,
  CliAdapterConfig,
  CliCapabilities,
  CliStatus,
  CliMessage,
  CliResponse,
  CliUsage,
  type ResumeAttemptResult,
} from './base-cli-adapter';
import { getLogger } from '../../logging/logger';
import { errorDiagnostic, textDiagnostic } from '../../logging/source-diagnostics';
import type {
  OutputMessage,
  ContextUsage,
  InstanceStatus,
  FileAttachment,
} from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { computeTokenCost } from '../../../shared/data/model-pricing';
import {
  isAntigravityModelId,
  resolveModelReplacementForProvider,
} from '../../../shared/types/provider.types';
import { extractThinkingContent, ThinkingBlock } from '../../../shared/utils/thinking-extractor';
import { NdjsonLineBuffer, splitCompleteNdjsonLines } from '../json-parse';
import { wrapRtkAwareness } from '../rtk/rtk-awareness';
import { probeVersionStatus } from './cli-status-probe';
import { killProcessGroup } from './base-cli-process-utils';

import { assertAdapterInputCurrent, createAdapterInputDispatch } from './adapter-input-dispatch';
import { AntigravityStreamReader, antigravityUsageToCliUsage } from './antigravity-stream-json';
import type { SurfacedToUserError } from './surfaced-error';

const logger = getLogger('AntigravityCliAdapter');

/** A turn that reports no progress for this long is stopped. */
export const ANTIGRAVITY_SILENCE_LIMIT_MS = 5 * 60_000;
/**
 * The same limit while one of agy's tools is running. agy reports nothing until
 * a tool finishes (a shell command is silent for its whole run), so a test suite
 * or build needs far longer than a model step.
 */
export const ANTIGRAVITY_TOOL_SILENCE_LIMIT_MS = 30 * 60_000;
/** How much of agy's stderr is kept as a failure reason. */
const STDERR_TAIL_LIMIT = 4000;

/**
 * A turn that agy accepted and then failed. sendInputImpl puts the reason in
 * the transcript, so callers must not add a "could not be delivered" notice:
 * the message was delivered and agy worked on it.
 */
export class AntigravityTurnError extends Error implements SurfacedToUserError {
  readonly surfacedToUser = true;

  constructor(message: string) {
    super(message);
    this.name = 'AntigravityTurnError';
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Antigravity CLI specific configuration
 */
export interface AntigravityCliConfig {
  /** Model to use (opaque — passed through to `agy --model`). */
  model?: string;
  /** Run in sandbox mode (`--sandbox`). */
  sandbox?: boolean;
  /** Working directory */
  workingDir?: string;
  /**
   * Longest one turn may run, in milliseconds, for callers that need an answer
   * by a deadline (reviews, titles). Absent means no limit; a turn is still
   * stopped after ANTIGRAVITY_SILENCE_LIMIT_MS without progress
   * (ANTIGRAVITY_TOOL_SILENCE_LIMIT_MS while a tool runs).
   */
  timeout?: number;
  /** Auto-approve mode (maps to `--dangerously-skip-permissions`). */
  yolo?: boolean;
  /** System prompt (prepended to the message content; agy has no system flag). */
  systemPrompt?: string;
  /** Composer-owned later-turn prompt. Absent means repeat the raw prompt verbatim; empty is intentional. */
  systemPromptAfterFirstTurn?: string;
  /** Extra environment variables for the agy subprocess. */
  env?: Record<string, string>;
  /** Alias for yolo (used by the adapter factory). */
  yoloMode?: boolean;
  /**
   * When true, prepend the RTK awareness prompt to message content so the model
   * prefixes shell commands with `rtk`. agy runs exec-per-message so awareness
   * is reinjected on every call.
   */
  rtkEnabled?: boolean;
}

/**
 * Antigravity CLI Adapter
 */
export class AntigravityCliAdapter extends BaseCliAdapter {
  protected override readonly defersInputDispatch = true;
  private cliConfig: AntigravityCliConfig;
  /** Running total of tokens used across all turns. */
  private cumulativeTokensUsed = 0;
  /** Running USD cost across all turns (agy reports tokens, not dollars). */
  private cumulativeCostUsd = 0;
  private isSpawned = false;
  private advisoryMemoryDelivered = false;

  constructor(config: AntigravityCliConfig = {}) {
    const adapterConfig: CliAdapterConfig = {
      // Bare `agy`; BaseCliAdapter.resolveSpawnTarget resolves it to an absolute
      // path via which/where at spawn time (POSIX spawn() otherwise resolves a
      // bare command against the inherited, often-stripped PATH and ENOENTs when
      // agy lives in ~/.local/bin — the failure that silently handed every
      // reviewer slot to the copilot fallback).
      command: 'agy',
      args: [],
      cwd: config.workingDir,
      timeout: config.timeout,
      env: config.env,
      sessionPersistence: true,
    };
    super(adapterConfig);

    this.cliConfig = {
      ...config,
      yolo: config.yolo ?? config.yoloMode,
    };
    this.sessionId = `antigravity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // ============ BaseCliAdapter Abstract Implementations ============

  getName(): string {
    return 'antigravity-cli';
  }

  getCapabilities(): CliCapabilities {
    return {
      streaming: true,
      toolUse: true,
      fileAccess: true,
      shellExecution: true,
      multiTurn: true,
      vision: false,
      codeExecution: true,
      contextWindow: 1000000,
      outputFormats: ['stream-json'],
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
    return null; // agy print mode is treated as stateless per message
  }

  async checkStatus(): Promise<CliStatus> {
    return probeVersionStatus({
      spawn: () => this.spawnProcess(['--version']),
      path: 'agy',
      timeoutError: 'Timeout checking Antigravity CLI',
      spawnError: (err) => `Failed to spawn agy: ${err.message}`,
      unavailableError: ({ output }) => `Antigravity CLI (agy) not found or not configured: ${output}`,
      isAvailable: ({ code, version }) => code === 0 || Boolean(version),
      authenticated: ({ output }) => !/not authenticated|sign in|login required/i.test(output),
    });
  }

  async sendMessage(message: CliMessage, dispatch?: AdapterInputDispatch): Promise<CliResponse> {
    assertAdapterInputCurrent(dispatch);
    if (message.attachments && message.attachments.length > 0) {
      throw new Error('Antigravity adapter does not currently support attachments in orchestrator mode.');
    }

    const startTime = Date.now();
    this.outputBuffer = '';

    return new Promise((resolve, reject) => {
      const args = this.buildArgs(message);
      assertAdapterInputCurrent(dispatch);
      dispatch?.beforeProviderDispatch?.();
      assertAdapterInputCurrent(dispatch);
      const nativeProcess = this.spawnProcess(args);
      this.process = nativeProcess;

      const reader = new AntigravityStreamReader();
      const lines = new NdjsonLineBuffer();
      let stderrTail = '';
      let settled = false;
      let silenceTimer: NodeJS.Timeout | undefined;
      let deadlineTimer: NodeJS.Timeout | undefined;

      const clearTimers = (): void => {
        clearTimeout(silenceTimer);
        clearTimeout(deadlineTimer);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(error);
      };
      // Once agy has accepted the prompt the turn did run, so the failure is
      // not a delivery failure (see AntigravityTurnError).
      const turnError = (text: string): Error => reader.started ? new AntigravityTurnError(text) : new Error(text);
      const stop = (text: string): void => {
        if (settled) return;
        killProcessGroup(nativeProcess.pid, 'SIGTERM');
        fail(turnError(text));
      };

      // agy reports every step, so a quiet agy is a stuck agy. A turn that keeps
      // reporting progress runs for as long as it needs.
      const armSilenceLimit = (): void => {
        clearTimeout(silenceTimer);
        const limitMs = reader.toolRunning() ? ANTIGRAVITY_TOOL_SILENCE_LIMIT_MS : ANTIGRAVITY_SILENCE_LIMIT_MS;
        silenceTimer = setTimeout(
          () => stop(`Antigravity stopped responding: no progress for ${Math.round(limitMs / 60_000)} minutes`),
          limitMs,
        );
      };
      armSilenceLimit();
      const deadlineMs = this.cliConfig.timeout;
      if (deadlineMs) {
        deadlineTimer = setTimeout(
          () => stop(`Antigravity CLI timeout after ${Math.round(deadlineMs / 1000)} seconds`),
          deadlineMs,
        );
      }

      nativeProcess.on('error', (err) => {
        if (this.process === nativeProcess) this.process = null;
        fail(new Error(`Failed to spawn agy CLI: ${err.message}`));
      });

      // agy reads its prompt from argv; close stdin.
      nativeProcess.stdin?.end();

      const handleLine = (line: string): void => {
        const messages = reader.readLine(line);
        if (messages === null) {
          logger.debug('Ignoring agy stdout line that is not a stream-json event', textDiagnostic(line));
          return;
        }
        for (const output of messages) this.emit('output', output);
      };

      nativeProcess.stdout?.on('data', (data) => {
        if (settled || dispatch?.signal?.aborted) return;
        const chunk = data.toString();
        this.outputBuffer += chunk;
        for (const line of lines.push(chunk)) handleLine(line);
        armSilenceLimit();
      });

      // agy repeats its errors on stderr and also writes them into the result
      // event, so stderr is a diagnostic here. It becomes the failure reason
      // only when agy exits without a result.
      nativeProcess.stderr?.on('data', (data) => {
        if (settled || dispatch?.signal?.aborted) return;
        armSilenceLimit();
        const text = data.toString();
        const trimmed = text.trim();
        if (trimmed) logger.debug('agy stderr', textDiagnostic(trimmed));
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_LIMIT);
      });

      nativeProcess.on('close', (code) => {
        if (this.process === nativeProcess) this.process = null;
        if (dispatch?.signal?.aborted) {
          try { assertAdapterInputCurrent({ signal: dispatch.signal }); } catch (error) { fail(asError(error)); }
          return;
        }
        if (settled) return;
        const trailing = lines.flush();
        if (trailing) handleLine(trailing);

        const result = reader.result;
        if (result && result.status !== 'SUCCESS') {
          fail(turnError(result.error?.trim() || `Antigravity ended the turn with status ${result.status}`));
          return;
        }
        // Without a result, only a clean exit or streamed reply text counts.
        if (!result && code !== 0 && !reader.streamedText().trim()) {
          fail(turnError(stderrTail.trim() || `agy exited with code ${code}`));
          return;
        }
        if (!result) logger.warn('agy finished without a result event', { code });

        settled = true;
        clearTimers();
        const reply = reader.unstreamedReply();
        if (reply) this.emit('output', reply);
        const response = this.buildResponse(reader, this.outputBuffer);
        response.usage = { ...response.usage, duration: Date.now() - startTime };
        this.completeResponse(response);
        if (result || code === 0) this.advisoryMemoryDelivered = true;
        resolve(response);
      });

      const onAbort = (): void => {
        try { assertAdapterInputCurrent({ signal: dispatch?.signal }); } catch (error) { fail(asError(error)); }
        clearTimers();
        killProcessGroup(nativeProcess.pid, 'SIGTERM');
        if (this.process === nativeProcess) this.process = null;
      };
      const detachAbort = (): void => dispatch?.signal?.removeEventListener('abort', onAbort);
      dispatch?.signal?.addEventListener('abort', onAbort, { once: true });
      nativeProcess.once('close', detachAbort);
      nativeProcess.once('error', detachAbort);
      nativeProcess.on('close', clearTimers);
      if (dispatch?.signal?.aborted) onAbort();
    });
  }

  async *sendMessageStream(message: CliMessage): AsyncIterable<string> {
    const args = this.buildArgs(message);
    this.process = this.spawnProcess(args);
    let spawnError: Error | null = null;
    this.process.on('error', (err) => {
      spawnError = new Error(`Failed to spawn agy CLI: ${err.message}`);
      this.emitErrorIfObserved(spawnError);
      this.process = null;
    });

    if (this.process.stdin) {
      this.process.stdin.end();
    }

    const stdout = this.process.stdout;
    if (!stdout) return;

    const reader = new AntigravityStreamReader();
    const lines = new NdjsonLineBuffer();
    const textOf = (line: string): string => (reader.readLine(line) ?? [])
      .filter(output => output.type === 'assistant')
      .map(output => output.content)
      .join('');
    for await (const chunk of stdout) {
      if (spawnError) return;
      for (const line of lines.push(chunk.toString())) {
        const text = textOf(line);
        if (text) yield text;
      }
    }
    const trailing = lines.flush();
    const tail = trailing ? textOf(trailing) : '';
    if (tail) yield tail;
    if (reader.result?.status === 'SUCCESS') this.advisoryMemoryDelivered = true;
  }

  parseOutput(raw: string): CliResponse & { thinking?: ThinkingBlock[] } {
    const reader = new AntigravityStreamReader();
    for (const line of splitCompleteNdjsonLines(raw)) reader.readLine(line);
    return this.buildResponse(reader, raw);
  }

  private buildResponse(reader: AntigravityStreamReader, raw: string): CliResponse & { thinking?: ThinkingBlock[] } {
    const extracted = extractThinkingContent(reader.responseText().trim());
    const result = reader.result;
    const usage: CliUsage = result?.usage
      ? antigravityUsageToCliUsage(result.usage)
      : { inputTokens: 0, outputTokens: this.estimateTokens(extracted.response), isEstimated: true };
    if (result && result.deniedActions.length > 0) {
      // Only happens without --dangerously-skip-permissions (reviews, titles):
      // agy refuses tools it cannot ask about and may then answer with nothing.
      logger.warn('agy refused tools it could not ask permission for', { deniedActions: result.deniedActions });
    }

    return {
      id: this.generateResponseId(),
      content: extracted.response,
      role: 'assistant',
      usage,
      raw,
      thinking: extracted.thinking.length > 0 ? extracted.thinking : undefined,
      metadata: {
        ...(reader.conversationId ? { conversationId: reader.conversationId } : {}),
        ...(reader.contextTokens !== null ? { contextTokens: reader.contextTokens } : {}),
        ...(result && result.deniedActions.length > 0 ? { deniedActions: result.deniedActions } : {}),
      },
    };
  }

  protected buildArgs(message: CliMessage): string[] {
    const args: string[] = [];

    // Forward the selected model iff agy currently lists it. agy's `--model`
    // takes the display label from `agy models` (e.g. "Gemini 3.8 Flash
    // (Medium)"), and since agy 1.4 an unknown value fails the turn outright
    // ("not recognized as a known model"). Resolved here, at the spawn
    // boundary, because wake/restart/resume rebuild the config from the
    // persisted model: a label on the known list is kept as-is, a retired label
    // maps to its successor, and anything else agy does not list (a legacy
    // `gemini-*` id inherited from a normalized Gemini instance, a label dropped
    // since the last release) is left off so agy uses its own default.
    const model = isAntigravityModelId(this.cliConfig.model)
      ? this.cliConfig.model?.trim()
      : resolveModelReplacementForProvider('antigravity', this.cliConfig.model);
    if (model && isAntigravityModelId(model)) {
      args.push('--model', model);
    } else if (model) {
      logger.warn('Antigravity does not list this model; letting agy use its default', {
        model,
      });
    }

    if (this.cliConfig.sandbox) {
      args.push('--sandbox');
    }

    // agy has its own workspace concept, independent of the spawned process's
    // OS-level cwd (which we also set, for whatever agy uses it for) — without
    // --add-dir, agy operates against its own persistent default scratch
    // directory (~/.gemini/antigravity-cli/scratch) regardless of the working
    // directory the instance is actually scoped to (LT-146).
    if (this.cliConfig.workingDir) {
      args.push('--add-dir', this.cliConfig.workingDir);
    }

    // Auto-approve all tool permission requests (the orchestrator is the
    // approval layer for managed instances). Without this, agy would block on
    // interactive permission prompts in non-interactive print mode.
    if (this.cliConfig.yolo) {
      logger.warn('Auto-approve (--dangerously-skip-permissions) enabled for Antigravity instance', {
        sessionId: this.sessionId,
        model: this.cliConfig.model,
      });
      args.push('--dangerously-skip-permissions');
    }

    // One JSON event per step (tool calls, reply text, token usage), so the
    // transcript shows progress and a long turn is not mistaken for a stuck one.
    args.push('--output-format', 'stream-json');

    // `--print <prompt>` must come last: the prompt is consumed as its value.
    // T48: agy print mode has no resume, so RTK awareness is wrapped every turn.
    const systemPrompt = (this.advisoryMemoryDelivered
      ? this.cliConfig.systemPromptAfterFirstTurn ?? this.cliConfig.systemPrompt
      : this.cliConfig.systemPrompt) ?? '';
    const baseContent = systemPrompt
      ? `${systemPrompt}\n\n${message.content}`
      : message.content;
    const promptText = this.cliConfig.rtkEnabled
      ? `${wrapRtkAwareness()}\n\n${baseContent}`
      : baseContent;
    args.push('--print', promptText);

    return args;
  }

  // ============ Private Helpers ============

  private emitErrorIfObserved(error: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
      return;
    }
    logger.warn('Antigravity CLI error without listener', errorDiagnostic(error));
  }

  // ============ InstanceManager Compatibility API ============

  /**
   * "Spawn" the adapter — validates agy availability and marks it ready.
   * Like Gemini, agy runs exec-per-message rather than a persistent process.
   */
  async spawn(): Promise<number> {
    if (this.isSpawned) {
      throw new Error('Adapter already spawned');
    }

    const status = await this.checkStatus();
    if (!status.available) {
      throw new Error(`Antigravity CLI not available: ${status.error || 'agy command not found'}`);
    }

    this.isSpawned = true;
    const fakePid = Math.floor(Math.random() * 100000) + 10000;
    this.emit('spawned', fakePid);
    this.emit('status', 'idle' as InstanceStatus);
    return fakePid;
  }

  protected override async sendInputImpl(message: string, attachments?: FileAttachment[], _metadata?: CliMessage['metadata'], dispatch?: AdapterInputDispatch): Promise<void> {
    const admission = createAdapterInputDispatch(dispatch);
    assertAdapterInputCurrent(admission);
    if (!this.isSpawned) {
      throw new Error('Adapter not spawned - call spawn() first');
    }
    if (attachments && attachments.length > 0) {
      throw new Error('Antigravity adapter does not currently support attachments in orchestrator mode.');
    }

    this.emit('status', 'busy' as InstanceStatus);

    try {
      const response = await this.sendMessage({ role: 'user', content: message }, admission);

      if (response.usage) {
        const inputTokens = response.usage.inputTokens || 0;
        const outputTokens = response.usage.outputTokens || 0;
        const cacheReadTokens = response.usage.cacheReadTokens || 0;
        const turnTokens = response.usage.totalTokens || inputTokens + cacheReadTokens + outputTokens;
        this.cumulativeTokensUsed += turnTokens;
        this.cumulativeCostUsd += computeTokenCost(this.cliConfig.model, { inputTokens, outputTokens, cacheReadTokens });
        const contextWindow = this.getCapabilities().contextWindow;
        // A turn makes many model calls; the context in use is the last one's,
        // not the turn's total.
        const contextTokens = response.metadata?.['contextTokens'];
        const used = Math.min(typeof contextTokens === 'number' ? contextTokens : turnTokens, contextWindow);
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
      assertAdapterInputCurrent(admission);
      if (error instanceof Error && error.name === 'AbortError') throw error;
      this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error',
        content: error instanceof Error ? error.message : String(error),
      } as OutputMessage);
      this.emit('status', 'error' as InstanceStatus);
      this.emitErrorIfObserved(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  override async terminate(graceful = true): Promise<void> {
    const wasSpawned = this.isSpawned;
    await super.terminate(graceful);
    this.isSpawned = false;
    if (wasSpawned) {
      this.emit('exit', 0, null);
    }
  }
}
