/**
 * Claude CLI Adapter - Spawns and manages Claude Code CLI processes
 * Extends BaseCliAdapter for multi-CLI support
 */

import { createHash } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
  ndjsonSafeStringify
} from './base-cli-adapter';
import { NdjsonParser } from '../ndjson-parser';
import { InputFormatter } from '../input-formatter';
import { processAttachments, buildMessageWithFiles } from '../file-handler';
import { getLogger } from '../../logging/logger';
import { buildDeferPermissionHookCommand } from '../hooks/hook-path-resolver';
import { HOST_CLI_CLOUD_SCHEDULER_TOOLS } from './host-cli-tool-policy';
import { buildAskUserQuestionPrompt, parseAskUserQuestions } from './ask-user-question-prompt';
import type { CliStreamMessage } from '../../../shared/types/cli.types';
import type {
  OutputMessage,
  InstanceStatus,
  ThinkingContent,
  FileAttachment
} from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { extractThinkingContent } from '../../../shared/utils/thinking-extractor';
import {
  MODEL_PRICING,
  CLAUDE_MODELS,
  getProviderModelContextWindow
} from '../../../shared/types/provider.types';
import { classifyError } from '../cli-error-handler';
import type {
  RawCliPayload,
  ClaudeCliReasoningEffort,
  UnifiedReasoningEffort,
  DeferredToolUse,
  ClaudeCliSpawnOptions,
} from './claude-cli-adapter.types';
import {
  EXCLUDE_DYNAMIC_SECTIONS_FLAG,
  detectExcludeDynamicSectionsSupport,
  helpAdvertisesExcludeDynamicSections,
  isVersionAtLeast,
} from './claude-cli-feature-probes';

export type { DeferredToolUse } from './claude-cli-adapter.types';
export type { ClaudeCliSpawnOptions } from './claude-cli-adapter.types';
export type { InputRequiredPayload } from './claude-cli-adapter.types';
export type { ClaudeCliAdapterEvents } from './claude-cli-adapter.types';
export { EXCLUDE_DYNAMIC_SECTIONS_FLAG, helpAdvertisesExcludeDynamicSections };

const logger = getLogger('ClaudeCliAdapter');

/** Minimum Claude CLI version that supports the `defer` permission decision.
 *  VALIDATED: defer works in CLI 2.1.98. Conservative estimate for first release. */
export const DEFER_MIN_VERSION = '2.1.90';

/**
 * Claude CLI Adapter - Implementation for Claude Code CLI
 */
export class ClaudeCliAdapter extends BaseCliAdapter {
  private parser: NdjsonParser;
  private formatter: InputFormatter | null = null;
  private spawnOptions: ClaudeCliSpawnOptions;
  /** Track pending permission requests to avoid duplicate prompts */
  private pendingPermissions = new Set<string>();
  /** Track permissions that user has already approved (to avoid re-prompting after retry fails) */
  private approvedPermissions = new Set<string>();
  /** Deduplicate AskUserQuestion prompts that can be emitted in multiple stream shapes */
  private emittedAskUserQuestionKeys = new Set<string>();
  /** Map tool_use ids to tool metadata for robust permission-denial parsing */
  private toolUseContexts = new Map<string, { name: string; input: Record<string, unknown> }>();
  /** Cached context window from last result message for accurate streaming percentage */
  private lastKnownContextWindow: number;
  /** Floor value from model config — CLI-reported values cannot go below this */
  private readonly contextWindowFloor: number;
  /** Whether we received per-call usage this turn (assistant/system messages). When true,
   *  the result handler should NOT overwrite context usage with cumulative modelUsage totals. */
  private hasPerCallUsageThisTurn = false;
  /** Tracks a deferred tool use when CLI pauses via PreToolUse hook `defer` decision.
   *  Non-null means the CLI process has exited and is waiting to be resumed. */
  private deferredToolUse: DeferredToolUse | null = null;
  /** Cached CLI status so defer-hook feature gating only probes the CLI once per adapter. */
  private cachedCliStatus: CliStatus | null = null;
  /**
   * Cached: whether THIS CLI binary accepts `--exclude-dynamic-system-prompt-sections`,
   * detected from `--help`. `null` until probed. Strictly gates the flag in buildArgs
   * so an older CLI (e.g. on a remote worker) never receives an option it rejects.
   */
  private excludeDynamicSectionsSupported: boolean | null = null;
  private excludeSupportPromise: Promise<boolean> | null = null;
  private cliStatusPromise: Promise<CliStatus> | null = null;

  constructor(options: ClaudeCliSpawnOptions = {}) {
    // Build env passthrough for the spawned CLI process. The PreToolUse hook
    // script reads ORCHESTRATOR_RTK_ENABLED and ORCHESTRATOR_RTK_PATH from env,
    // so they need to be present in the CLI's environment, not the orchestrator's.
    const env: Record<string, string> = { ...(options.env ?? {}) };
    if (options.rtk?.enabled && options.rtk.binaryPath) {
      env['ORCHESTRATOR_RTK_ENABLED'] = '1';
      env['ORCHESTRATOR_RTK_PATH'] = options.rtk.binaryPath;
      // Belt-and-braces: also propagate the telemetry opt-out at the CLI level
      env['RTK_TELEMETRY_DISABLED'] = '1';
    }

    const config: CliAdapterConfig = {
      command: 'claude',
      args: [],
      cwd: options.workingDirectory,
      timeout: options.timeout ?? 300000,
      sessionPersistence: true,
      env: Object.keys(env).length > 0 ? env : undefined,
    };
    super(config);

    this.spawnOptions = options;
    this.sessionId = options.sessionId || generateId();
    const knownWindow = getProviderModelContextWindow('claude-cli', options.model);
    this.lastKnownContextWindow = knownWindow;
    this.contextWindowFloor = knownWindow;
    this.parser = new NdjsonParser();
  }

  /** Returns the currently deferred tool use, or null if not paused. */
  getDeferredToolUse(): DeferredToolUse | null {
    return this.deferredToolUse;
  }

  /** Clears deferred tool use state (e.g., after successful resume). */
  clearDeferredToolUse(): void {
    this.deferredToolUse = null;
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
      contextWindow: this.lastKnownContextWindow,
      outputFormats: ['ndjson', 'text', 'json']
    };
  }

  override getRuntimeCapabilities(): AdapterRuntimeCapabilities {
    return {
      supportsResume: true,
      supportsForkSession: true,
      // Claude CLI is launched with `--print --input-format stream-json`, where
      // slash commands are NOT intercepted by the CLI — they are forwarded to
      // the model as plain user text. There is therefore no programmatic hook
      // we can call to actively trigger a real compaction; this stays false.
      supportsNativeCompaction: false,
      supportsPermissionPrompts: true,
      supportsDeferPermission: this.shouldUsePermissionHook(),
      // Claude CLI auto-compacts internally at the model's own threshold and
      // surfaces that on the output stream. Tell the orchestrator to skip its
      // background/blocking auto-trigger for Claude — only manual user-driven
      // compaction (Compact button / IPC `instance:compact`) should run the
      // strategy chain (which falls through to restart-with-summary because
      // there is no native hook).
      selfManagedAutoCompaction: true,
    };
  }

  /**
   * Enable resume mode - next spawn will use --resume with the session ID
   * to continue an existing conversation.
   */
  setResume(resume: boolean): void {
    this.spawnOptions.resume = resume;
    logger.debug('Resume mode set', { resume, sessionId: this.sessionId });
  }

  updateMcpConfig(mcpConfig: string[]): void {
    this.spawnOptions.mcpConfig = [...mcpConfig];
    logger.debug('MCP config refreshed for Claude CLI adapter', {
      sessionId: this.sessionId,
      mcpConfigCount: this.spawnOptions.mcpConfig.length,
    });
  }

  /** Temp dir holding inline-JSON args materialized to files on Windows. */
  private inlineArgTempDir: string | null = null;
  /** Dedup map: inline-JSON content → temp file path (stable across buildArgs calls). */
  private readonly inlineArgFiles = new Map<string, string>();

  /**
   * On Windows the CLI is spawned with `shell: true` (it's `claude.cmd`), so the
   * command line passes through cmd.exe — which strips the double-quotes from an
   * inline-JSON argument (Node DEP0190: shell args are concatenated, not escaped),
   * delivering invalid JSON to `claude.exe`. Proven live: `--mcp-config '{"x":1}'`
   * arrived as `{x:1}`. A file PATH has no shell-special characters and survives
   * intact, and `claude --mcp-config` / `--settings` both accept a file path. So
   * on Windows we materialize inline-JSON args (those starting with `{`) to a temp
   * file and pass the path. No-op on POSIX, where there is no shell layer.
   */
  private materializeInlineJsonArg(value: string): string {
    if (process.platform !== 'win32' || !value.trimStart().startsWith('{')) {
      return value;
    }
    const cached = this.inlineArgFiles.get(value);
    if (cached) {
      return cached;
    }
    if (!this.inlineArgTempDir) {
      this.inlineArgTempDir = mkdtempSync(join(tmpdir(), 'aio-claude-args-'));
    }
    const file = join(this.inlineArgTempDir, `arg-${this.inlineArgFiles.size}.json`);
    writeFileSync(file, value, 'utf-8');
    this.inlineArgFiles.set(value, file);
    return file;
  }

  private cleanupInlineArgTempDir(): void {
    if (!this.inlineArgTempDir) {
      return;
    }
    try {
      rmSync(this.inlineArgTempDir, { recursive: true, force: true });
    } catch {
      /* best-effort; OS temp cleanup is the backstop */
    }
    this.inlineArgTempDir = null;
    this.inlineArgFiles.clear();
  }

  private mapReasoningEffort(
    reasoningEffort: UnifiedReasoningEffort | undefined
  ): ClaudeCliReasoningEffort | undefined {
    switch (reasoningEffort) {
      case 'none':
      case 'minimal':
      case 'low':
        return 'low';
      case 'medium':
        return 'medium';
      case 'high':
        return 'high';
      case 'xhigh':
        return 'xhigh';
      case 'max':
        return 'max';
      default:
        return undefined;
    }
  }

  private buildSettingsOverlay(permissionHookEnabled: boolean): string | undefined {
    const settings: {
      ultracode?: true;
      hooks?: {
        PreToolUse: {
          matcher: string;
          hooks: {
            type: 'command';
            command: string;
          }[];
        }[];
      };
    } = {};

    if (this.spawnOptions.reasoningEffort === 'workflow') {
      settings.ultracode = true;
    }

    if (permissionHookEnabled && this.spawnOptions.permissionHookPath) {
      settings.hooks = {
        PreToolUse: [{
          matcher: 'Bash',
          hooks: [{
            type: 'command',
            command: buildDeferPermissionHookCommand(this.spawnOptions.permissionHookPath),
          }],
        }],
      };
    }

    return Object.keys(settings).length > 0 ? JSON.stringify(settings) : undefined;
  }

  async checkStatus(): Promise<CliStatus> {
    if (this.cachedCliStatus) {
      return this.cachedCliStatus;
    }
    if (this.cliStatusPromise) {
      return this.cliStatusPromise;
    }

    this.cliStatusPromise = new Promise((resolve) => {
      const proc = this.spawnProcess(['--version']);
      let output = '';
      let settled = false;
      const timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        proc.kill();
        const status: CliStatus = {
          available: false,
          error: 'Timeout checking Claude CLI'
        };
        this.cachedCliStatus = status;
        this.cliStatusPromise = null;
        resolve(status);
      }, 5000);

      const finish = (status: CliStatus): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        this.cachedCliStatus = status;
        this.cliStatusPromise = null;
        resolve(status);
      };

      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });
      proc.stderr?.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', (code) => {
        const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
        if (code === 0 || output.includes('claude')) {
          finish({
            available: true,
            version: versionMatch?.[1] || 'unknown',
            path: 'claude',
            authenticated: true // Claude CLI handles auth internally
          });
        } else {
          finish({
            available: false,
            version: versionMatch?.[1] || 'unknown',
            error: `Claude CLI not found or not configured: ${output}`
          });
        }
      });

      proc.on('error', (err) => {
        finish({
          available: false,
          error: `Failed to spawn claude: ${err.message}`
        });
      });
    });

    return this.cliStatusPromise;
  }

  /**
   * Probe `<cli> --help` once (cached) to learn whether this binary supports the
   * exclude-dynamic-sections flag. Fail-safe: any probe failure resolves to
   * `false`, so an unconfirmed CLI simply loses the optimization rather than
   * erroring on an unknown option.
   */
  private detectExcludeDynamicSupport(): Promise<boolean> {
    if (this.excludeDynamicSectionsSupported !== null) {
      return Promise.resolve(this.excludeDynamicSectionsSupported);
    }
    if (this.excludeSupportPromise) {
      return this.excludeSupportPromise;
    }
    this.excludeSupportPromise = detectExcludeDynamicSectionsSupport(
      () => this.spawnProcess(['--help']),
    ).then((supported) => {
      this.excludeDynamicSectionsSupported = supported;
      this.excludeSupportPromise = null;
      return supported;
    }, () => {
      this.excludeDynamicSectionsSupported = false;
      this.excludeSupportPromise = null;
      return false;
    });
    return this.excludeSupportPromise;
  }

  async sendMessage(message: CliMessage): Promise<CliResponse> {
    const startTime = Date.now();
    this.outputBuffer = '';
    await this.primeCliVersion();

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const allowPartialOnTimeout = message.metadata?.['allowPartialOnTimeout'] === true;
      const continueWhileActiveOnTimeout = message.metadata?.['continueWhileActiveOnTimeout'] === true;
      const activeTimeoutMsRaw = message.metadata?.['activeTimeoutMs'];
      const timeoutMs = this.config.timeout ?? 300000;
      const activeTimeoutMs =
        typeof activeTimeoutMsRaw === 'number' && Number.isFinite(activeTimeoutMsRaw) && activeTimeoutMsRaw > 0
          ? Math.floor(activeTimeoutMsRaw)
          : timeoutMs;
      let hasOutputActivity = false;
      let lastActivityAt = startTime;
      let timeoutExtensionCount = 0;

      const cleanupAfterSettle = (): void => {
        this.process = null;
        this.formatter = null;
        this.parser.reset();
      };

      const finishResolve = (response: CliResponse): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        this.completeResponse(response);
        resolve(response);
      };

      const finishReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        reject(error);
      };

      const terminateTimedOutProcess = (): void => {
        this.terminate(false).catch((error: unknown) => {
          logger.warn('Failed to terminate timed-out Claude CLI process', {
            sessionId: this.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      };

      const scheduleTimeout = (delayMs: number): void => {
        timeout = setTimeout(handleTimeout, Math.max(1, delayMs));
      };

      const handleTimeout = (): void => {
        timeout = undefined;
        if (!this.process || settled) {
          return;
        }

        const idleMs = Date.now() - lastActivityAt;
        if (continueWhileActiveOnTimeout && hasOutputActivity && idleMs < activeTimeoutMs) {
          timeoutExtensionCount += 1;
          const nextDelayMs = Math.max(1, Math.min(timeoutMs, activeTimeoutMs - idleMs));
          const idleSeconds = Math.max(0, Math.round(idleMs / 1000));
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'system',
            content: `Claude CLI is still active (${idleSeconds}s since last output); extending iteration watchdog.`,
            metadata: {
              timeoutExtended: true,
              idleMs,
              activeTimeoutMs,
              timeoutMs,
              extensionCount: timeoutExtensionCount,
            },
          });
          logger.info('Claude CLI reached timeout checkpoint but is still active; extending watchdog', {
            sessionId: this.sessionId,
            timeoutMs,
            idleMs,
            activeTimeoutMs,
            extensionCount: timeoutExtensionCount,
          });
          scheduleTimeout(nextDelayMs);
          return;
        }

        if (allowPartialOnTimeout && this.outputBuffer.trim().length > 0) {
          const duration = Date.now() - startTime;
          const response = this.parseOutput(this.outputBuffer);
          response.usage = {
            ...response.usage,
            duration
          };
          response.metadata = {
            ...response.metadata,
            timedOut: true,
            timeoutMs,
            idleMs,
            activeTimeoutMs,
            timeoutExtensions: timeoutExtensionCount,
          };
          if (!response.content.trim()) {
            response.content = 'Claude CLI reached the iteration timeout after emitting activity but before producing a final assistant message. Treat the workspace state and tool activity as the partial result, then continue from disk state in the next loop iteration.';
          }
          logger.warn('Claude CLI timeout after partial output; returning partial response', {
            sessionId: this.sessionId,
            timeoutMs,
            idleMs,
            activeTimeoutMs,
            outputLength: this.outputBuffer.length,
          });
          finishResolve(response);
        } else {
          finishReject(new Error('Claude CLI timeout'));
        }

        terminateTimedOutProcess();
      };

      const args = this.buildArgs(message);
      this.process = this.spawnProcess(args);

      // Set up stdin formatter
      if (this.process.stdin) {
        this.formatter = new InputFormatter(this.process.stdin);

        // Handle stdin errors (EPIPE when process exits before write completes)
        this.process.stdin.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EPIPE') {
            logger.warn('stdin EPIPE - CLI process closed before write completed', {
              pid: this.process?.pid,
            });
            return; // Swallow EPIPE — expected when process closes pipe during interrupt/exit
          }
          logger.error('stdin stream error', error);
          this.emit('error', error, classifyError(error));
        });
      }

      // Prepare and send message content (async setup, then sync event wiring)
      const sendInput = async (): Promise<void> => {
        let finalMessage = message.content;
        const imageAttachments =
          message.attachments?.filter(
            (a) => a.mimeType?.startsWith('image/') || a.type === 'image'
          ) || [];
        const otherAttachments =
          message.attachments?.filter(
            (a) => !a.mimeType?.startsWith('image/') && a.type !== 'image'
          ) || [];

        // Process non-image attachments
        if (otherAttachments.length > 0 && this.config.cwd) {
          const processed = await processAttachments(
            otherAttachments.map((a) => ({
              type: a.mimeType || 'text/plain',
              name: a.name || 'attachment',
              data: a.content || '',
              size: a.content?.length || 0
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
              ? imageAttachments.map((a) => ({
                  type: a.mimeType || 'image/png',
                  name: a.name || 'image',
                  data: a.content || '',
                  size: a.content?.length || 0
                }))
              : undefined
          );
          this.formatter.close();
        }
      };

      sendInput().catch((error: unknown) => {
        finishReject(error instanceof Error ? error : new Error(String(error)));
      });

      // Handle stdout (NDJSON stream)
      this.process.stdout?.on('data', (chunk: Buffer) => {
        const raw = chunk.toString();
        hasOutputActivity = true;
        lastActivityAt = Date.now();
        this.outputBuffer += raw;

        const messages = this.parser.parse(raw);
        for (const msg of messages) {
          this.processCliMessage(msg);
        }
      });

      // Handle stderr
      this.process.stderr?.on('data', (chunk: Buffer) => {
        const stderrError = new Error(chunk.toString().trim());
        this.emit('error', stderrError, classifyError(stderrError));
      });

      // Handle exit
      this.process.on('close', (code) => {
        if (settled) {
          cleanupAfterSettle();
          return;
        }

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
            duration
          };
          finishResolve(response);
        } else {
          finishReject(new Error(`Claude CLI exited with code ${code}`));
        }

        cleanupAfterSettle();
      });

      // Timeout handling. Loop Mode opts into activity-aware checkpoints:
      // the wall-clock timeout only returns a partial result once the child
      // has also been quiet past the configured stream-idle threshold.
      scheduleTimeout(timeoutMs);

      this.process.on('close', () => {
        if (timeout) clearTimeout(timeout);
      });
    });
  }

  async *sendMessageStream(message: CliMessage): AsyncIterable<string> {
    await this.primeCliVersion();
    const args = this.buildArgs(message);
    this.process = this.spawnProcess(args);

    // Set up stdin formatter
    if (this.process.stdin) {
      this.formatter = new InputFormatter(this.process.stdin);
    }

    // Send the message
    if (this.formatter && this.formatter.isWritable()) {
      await this.formatter.sendMessage(message.content);
      this.formatter.close();
    }

    const stdout = this.process.stdout;
    if (!stdout) return;

    for await (const chunk of stdout) {
      const raw = chunk.toString();
      const messages = this.parser.parse(raw);

      for (const msg of messages) {
        const raw = msg as unknown as RawCliPayload;
        if (raw.type === 'assistant' && raw.message?.content) {
          const content = raw.message.content
            .filter((block) => block.type === 'text' && block.text)
            .map((block) => block.text)
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
    // We accumulate tokens across all assistant turns as a fallback. Some CLI
    // versions emit the authoritative `result` message at the end with the
    // final tally; older versions emit `system / context_usage` (kept here for
    // backward compatibility); current 2.1.x versions place per-turn counts on
    // each `assistant.message.usage`. We prefer `result.usage` when present
    // because it's the final authoritative count after all turns settle.
    let assistantInput = 0;
    let assistantOutput = 0;
    let assistantSawAny = false;
    let resultUsage: CliUsage | null = null;
    let legacySystemTotal: number | undefined;
    let costUsd: number | undefined;

    // Parse all NDJSON lines
    const lines = raw.split('\n').filter((line) => line.trim());

    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as RawCliPayload;

        if (msg.type === 'assistant' && msg.message?.content) {
          // Extract text content
          const textContent = msg.message.content
            .filter((block) => block.type === 'text' && block.text)
            .map((block) => block.text)
            .join('');
          if (textContent) {
            content += textContent;
          }

          // Extract tool uses
          const toolUses = msg.message.content.filter(
            (block) => block.type === 'tool_use'
          );
          for (const tool of toolUses) {
            toolCalls.push({
              id: tool.id || generateId(),
              name: tool.name || '',
              arguments: tool.input || {}
            });
          }

          // Per-turn token usage (Claude CLI 2.1.x schema). Cache tokens are
          // not double-counted: we only sum the new-generation portions
          // (input_tokens + output_tokens) for our totalTokens metric.
          if (msg.message.usage) {
            assistantSawAny = true;
            assistantInput += msg.message.usage.input_tokens ?? 0;
            assistantOutput += msg.message.usage.output_tokens ?? 0;
          }
        }

        // Authoritative final tally (Claude CLI 2.1.x). The CLI emits one
        // `{type:"result", usage:{...}, total_cost_usd}` line at the end of
        // each turn. Prefer this over per-assistant accumulation. Cache
        // tokens are NOT folded into totalTokens — they reflect billing
        // (cached reads are cheaper / writes are billed once) and would
        // double-count actual generation if added here.
        if (msg.type === 'result' && msg.usage) {
          resultUsage = {
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
            totalTokens:
              (msg.usage.input_tokens ?? 0) + (msg.usage.output_tokens ?? 0),
            // Surface cache tokens separately (they were previously discarded)
            // so cost accounting can price cached reads/writes at their distinct
            // rates. They are intentionally NOT folded into totalTokens — see the
            // comment above on the generation-count metric.
            ...(typeof msg.usage.cache_read_input_tokens === 'number'
              ? { cacheReadTokens: msg.usage.cache_read_input_tokens }
              : {}),
            ...(typeof msg.usage.cache_creation_input_tokens === 'number'
              ? { cacheWriteTokens: msg.usage.cache_creation_input_tokens }
              : {}),
          };
        }
        if (msg.type === 'result' && typeof msg.total_cost_usd === 'number') {
          costUsd = msg.total_cost_usd;
        }

        // Legacy schema (older Claude CLI). Kept for backward compatibility.
        if (
          msg.type === 'system' &&
          msg.subtype === 'context_usage' &&
          msg.usage
        ) {
          legacySystemTotal = msg.usage.total_tokens;
        }
      } catch {
        // Ignore non-JSON lines
      }
    }

    const usage: CliUsage = resultUsage
      ?? (assistantSawAny
        ? {
            inputTokens: assistantInput,
            outputTokens: assistantOutput,
            totalTokens: assistantInput + assistantOutput,
          }
        : (legacySystemTotal !== undefined
          ? { totalTokens: legacySystemTotal }
          : {}));
    if (costUsd !== undefined) {
      usage.cost = costUsd;
    }

    return {
      id,
      content: content.trim(),
      role: 'assistant',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      raw
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected buildArgs(_message: CliMessage): string[] {
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose'
    ];

    // Bare mode — skip hooks, LSP, plugins, auto-memory for faster startup (~14%).
    // Requires explicit ANTHROPIC_API_KEY; OAuth/keychain auth is skipped.
    if (this.spawnOptions.bare) {
      args.push('--bare');
    }

    // Session display name — makes /resume and debugging easier
    if (this.spawnOptions.name) {
      args.push('--name', this.spawnOptions.name);
    }

    // Move per-machine dynamic sections from system prompt to first user message
    // for better cross-instance prompt cache hit rates. Only pass the flag to a CLI
    // that actually supports it (detected from --help in primeCliVersion); an older
    // CLI — e.g. on a remote worker node — rejects the unknown option and the spawn
    // fails. Strict `=== true`: omit when support is unconfirmed (safe — just loses
    // the optimization). Live-verified against a Windows worker (2026-06-03).
    if (this.spawnOptions.excludeDynamicSystemPromptSections
        && this.excludeDynamicSectionsSupported === true) {
      args.push(EXCLUDE_DYNAMIC_SECTIONS_FLAG);
    }

    const permissionHookEnabled = !this.spawnOptions.yoloMode && this.shouldUsePermissionHook();

    // YOLO mode - auto-approve all permissions
    if (this.spawnOptions.yoloMode) {
      logger.warn('YOLO mode enabled for Claude CLI instance', {
        sessionId: this.sessionId,
        model: this.spawnOptions.model
      });
      args.push('--dangerously-skip-permissions');
    } else {
      // Use acceptEdits mode to auto-approve file operations (Read, Write, Edit, etc.)
      // while still requiring approval for potentially dangerous operations like Bash
      logger.debug('NON-YOLO mode: using --permission-mode acceptEdits');
      args.push('--permission-mode', 'acceptEdits');

      // Layer defer hook on top for tools that acceptEdits doesn't auto-approve.
      // The hook intercepts matched tools (Bash, etc.) and returns `defer` to pause
      // execution, allowing the orchestrator to surface approval UI.
      // VALIDATED: --permission-mode and PreToolUse hooks work simultaneously.
      if (!permissionHookEnabled && this.spawnOptions.permissionHookPath && this.cachedCliStatus?.version) {
        logger.info('Skipping defer permission hook for unsupported Claude CLI version', {
          version: this.cachedCliStatus.version,
          minimumVersion: DEFER_MIN_VERSION,
          sessionId: this.sessionId,
        });
      }

      // Only pass --allowedTools if explicitly configured (e.g., by agent profiles).
      // By default, allow all tools — restrictions are handled via --disallowedTools.
      if (this.spawnOptions.allowedTools && this.spawnOptions.allowedTools.length > 0) {
        args.push('--allowedTools', this.spawnOptions.allowedTools.join(','));
      }
    }

    const settingsOverlay = this.buildSettingsOverlay(permissionHookEnabled);
    if (settingsOverlay) {
      args.push('--settings', this.materializeInlineJsonArg(settingsOverlay));
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

    const mappedReasoningEffort = this.mapReasoningEffort(this.spawnOptions.reasoningEffort);
    if (mappedReasoningEffort) {
      args.push('--effort', mappedReasoningEffort);
    }

    if (this.spawnOptions.maxTokens) {
      args.push('--max-tokens', this.spawnOptions.maxTokens.toString());
    }

    // Only add user-specified allowedTools if in YOLO mode (already handled above for non-YOLO)
    if (
      this.spawnOptions.yoloMode &&
      this.spawnOptions.allowedTools &&
      this.spawnOptions.allowedTools.length > 0
    ) {
      args.push('--allowedTools', this.spawnOptions.allowedTools.join(','));
    }

    // Always deny the host CLI's cloud-scheduler tools, merged with any caller-supplied
    // denylist and deduped. Enforced here — the single chokepoint every process launch
    // (cold, warm-start, resume, replay, continuity-recovery) passes through — so the
    // guarantee holds even for spawn paths that don't wire `disallowedTools` (e.g. a
    // consumed warm-start adapter whose spawnOptions only carry the working directory).
    const disallowedTools = Array.from(
      new Set<string>([
        ...HOST_CLI_CLOUD_SCHEDULER_TOOLS,
        ...(this.spawnOptions.disallowedTools ?? []),
      ]),
    );
    if (disallowedTools.length > 0) {
      args.push('--disallowedTools', disallowedTools.join(','));
    }

    // Don't pass system prompt when resuming - the session already has one
    // and Claude CLI doesn't support changing it mid-session
    if (this.spawnOptions.systemPrompt && !this.spawnOptions.resume) {
      args.push('--system-prompt', this.spawnOptions.systemPrompt);
    }

    // MCP server configurations (file paths or inline JSON strings). On Windows
    // inline JSON is materialized to a temp file path — see materializeInlineJsonArg.
    if (this.spawnOptions.mcpConfig && this.spawnOptions.mcpConfig.length > 0) {
      args.push(
        '--mcp-config',
        ...this.spawnOptions.mcpConfig.map((entry) => this.materializeInlineJsonArg(entry)),
      );
    }

    // Beta headers (API key users only) — e.g. context-1m-2025-08-07
    if (this.spawnOptions.betas && this.spawnOptions.betas.length > 0) {
      args.push('--betas', ...this.spawnOptions.betas);
    }

    if (this.spawnOptions.chrome === true) {
      args.push('--chrome');
    }

    logger.debug('buildArgs complete', {
      yoloMode: this.spawnOptions.yoloMode,
      argCount: args.length,
      resume: this.spawnOptions.resume ?? false,
      forkSession: this.spawnOptions.forkSession ?? false,
      model: this.spawnOptions.model,
      reasoningEffort: this.spawnOptions.reasoningEffort ?? null,
      mappedReasoningEffort: mappedReasoningEffort ?? null,
      hasSystemPrompt: Boolean(this.spawnOptions.systemPrompt && !this.spawnOptions.resume),
      allowedToolsCount: this.spawnOptions.allowedTools?.length ?? 0,
      disallowedToolsCount: this.spawnOptions.disallowedTools?.length ?? 0,
      mcpConfigCount: this.spawnOptions.mcpConfig?.length ?? 0,
      betasCount: this.spawnOptions.betas?.length ?? 0,
      chrome: this.spawnOptions.chrome ?? 'unset',
      bare: this.spawnOptions.bare ?? false,
      name: this.spawnOptions.name ?? null,
      excludeDynamicSystemPromptSections: this.spawnOptions.excludeDynamicSystemPromptSections ?? false,
      hasPermissionHook: this.shouldUsePermissionHook(),
      hookPathConfigured: Boolean(this.spawnOptions.permissionHookPath),
      cliVersion: this.cachedCliStatus?.version ?? null,
    });

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

    await this.primeCliVersion();
    const args = this.buildArgs({ role: 'user', content: '' });

    this.process = this.spawnProcess(args);

    if (!this.process.pid) {
      throw new Error('Failed to spawn Claude CLI process');
    }

    // Remove any temp files created for Windows inline-JSON args once the
    // process exits (it has read them at startup by then).
    this.process.once('exit', () => this.cleanupInlineArgTempDir());

    // Set up stdin formatter
    if (this.process.stdin) {
      this.formatter = new InputFormatter(this.process.stdin);

      // Handle stdin errors (EPIPE when process exits before write completes)
      this.process.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EPIPE') {
          logger.warn('stdin EPIPE - CLI process closed before write completed', {
            pid: this.process?.pid,
          });
          return; // Swallow EPIPE — expected when process closes pipe during interrupt/exit
        }
        logger.error('stdin stream error', error);
        this.emit('error', error, classifyError(error));
      });
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
      this.emit('error', error, classifyError(error));
    });

    return this.process.pid;
  }

  /**
   * Send a message to the CLI (legacy API)
   */
  protected override async sendInputImpl(message: string, attachments?: FileAttachment[]): Promise<void> {
    if (!this.formatter || !this.formatter.isWritable()) {
      throw new Error('CLI not ready for input');
    }

    // Separate images (inline) from other files (need file path)
    const imageAttachments =
      attachments?.filter((a) => a.type?.startsWith('image/')) || [];
    const otherAttachments =
      attachments?.filter((a) => !a.type?.startsWith('image/')) || [];

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

    await this.formatter.sendMessage(
      finalMessage,
      imageAttachments.length > 0 ? imageAttachments : undefined
    );
    this.emit('status', 'busy' as InstanceStatus);
  }

  /**
   * Send raw text input (for permission prompts, etc.)
   * When using stream-json input format, all responses need to be JSON formatted as user messages
   *
   * NOTE: Permission approvals from UI dialogs don't actually send to CLI stdin because
   * Claude CLI's permission system doesn't support programmatic approval in print mode.
   * The CLI already returned a permission denial error and continued - it's not waiting for input.
   * To approve tool use, users must enable YOLO mode which restarts the session with
   * --dangerously-skip-permissions.
   */
  async sendRaw(text: string, permissionKey?: string): Promise<void> {
    if (!this.formatter || !this.formatter.isWritable()) {
      throw new Error('CLI not ready for input');
    }

    // Clear the pending permission if one was specified
    if (permissionKey && this.pendingPermissions.has(permissionKey)) {
      this.pendingPermissions.delete(permissionKey);
      logger.debug('Cleared pending permission', { permissionKey });
    }

    // Check if this is a permission approval response
    const isPermissionApproval = text.toLowerCase().includes('permission granted') ||
                                  text.toLowerCase().includes('allow') ||
                                  text.toLowerCase().startsWith('y');

    // Check if this is a permission denial response
    const isPermissionDenial = text.toLowerCase().includes('permission denied') ||
                               text.toLowerCase().includes('do not perform') ||
                               text.toLowerCase().startsWith('n');

    if (permissionKey && (isPermissionApproval || isPermissionDenial)) {
      // Track permission response for future reference
      if (isPermissionApproval) {
        this.approvedPermissions.add(permissionKey);
        logger.debug('Marked permission as approved', { permissionKey });
        logger.info('Note - CLI is not waiting for input. User should enable YOLO mode to allow this tool.');
      } else {
        logger.debug('Permission denied by user', { permissionKey });
      }

      // Don't send permission responses to stdin - the CLI isn't waiting for them
      // Just update status back to idle/busy
      this.emit('status', 'idle' as InstanceStatus);
      return;
    }

    // For regular user input (not permission responses), send as JSON user message
    const userMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: text
      }
    };
    const jsonMessage = ndjsonSafeStringify(userMessage);
    logger.debug('Sending as user message', {
      contentLength: text.length,
      jsonMessageLength: jsonMessage.length,
      contentPreview: this.summarizeLogText(text),
    });
    await this.formatter.sendRaw(jsonMessage);

    this.emit('status', 'busy' as InstanceStatus);
  }

  /**
   * Clear a pending permission (called when user responds to permission prompt)
   */
  clearPendingPermission(permissionKey: string): void {
    if (this.pendingPermissions.has(permissionKey)) {
      this.pendingPermissions.delete(permissionKey);
      logger.debug('Cleared pending permission', { permissionKey });
    }
  }

  // ============ Private Helper Methods ============

  private handleStdout(chunk: Buffer): void {
    const raw = chunk.toString();

    // Log ALL message types coming through for debugging
    const typeMatch = raw.match(/"type"\s*:\s*"([^"]+)"/g);
    if (typeMatch) {
      logger.debug('Message types in chunk', { typeMatch });
    }

    // Log raw output for debugging permission and elicitation issues
    if (raw.includes('input_required') || raw.includes('elicitation') || raw.includes('permission') || raw.includes('approve') ||
        raw.includes('denied') || raw.includes('not allowed') || raw.includes('is_error')) {
      logger.debug('RAW STDOUT (permission-related)', {
        rawLength: raw.length,
        preview: this.summarizeLogText(raw, 400),
      });
    }

    const messages = this.parser.parse(raw);
    logger.debug('Parsed messages from stdout', {
      count: messages.length,
      types: messages.map(m => m.type)
    });

    for (const message of messages) {
      // Log all message types for debugging
      if (message.type === 'input_required') {
        logger.debug('Parsed input_required message, forwarding to processCliMessage');
      }
      this.processCliMessage(message);
    }
  }

  private handleStderr(chunk: Buffer): void {
    const errorText = chunk.toString().trim();
    logger.debug('handleStderr received', { errorText: errorText.substring(0, 500) });

    if (errorText) {
      // Check if this looks like a permission prompt
      if (errorText.includes('permission') || errorText.includes('approve') || errorText.includes('allow') || errorText.includes('y/n')) {
        logger.debug('STDERR contains permission-like content', {
          errorLength: errorText.length,
          preview: this.summarizeLogText(errorText, 220),
        });
      }

      const errorMessage: OutputMessage = {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error',
        content: errorText
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

    // If we have a deferred tool use, this is an expected exit (code 0) after
    // the hook returned `defer`. Don't trigger respawn — the resume flow handles it.
    if (this.deferredToolUse) {
      logger.info('Process exited with deferred tool use pending', {
        toolName: this.deferredToolUse.toolName,
        toolUseId: this.deferredToolUse.toolUseId,
        sessionId: this.deferredToolUse.sessionId,
        exitCode: code,
      });
    }

    this.emit('exit', code, signal);
  }

  private processCliMessage(message: CliStreamMessage): void {
    const raw = message as unknown as RawCliPayload;
    switch (message.type) {
      case 'assistant': {
        const assistantMsg = raw;
        let assistantContent = '';
        const thinkingBlocks: ThinkingContent[] = [];
        const assistantTimestamp = message.timestamp || Date.now();

        if (assistantMsg.message?.content) {
          for (const block of assistantMsg.message.content) {
            // Handle structured thinking blocks from Claude API (extended thinking)
            if (block.type === 'thinking' && block.thinking) {
              thinkingBlocks.push({
                id: generateId(),
                content: block.thinking,
                format: 'structured',
                timestamp: assistantTimestamp
              });
            } else if (block.type === 'text' && block.text) {
              assistantContent += block.text;
            } else if (block.type === 'tool_use' && block.name) {
              const toolUseId = block.id || generateId();
              const toolInput = block.input || {};
              this.rememberToolUse(toolUseId, block.name, toolInput);

              // Surface inline tool usage from assistant blocks for consistency.
              this.emit('output', {
                id: generateId(),
                timestamp: assistantTimestamp,
                type: 'tool_use',
                content: `Using tool: ${block.name}`,
                metadata: {
                  name: block.name,
                  id: toolUseId,
                  input: toolInput,
                }
              });

              // Claude sometimes asks questions via AskUserQuestion tool_use blocks
              // without a top-level input_required event.
              if (block.name === 'AskUserQuestion') {
                this.emitAskUserQuestionInputRequired(
                  toolUseId,
                  toolInput,
                  assistantTimestamp,
                  assistantContent
                );
              }
            }
          }
        } else if (typeof assistantMsg.content === 'string') {
          assistantContent = assistantMsg.content;
        }

        // Also extract any inline thinking from text content (explicit XML tags
        // and [THINKING] brackets only). The header/meta-reasoning heuristic is
        // disabled here: Claude already delivers genuine reasoning as structured
        // `thinking` blocks above, so re-parsing its `text` blocks would
        // mis-classify real answer content (bold headers, option lists,
        // first-person phrasing) as thinking — which then vanishes when the user
        // has thinking display turned off.
        const extracted = extractThinkingContent(assistantContent, { headerStyle: false });
        assistantContent = extracted.response;
        thinkingBlocks.push(...extracted.thinking.map(t => ({
          ...t,
          timestamp: assistantTimestamp
        })));

        if (assistantContent.trim() || thinkingBlocks.length > 0) {
          this.emit('output', {
            id: generateId(),
            timestamp: assistantTimestamp,
            type: 'assistant',
            content: assistantContent,
            // Include thinking blocks if any were found
            thinking: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
            thinkingExtracted: true
          });
        }

        // Extract context usage from assistant message (for real-time updates).
        // This is per-API-call usage and correctly reflects current context occupancy.
        if (assistantMsg.message?.usage) {
          const usage = assistantMsg.message.usage;
          // All input tokens (cached or not) occupy the context window.
          // input_tokens = non-cached, cache_creation/cache_read = cached portions.
          const totalUsedTokens =
            (usage.input_tokens || 0) +
            (usage.cache_creation_input_tokens || 0) +
            (usage.cache_read_input_tokens || 0) +
            (usage.output_tokens || 0);

          const contextWindow = this.lastKnownContextWindow;
          const percentage = (totalUsedTokens / contextWindow) * 100;

          this.hasPerCallUsageThisTurn = true;
          this.emit('context', {
            used: totalUsedTokens,
            total: contextWindow,
            percentage: Math.min(percentage, 100)
          });
        }

        this.emit('status', 'busy' as InstanceStatus);
        break;
      }

      case 'user': {
        const userMsg = raw;

        // Check for permission denial in tool_result content
        // Claude CLI returns these as user messages with tool_result content when permissions are denied
        if (userMsg.message?.content && Array.isArray(userMsg.message.content)) {
          for (const block of userMsg.message.content) {
            // Log ALL tool_result errors for diagnostic visibility
            if (
              block.type === 'tool_result' &&
              block.is_error === true &&
              typeof block.content === 'string'
            ) {
              logger.info('[APPROVAL_TRACE] tool_result_error_received', {
                toolUseId: block.tool_use_id,
                contentLength: block.content.length,
                contentPreview: this.summarizeLogText(block.content, 300),
                isPermissionDenial: this.isPermissionDenialContent(block.content)
              });
            }

            if (
              block.type === 'tool_result' &&
              block.is_error === true &&
              typeof block.content === 'string' &&
              this.isPermissionDenialContent(block.content)
            ) {
              logger.debug('Permission denial detected in tool_result', {
                toolUseId: block.tool_use_id,
                contentLength: block.content.length,
                contentPreview: this.summarizeLogText(block.content, 220)
              });

              const { action, path, displayPath } = this.extractPermissionDetails(
                block.content,
                block.tool_use_id
              );

              // Capture the authoritative tool name (e.g. 'Edit', 'Write') from the
              // original tool_use, so the renderer can request a precise settings.json
              // allow-rule on user approval.
              const denialToolContext = block.tool_use_id
                ? this.toolUseContexts.get(block.tool_use_id)
                : undefined;
              const denialToolName = denialToolContext?.name;

              // Create a unique key for this permission request to avoid duplicate prompts
              const permissionKey = this.createPermissionKey(action, path);

              // Skip if we already have a pending request for this exact permission
              if (this.pendingPermissions.has(permissionKey)) {
                logger.debug('Skipping duplicate permission prompt', {
                  permissionKey,
                  action,
                  path: displayPath
                });
                this.forgetToolUse(block.tool_use_id);
                continue;
              }

              // Skip if user already approved this permission (retry still failed but don't re-prompt)
              if (this.approvedPermissions.has(permissionKey)) {
                logger.debug('User already approved this permission, not re-prompting', {
                  permissionKey,
                  action,
                  path: displayPath
                });
                // Emit a system message to inform user - only once per permission
                const hintKey = `hint:${permissionKey}`;
                if (!this.approvedPermissions.has(hintKey)) {
                  this.approvedPermissions.add(hintKey);
                  this.emit('output', {
                    id: generateId(),
                    timestamp: Date.now(),
                    type: 'system',
                    content: `Permission for "${action} ${displayPath}" was denied by the CLI. To allow this action, enable YOLO mode (⚡ button) which auto-approves all tool use for this session.`,
                    metadata: { permissionHint: true, suggestYolo: true }
                  });
                }
                this.forgetToolUse(block.tool_use_id);
                continue;
              }

              // Track this permission request
              this.pendingPermissions.add(permissionKey);
              logger.debug('Added to pending permissions', {
                permissionKey,
                action,
                path: displayPath
              });

              const inputRequestId = generateId();
              const approvalTraceId = this.createApprovalTraceId('permission');
              const prompt = `Permission required: Claude wants to ${action} ${displayPath}. Choose Always to add a Claude allow rule and restart the session, or reject to continue with this action denied.`;
              const timestamp = message.timestamp || Date.now();

              logger.debug('Emitting input_required for permission denial', {
                inputRequestId,
                action,
                path: displayPath
              });
              logger.info('[APPROVAL_TRACE] adapter_emit_permission_denial', {
                approvalTraceId,
                instanceSessionId: this.sessionId,
                requestId: inputRequestId,
                permissionKey,
                action,
                path: displayPath,
                toolUseId: block.tool_use_id
              });

              this.emit('status', 'waiting_for_input' as InstanceStatus);

              // Emit the input_required event for UI to handle.
              // `path` is the UI-friendly (possibly truncated) string; `full_path`
              // carries the untruncated value so downstream writers (e.g. the
              // self-permission granter) can build an exact-path rule. `tool_name`
              // is the original Claude CLI tool (Write/Edit/Read/Bash), which maps
              // 1:1 to the settings.json permissions format `Tool(pattern)`.
              this.emit('input_required', {
                id: inputRequestId,
                prompt,
                timestamp,
                metadata: {
                  type: 'permission_denial',
                  tool_use_id: block.tool_use_id,
                  action,
                  path: displayPath,
                  full_path: path,
                  tool_name: denialToolName,
                  permissionKey, // Include for cleanup after response
                  approvalTraceId,
                  traceStage: 'adapter:permission_denial_emit'
                }
              });

              // Also emit as system output for visibility in chat
              this.emit('output', {
                id: inputRequestId,
                timestamp,
                type: 'system',
                content: prompt,
                metadata: {
                  requiresInput: true,
                  permissionDenial: true,
                  approvalTraceId,
                  traceStage: 'adapter:permission_denial_output'
                }
              });

              logger.debug('Permission denial handling complete');
              this.forgetToolUse(block.tool_use_id);
            }
          }
          break;
        }
        if (typeof message.content === 'string' && message.content.trim()) {
          this.emit('output', {
            id: generateId(),
            timestamp: message.timestamp || Date.now(),
            type: 'user',
            content: message.content
          });
        }
        break;
      }

      case 'system':
        if (message.subtype === 'context_usage' && message.usage) {
          const modelId = this.spawnOptions.model || CLAUDE_MODELS.OPUS_1M;
          const pricing = MODEL_PRICING[modelId] || {
            input: 3.0,
            output: 15.0
          };

          // Per-API-call usage — correctly reflects current context occupancy.
          // input_tokens = non-cached, cache_creation/cache_read = cached portions.
          const inputTokens = (message.usage.input_tokens || 0)
            + (message.usage.cache_creation_input_tokens || 0)
            + (message.usage.cache_read_input_tokens || 0);
          const outputTokens = message.usage.output_tokens || 0;
          const totalUsedTokens = inputTokens + outputTokens;

          const inputCost = (inputTokens / 1_000_000) * pricing.input;
          const outputCost = (outputTokens / 1_000_000) * pricing.output;
          const costEstimate = inputCost + outputCost;

          // max_tokens is the output token cap, NOT the context window.
          // Only trust modelUsage.contextWindow from result messages (handled below).
          const contextWindow = this.lastKnownContextWindow;
          const percentage = contextWindow > 0
            ? (totalUsedTokens / contextWindow) * 100
            : 0;

          this.hasPerCallUsageThisTurn = true;
          this.emit('context', {
            used: totalUsedTokens,
            total: contextWindow,
            percentage: Math.min(percentage, 100),
            costEstimate
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
            content: message.content
          });
        }
        break;

      case 'tool_use':
        this.rememberToolUse(message.tool.id, message.tool.name, message.tool.input);
        this.emit('output', {
          id: generateId(),
          timestamp: message.timestamp || Date.now(),
          type: 'tool_use',
          content: `Using tool: ${message.tool.name}`,
          metadata: message.tool
        });
        if (message.tool.name === 'AskUserQuestion') {
          this.emitAskUserQuestionInputRequired(
            message.tool.id,
            message.tool.input || {},
            message.timestamp || Date.now()
          );
        }
        break;

      case 'tool_result':
        this.forgetToolUse(message.tool_use_id);
        this.emit('output', {
          id: generateId(),
          timestamp: message.timestamp || Date.now(),
          type: 'tool_result',
          content: message.content,
          metadata: {
            tool_use_id: message.tool_use_id,
            is_error: message.is_error
          }
        });
        break;

      case 'result': {
        const resultMsg = raw;

        // VALIDATED: Check for tool_deferred stop reason (Claude CLI 2.1.98+).
        // When a PreToolUse hook returns `defer`, the CLI emits a result with
        // stop_reason: "tool_deferred" and a deferred_tool_use object, then exits.
        if (resultMsg.stop_reason === 'tool_deferred' && resultMsg.deferred_tool_use) {
          const deferred = resultMsg.deferred_tool_use;
          this.deferredToolUse = {
            toolName: deferred.name,
            toolInput: deferred.input || {},
            toolUseId: deferred.id,
            sessionId: resultMsg.session_id || this.sessionId || '',
            deferredAt: Date.now(),
          };

          logger.info('Tool use deferred by hook', {
            toolName: deferred.name,
            toolUseId: deferred.id,
            sessionId: this.deferredToolUse.sessionId,
          });

          // Prefer the tool input captured from the assistant message (via
          // toolUseContexts) over the deferred_tool_use.input field, since
          // both should be identical but the captured copy is always a plain
          // object (already normalized by rememberToolUse). Fall back to
          // deferred.input if the context entry is absent, and omit the field
          // entirely if neither source is available (fail-soft).
          const capturedContext = this.toolUseContexts.get(deferred.id);
          const resolvedToolInput: Record<string, unknown> | undefined =
            capturedContext?.input ?? (deferred.input ? deferred.input : undefined);

          // Build a human-readable prompt with the actual command
          const toolSummary = deferred.name === 'Bash' && resolvedToolInput?.['command']
            ? `Bash: \`${String(resolvedToolInput['command'])}\``
            : deferred.name;

          this.emit('status', 'waiting_for_permission' as InstanceStatus);
          this.emit('input_required', {
            id: generateId(),
            prompt: `Permission required: Claude wants to run ${toolSummary}`,
            timestamp: Date.now(),
            metadata: {
              type: 'deferred_permission',
              tool_name: deferred.name,
              ...(resolvedToolInput !== undefined ? { tool_input: resolvedToolInput } : {}),
              tool_use_id: deferred.id,
              session_id: resultMsg.session_id,
            },
          });

          // Don't process further — the instance is paused, awaiting user decision
          break;
        }

        // Update context window size from modelUsage (the contextWindow field
        // is per-model, not cumulative — safe to use).
        // IMPORTANT: modelUsage.inputTokens / .outputTokens are SESSION-LEVEL
        // CUMULATIVE totals, NOT current context occupancy. Using them for
        // context % would massively overcount after multi-call agentic turns.
        if (resultMsg.modelUsage) {
          const modelKeys = Object.keys(resultMsg.modelUsage);
          if (modelKeys.length > 0) {
            const modelData = resultMsg.modelUsage[modelKeys[0]];
            // Use CLI-reported context window but never go below our known floor.
            const cliReported = modelData.contextWindow || this.lastKnownContextWindow;
            const contextWindow = Math.max(cliReported, this.contextWindowFloor);
            this.lastKnownContextWindow = contextWindow;
          }
        }

        // Emit context usage only if we didn't already get accurate per-call
        // usage from assistant or system messages this turn.
        if (!this.hasPerCallUsageThisTurn) {
          const contextWindow = this.lastKnownContextWindow;
          let totalUsedTokens = 0;

          if (resultMsg.modelUsage) {
            // Fallback: use cumulative modelUsage when no per-call data available.
            // This overcounts but is better than showing 0%.
            const modelKeys = Object.keys(resultMsg.modelUsage);
            if (modelKeys.length > 0) {
              const modelData = resultMsg.modelUsage[modelKeys[0]];
              totalUsedTokens =
                (modelData.inputTokens || 0) +
                (modelData.outputTokens || 0);
            }
          } else if (resultMsg.usage) {
            totalUsedTokens =
              (resultMsg.usage.input_tokens || 0) +
              (resultMsg.usage.cache_creation_input_tokens || 0) +
              (resultMsg.usage.cache_read_input_tokens || 0) +
              (resultMsg.usage.output_tokens || 0);
          }

          if (totalUsedTokens > 0) {
            const percentage = (totalUsedTokens / contextWindow) * 100;
            const costEstimate = resultMsg.total_cost_usd || 0;

            this.emit('context', {
              used: totalUsedTokens,
              total: contextWindow,
              percentage: Math.min(percentage, 100),
              costEstimate
            });
          }
        } else if (resultMsg.total_cost_usd !== undefined) {
          // We have accurate per-call usage but result has the session cost.
          // Emit a cost-only event using the 'cost' channel so downstream
          // can merge it without overwriting accurate token values.
          this.emit('cost', { costEstimate: resultMsg.total_cost_usd });
        }

        // Reset for next turn
        this.hasPerCallUsageThisTurn = false;
        this.emit('status', 'idle' as InstanceStatus);
        break;
      }

      case 'error':
        this.emit('output', {
          id: generateId(),
          timestamp: message.timestamp || Date.now(),
          type: 'error',
          content: message.error.message,
          metadata: { code: message.error.code }
        });
        this.emit('status', 'error' as InstanceStatus);
        break;

      case 'input_required': {
        const inputRequiredMetadataKeys = 'metadata' in message
          && message.metadata
          && typeof message.metadata === 'object'
          ? Object.keys(message.metadata)
          : [];
        logger.debug('Input_required message received', {
          promptLength: typeof message.prompt === 'string' ? message.prompt.length : 0,
          metadataKeys: inputRequiredMetadataKeys
        });

        this.emit('status', 'waiting_for_input' as InstanceStatus);
        const inputRequestId = generateId();
        const approvalTraceId = this.createApprovalTraceId('input_required');
        const prompt = message.prompt || 'Input required';
        const timestamp = message.timestamp || Date.now();

        logger.debug('Processing input_required', {
          inputRequestId,
          promptLength: prompt.length,
          promptPreview: this.summarizeLogText(prompt)
        });
        logger.info('[APPROVAL_TRACE] adapter_emit_input_required', {
          approvalTraceId,
          instanceSessionId: this.sessionId,
          requestId: inputRequestId,
          promptLength: prompt.length
        });

        // Emit the input_required event for UI to handle
        this.emit('input_required', {
          id: inputRequestId,
          prompt,
          timestamp,
          metadata: {
            approvalTraceId,
            traceStage: 'adapter:input_required_emit'
          }
        });

        // Also emit as system output for visibility in chat
        this.emit('output', {
          id: inputRequestId,
          timestamp,
          type: 'system',
          content: prompt,
          metadata: {
            requiresInput: true,
            approvalTraceId,
            traceStage: 'adapter:input_required_output'
          }
        });
        logger.debug('Input_required handling complete');
        break;
      }

      case 'elicitation': {
        // MCP elicitation — an MCP server is requesting structured input
        // (e.g. OAuth consent, configuration form, credential entry).
        // Surface this as an input_required event so the UI can present a form.
        const elicitationRaw = raw as {
          server_name?: string;
          message?: string;
          schema?: Record<string, unknown>;
          request_id?: string;
        };
        const serverName = elicitationRaw.server_name || 'MCP server';
        const elicitationMsg = elicitationRaw.message || 'An MCP server requires input';
        const elicitationTimestamp = message.timestamp || Date.now();
        const elicitationId = generateId();

        logger.info('MCP elicitation received', {
          serverName,
          messagePreview: this.summarizeLogText(elicitationMsg),
          hasSchema: Boolean(elicitationRaw.schema),
          requestId: elicitationRaw.request_id
        });

        this.emit('status', 'waiting_for_input' as InstanceStatus);

        this.emit('input_required', {
          id: elicitationId,
          prompt: `[${serverName}] ${elicitationMsg}`,
          timestamp: elicitationTimestamp,
          metadata: {
            type: 'mcp_elicitation',
            serverName,
            schema: elicitationRaw.schema,
            requestId: elicitationRaw.request_id
          }
        });

        this.emit('output', {
          id: elicitationId,
          timestamp: elicitationTimestamp,
          type: 'system',
          content: `MCP server "${serverName}" requests input: ${elicitationMsg}`,
          metadata: {
            requiresInput: true,
            mcpElicitation: true,
            serverName,
            schema: elicitationRaw.schema
          }
        });
        break;
      }

      default: {
        const unhandled = message as { type: string };
        logger.warn('Unrecognized CLI message type', {
          type: unhandled.type,
          keys: Object.keys(message),
          preview: this.summarizeLogText(JSON.stringify(message), 300)
        });
        break;
      }
    }
  }

  private emitAskUserQuestionInputRequired(
    toolUseId: string | undefined,
    input: unknown,
    timestamp: number,
    fallbackText?: string
  ): void {
    const prompt = buildAskUserQuestionPrompt(input, fallbackText);
    if (!prompt) {
      return;
    }
    const questions = parseAskUserQuestions(input);

    const dedupeKey = toolUseId || `prompt:${prompt}`;
    if (this.emittedAskUserQuestionKeys.has(dedupeKey)) {
      return;
    }
    this.emittedAskUserQuestionKeys.add(dedupeKey);

    const inputRequestId = generateId();
    const approvalTraceId = this.createApprovalTraceId('ask_user_question');
    this.emit('status', 'waiting_for_input' as InstanceStatus);
    logger.info('[APPROVAL_TRACE] adapter_emit_ask_user_question', {
      approvalTraceId,
      instanceSessionId: this.sessionId,
      requestId: inputRequestId,
      toolUseId: toolUseId || null
    });

    this.emit('input_required', {
      id: inputRequestId,
      prompt,
      timestamp,
      metadata: {
        type: 'ask_user_question',
        tool_use_id: toolUseId,
        input,
        questions,
        approvalTraceId,
        traceStage: 'adapter:ask_user_question_emit'
      }
    });

    // Also mirror into system output so the user can always see what was asked.
    this.emit('output', {
      id: inputRequestId,
      timestamp,
      type: 'system',
      content: prompt,
      metadata: {
        requiresInput: true,
        askUserQuestion: true,
        approvalTraceId,
        traceStage: 'adapter:ask_user_question_output'
      }
    });
  }

  private summarizeLogText(value: string, maxLength = 160): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }

    return `${normalized.slice(0, maxLength)}... (${normalized.length} chars)`;
  }

  private rememberToolUse(
    toolUseId: string | undefined,
    toolName: string | undefined,
    input: unknown
  ): void {
    if (!toolUseId || !toolName) {
      return;
    }
    const normalizedInput =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>)
        : {};
    this.toolUseContexts.set(toolUseId, {
      name: toolName,
      input: normalizedInput
    });
  }

  private forgetToolUse(toolUseId: string | undefined): void {
    if (!toolUseId) {
      return;
    }
    this.toolUseContexts.delete(toolUseId);
  }

  private async primeCliVersion(): Promise<void> {
    // Detect only when the optional optimization is enabled. The default send
    // path never uses the flag, so an unconditional help probe would add a
    // blocking child process before every first message.
    if (this.spawnOptions.excludeDynamicSystemPromptSections) {
      await this.detectExcludeDynamicSupport();
    }
    if (this.spawnOptions.yoloMode || !this.spawnOptions.permissionHookPath) {
      return;
    }

    const status = await this.checkStatus();
    if (!status.available) {
      logger.warn('Unable to verify Claude CLI version before enabling defer permissions', {
        error: status.error,
        sessionId: this.sessionId,
      });
    }
  }

  private shouldUsePermissionHook(): boolean {
    if (this.spawnOptions.yoloMode || !this.spawnOptions.permissionHookPath) {
      return false;
    }
    return isVersionAtLeast(this.cachedCliStatus?.version, DEFER_MIN_VERSION);
  }

  /**
   * Detect whether a tool_result error content indicates a permission denial.
   * Claude CLI has changed its denial wording across versions, so we match
   * several known patterns rather than a single literal string.
   */
  private isPermissionDenialContent(content: string): boolean {
    const lower = content.toLowerCase();
    const patterns = [
      "haven't granted it yet",          // Original Claude CLI wording
      "hasn't been granted",             // Alternate phrasing
      "permission denied",               // Generic denial
      "not allowed to",                  // "You are not allowed to..."
      "not permitted",                   // "This tool is not permitted"
      "requires permission",             // "This action requires permission"
      "does not have permission",        // "Claude does not have permission"
      "need permission",                 // "You need permission to..."
      "must grant permission",           // "You must grant permission"
      "allow this tool",                 // "Please allow this tool"
      "tool is not approved",            // Approval-gated tools
      "denied by permission",            // "Action denied by permission policy"
      "permission to use this tool",     // "You haven't given permission to use this tool"
      "tool use is not allowed",         // Direct denial
      "is not allowed in",               // "Bash is not allowed in acceptEdits mode"
      "isn't allowed",                   // Contraction variant
      "not authorized",                  // Authorization-style denial
    ];
    const claudeRequestedPermissionPattern =
      /\bclaude requested permissions? to (?:access|add|change|create|delete|edit|execute|modify|move|open|read|remove|rename|run|update|use|view|write)\b/i;

    return patterns.some(p => lower.includes(p))
      || claudeRequestedPermissionPattern.test(content);
  }

  private extractPermissionDetails(
    content: string,
    toolUseId: string | undefined
  ): { action: string; path: string; displayPath: string } {
    const normalizedContent = content.replace(/\s+/g, ' ').trim();

    let action: string | undefined;
    let path: string | undefined;
    let displayPath: string | undefined;

    const patterns: RegExp[] = [
      /permissions? to (\w+) to (.+?)(?:,| but\b| because\b| which\b|\.(?:\s|$)|$)/i,
      /permissions? to (\w+) on (.+?)(?:,| but\b| because\b| which\b|\.(?:\s|$)|$)/i,
      /permissions? to (\w+) for (.+?)(?:,| but\b| because\b| which\b|\.(?:\s|$)|$)/i,
      /permissions? to (access|add|change|create|delete|edit|modify|move|open|read|remove|rename|update|view|write) (.+?)(?:,| but\b| because\b| which\b|\.(?:\s|$)|$)/i
    ];

    for (const pattern of patterns) {
      const match = normalizedContent.match(pattern);
      if (match) {
        action = match[1]?.trim().toLowerCase();
        path = match[2]?.trim();
        if (action && path) {
          break;
        }
      }
    }

    const toolContext = toolUseId ? this.toolUseContexts.get(toolUseId) : undefined;
    if (toolContext) {
      if (!action) {
        action = toolContext.name.toLowerCase();
      }
      if (!path) {
        const extractedTarget = this.extractPermissionTargetFromToolInput(toolContext.input);
        path = extractedTarget?.rawValue;
        displayPath = extractedTarget?.displayValue;
      }
    }

    if (!action) {
      action = 'access';
    }
    if (!path) {
      path = 'a file';
    }
    if (!displayPath) {
      displayPath = this.summarizeLogText(path);
    }

    return {
      action,
      path,
      displayPath
    };
  }

  private extractPermissionTargetFromToolInput(
    input: Record<string, unknown>
  ): { rawValue: string; displayValue: string } | undefined {
    const preferredKeys = [
      'file_path',
      'path',
      'filepath',
      'target_file',
      'target',
      'destination',
      'url',
      'uri'
    ];

    for (const key of preferredKeys) {
      const described = this.describePermissionTarget(key, input[key]);
      if (described) {
        return described;
      }
    }

    for (const [key, value] of Object.entries(input)) {
      const described = this.describePermissionTarget(key, value);
      if (described) {
        return described;
      }
    }

    return undefined;
  }

  private describePermissionTarget(
    key: string,
    value: unknown
  ): { rawValue: string; displayValue: string } | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    const normalizedKey = key.toLowerCase();
    const isPathLikeKey = normalizedKey === 'file_path'
      || normalizedKey === 'path'
      || normalizedKey === 'filepath'
      || normalizedKey === 'target_file'
      || normalizedKey === 'target'
      || normalizedKey === 'destination'
      || normalizedKey === 'url'
      || normalizedKey === 'uri';
    const looksLikePath = trimmed.startsWith('/')
      || trimmed.startsWith('./')
      || trimmed.startsWith('../')
      || /^[A-Za-z]:[\\/]/.test(trimmed)
      || trimmed.includes('/')
      || trimmed.includes('\\');
    const looksLikeUrl = /^https?:\/\//i.test(trimmed);

    if (isPathLikeKey || looksLikePath || looksLikeUrl) {
      return {
        rawValue: trimmed,
        displayValue: this.summarizeLogText(trimmed)
      };
    }

    return {
      rawValue: trimmed,
      displayValue: `${normalizedKey} (${trimmed.length} chars)`
    };
  }

  private createPermissionKey(action: string, path: string): string {
    const digest = createHash('sha256')
      .update(`${action}\u0000${path}`)
      .digest('hex')
      .slice(0, 16);
    return `${action}:${digest}`;
  }

  private createApprovalTraceId(kind: string): string {
    return `approval-${kind}-${generateId()}`;
  }
}
