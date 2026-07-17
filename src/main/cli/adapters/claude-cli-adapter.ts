/**
 * Claude CLI Adapter - Spawns and manages Claude Code CLI processes
 * Extends BaseCliAdapter for multi-CLI support
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  BaseCliAdapter,
  type AdapterCapabilities,
  AdapterRuntimeCapabilities,
  CliAdapterConfig,
  CliCapabilities,
  CliStatus,
  CliMessage,
  CliResponse,
  CliToolCall,
  CliUsage,
  ndjsonSafeStringify,
  type ContextUsageObservation,
  type InterruptResult,
  type ResumeAttemptResult,
  type TurnInterruptCompletion,
} from './base-cli-adapter';
import { NdjsonParser } from '../ndjson-parser';
import { applyClaudeHygieneEnv, resolveClaudeFallbackModel } from './claude-env-pack';
import { parseNdjsonLine } from '../json-parse';
import { InputFormatter } from '../input-formatter';
import { processAttachments, buildMessageWithFiles } from '../file-handler';
import { getLogger } from '../../logging/logger';
import { buildDeferPermissionHookCommand } from '../hooks/hook-path-resolver';
import { HOST_CLI_CLOUD_SCHEDULER_TOOLS } from './host-cli-tool-policy';
import { buildAskUserQuestionPrompt, parseAskUserQuestions } from './ask-user-question-prompt';
import type { CliStreamMessage, CliRateLimitInfo } from '../../../shared/types/cli.types';
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
import {
  createApprovalTraceId,
  createPermissionKey,
  extractPermissionDetails,
  isPermissionDenialContent,
  summarizeClaudeLogText,
  type ClaudeToolUseContext,
} from './claude-cli-permission-details';
import { probeVersionStatus } from './cli-status-probe';
import type { ProviderContextCapabilities } from '@contracts/types/context-evidence';

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
  private toolUseContexts = new Map<string, ClaudeToolUseContext>();
  /** Cached context window from last result message for accurate streaming percentage */
  private lastKnownContextWindow: number;
  /** Last accurate per-API-call context occupancy (input + cache + output of
   *  the most recent call). Only set from per-call usage — never from the
   *  cumulative result fallback, which overcounts across agentic turns. */
  private lastObservedContextUsage: { used: number; total: number } | null = null;
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
  private lastResumeAttemptResult: ResumeAttemptResult | null = null;
  private lastRateLimitInfo: CliRateLimitInfo | null = null;
  /**
   * State of the most recently *emitted* rate-limit notice, used to suppress
   * duplicates. Tracked against the last emitted notice (not the previous
   * event's status) because the CLI interleaves `allowed` heartbeats between
   * throttled events — a prevStatus compare re-fired on every flip and stacked
   * copies. A new window (different, defined `resetsAt`) re-notifies.
   */
  private lastEmittedRateLimitStatus: string | null = null;
  private lastEmittedRateLimitResetsAt: number | undefined = undefined;
  /**
   * Resolver for the resident-interrupt completion promise.
   * Set when `interrupt()` sends a `control_request{request:{subtype:'interrupt'}}`
   * to stdin; resolved when the matching `control_response{response:{subtype:'success'}}`
   * arrives on stdout or on error/timeout. Non-null only during an active resident interrupt.
   */
  private pendingInterruptResolve: ((result: TurnInterruptCompletion) => void) | null = null;
  /**
   * `request_id` of the in-flight resident interrupt, echoed back by the CLI in
   * the `control_response`. Used to correlate the ack to this interrupt and
   * cleared alongside {@link pendingInterruptResolve}.
   */
  private pendingInterruptRequestId: string | null = null;

  constructor(options: ClaudeCliSpawnOptions = {}) {
    // Build env passthrough for the spawned CLI process. The PreToolUse hook
    // script reads ORCHESTRATOR_RTK_ENABLED and ORCHESTRATOR_RTK_PATH from env,
    // so they need to be present in the CLI's environment, not the orchestrator's.
    const env: Record<string, string> = { ...(options.env ?? {}) };
    applyClaudeHygieneEnv(env, options.sessionId);
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

    // WS14: settings-backed fallback model unless the caller pinned one.
    const fallbackModel = resolveClaudeFallbackModel(options.fallbackModel);
    this.spawnOptions = fallbackModel ? { ...options, fallbackModel } : options;
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

  /**
   * Last accurate per-API-call context occupancy. Unlike the cumulative
   * result-line usage (which sums input across every agentic turn), this
   * reflects what actually sits in the context window right now — callers
   * like Loop Mode's context discipline use it to decide when to recycle a
   * persistent session. WS4: returns the discriminated observation —
   * `unknown: not-reported` before the first per-call sample, and
   * `unknown: invalid-sample` for a sample with unusable values.
   */
  override getLastContextUsage(): ContextUsageObservation {
    const sample = this.lastObservedContextUsage;
    if (!sample) return { status: 'unknown', reason: 'not-reported' };
    if (!Number.isFinite(sample.used) || !Number.isFinite(sample.total)
      || sample.used <= 0 || sample.total <= 0) {
      return { status: 'unknown', reason: 'invalid-sample' };
    }
    return { status: 'known', used: sample.used, total: sample.total, source: 'provider-turn' };
  }

  getResumeAttemptResult(): ResumeAttemptResult | null {
    return this.lastResumeAttemptResult;
  }

  /** Latest rate-limit telemetry reported by the CLI, or null if none seen. */
  getLastRateLimitInfo(): CliRateLimitInfo | null {
    return this.lastRateLimitInfo;
  }

  /**
   * B7: Claude's `--resume <id>` scans the transcript under the *current cwd's*
   * lossily-encoded project dir (`~/.claude/projects/<encoded-cwd>/<id>.jsonl`,
   * every non-alphanumeric char → `-`). Resuming from a different cwd — or for an
   * id never flushed — fails "No conversation found". Verify up-front so we fall
   * back to fresh+replay before a doomed spawn. Permissive on uncertainty (no
   * cwd / FS error) so we never block a legitimate resume.
   */
  private nativeTranscriptExists(sessionId: string): boolean {
    const cwd = this.spawnOptions.workingDirectory;
    if (!cwd) return true;
    try {
      const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
      return existsSync(join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`));
    } catch {
      return true;
    }
  }

  /** Whether the next spawn should use native `--resume` (B7-guarded). */
  private shouldUseNativeResume(): boolean {
    return Boolean(
      this.spawnOptions.resume
      && this.sessionId
      && this.nativeTranscriptExists(this.sessionId),
    );
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
   * Resident-session capability descriptor.
   *
   * Claude CLI in `--print --input-format stream-json` mode keeps stdin open,
   * accepts `control_request{interrupt}` to abort a turn without exiting, and
   * then awaits the next `user` message on stdin for the next turn. That makes
   * it a fully resident, steerable server.
   *
   * The adapter sets capabilities to `{true,true,true}` when the process is
   * alive and the formatter is open. The orchestrator uses this to skip the
   * SIGINT + respawn cycle and instead steer via stdin messages.
   */
  override getAdapterCapabilities(): AdapterCapabilities {
    // Only advertise resident capabilities when the process is actually running
    // with an open stdin — not before spawn or after exit — AND the
    // residentClaude is enabled for normal instance spawns; direct adapter
    // callers/tests can still disable it explicitly.
    const residentEnabled = this.spawnOptions.residentClaude === true;
    const isResident = residentEnabled && this.isRealPipe();
    return {
      residentSession: isResident,
      liveInterrupt: isResident,
      liveSteer: isResident,
    };
  }

  override getContextCapabilities(): ProviderContextCapabilities {
    const resident = this.getAdapterCapabilities().residentSession;
    return {
      toolResultControl: 'post-retention',
      toolResultVisibility: 'full',
      transcriptControl: 'none',
      occupancyReporting: resident ? 'current' : 'aggregate-only',
      cumulativeReporting: 'available',
      interruptProof: resident ? 'acknowledged-only' : 'none',
      compactionProof: 'none',
      sameThreadContinuation: resident,
    };
  }

  /**
   * Resident interrupt: sends `control_request{request:{subtype:'interrupt'}}`
   * (with a correlation `request_id`) to stdin instead of SIGINT. The CLI aborts
   * the in-flight turn, stays alive, and replies with the matching
   * `control_response{response:{subtype:'success'}}`. Returns a completion promise
   * that resolves when the response arrives.
   *
   * If the stdin write fails (EPIPE) or the process exits before `control_response`,
   * the completion promise is left pending — the 15s deadline in handleInterruptCompletion
   * causes it to return early, and onInterruptedExit() → respawnAfterInterrupt() owns
   * recovery (resolving respawnPromise only after the new process is ready).
   *
   * Falls back to the base-class SIGINT path when:
   *  - `residentClaude` is not set to true in spawn options, or
   *  - the process or formatter is not currently live (pre-spawn, post-exit).
   */
  override interrupt(): InterruptResult {
    if (this.spawnOptions.residentClaude === true && this.isRealPipe() && this.formatter) {
      // Resident path: protocol-level interrupt, no SIGINT, process stays alive.
      let resolve!: (result: TurnInterruptCompletion) => void;
      const completion = new Promise<TurnInterruptCompletion>((res) => {
        resolve = res;
      });
      this.pendingInterruptResolve = resolve;
      const requestId = `interrupt_${generateId()}`;
      this.pendingInterruptRequestId = requestId;

      this.formatter.sendControlRequest('interrupt', requestId).catch((err: unknown) => {
        // stdin write failed (EPIPE / process already exiting).
        // Clear the resolver WITHOUT resolving it — do NOT settle to 'rejected' here.
        // The process is dying, so handleExit() will fire → exit event →
        // onInterruptedExit() → respawnAfterInterrupt() owns the recovery.
        // Resolving with 'rejected' would cause handleInterruptCompletion() to
        // prematurely settle to idle (before the new process is ready), unblocking
        // sendInput() against a null formatter and losing the queued steer message.
        // The 15s interrupt-completion deadline + force-abort net handle stuck processes.
        logger.warn('Failed to send control_request interrupt; deferring recovery to exit handler', {
          sessionId: this.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        if (this.pendingInterruptResolve === resolve) {
          this.pendingInterruptResolve = null;
          this.pendingInterruptRequestId = null;
        }
      });

      logger.info('Sent control_request interrupt (resident path)', {
        sessionId: this.sessionId,
        pid: this.getPid(),
      });
      return { status: 'accepted', completion };
    }

    // Fallback: process is not resident (already dead or pre-spawn) — use SIGINT.
    logger.info('Falling back to SIGINT interrupt (process not resident)', {
      sessionId: this.sessionId,
      pid: this.getPid(),
    });
    return super.interrupt();
  }

  /**
   * Send `end_session` to gracefully tear down the resident CLI process.
   * Called during instance termination to let the CLI flush its transcript.
   */
  async sendEndSession(): Promise<void> {
    if (!this.isRealPipe() || !this.formatter) return;
    try {
      const endSessionMsg = ndjsonSafeStringify({ type: 'end_session' });
      await this.formatter.sendRaw(endSessionMsg);
      logger.info('Sent end_session to Claude CLI', { sessionId: this.sessionId });
    } catch (err) {
      logger.debug('sendEndSession failed (process already closed)', {
        sessionId: this.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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

  /** D2 (#6): per-send tools-disable override; merged into --disallowedTools by buildArgs. */
  private disallowedToolsOverride: readonly string[] | null = null;

  /**
   * D2 (#6) loop cap wrap-up: temporarily deny extra tools on the NEXT spawn
   * (each sendMessage rebuilds argv from spawnOptions, so this takes effect
   * per send). Pass `null` to clear. Purely additive — merged on top of the
   * host denylist and any caller-supplied `disallowedTools`; never removes
   * an existing restriction.
   */
  setDisallowedToolsOverride(tools: readonly string[] | null): void {
    this.disallowedToolsOverride = tools && tools.length > 0 ? [...tools] : null;
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
      fastMode?: true;
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

    // Fast mode (Opus-only, paid-tier): the CLI reads the `fastMode` settings
    // key. Slash-command toggling (`/fast`) is unavailable in print mode (it
    // would reach the model as plain text), so the settings overlay is the only
    // programmatic surface. If the account can't honor it the CLI emits a "fast
    // mode unavailable" notice on the output stream (auto-reverted by lifecycle).
    if (this.spawnOptions.fastMode) {
      settings.fastMode = true;
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

    this.cliStatusPromise = probeVersionStatus({
      spawn: () => this.spawnProcess(['--version']),
      path: 'claude',
      timeoutError: 'Timeout checking Claude CLI',
      spawnError: (err) => `Failed to spawn claude: ${err.message}`,
      unavailableError: ({ output }) => `Claude CLI not found or not configured: ${output}`,
      isAvailable: ({ code, output }) => code === 0 || output.includes('claude'),
      includeVersionOnUnavailable: true,
    }).then((status) => {
      this.cachedCliStatus = status;
      this.cliStatusPromise = null;
      return status;
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
      const parsedLine = parseNdjsonLine<RawCliPayload>(line);
      if (parsedLine.ok) {
        const msg = parsedLine.value;

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
      } else {
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

    if (this.shouldUseNativeResume()) {
      args.push('--resume', this.sessionId!);
      // Fork session creates a new session ID while preserving conversation history
      if (this.spawnOptions.forkSession) {
        args.push('--fork-session');
      }
    } else if (this.sessionId) {
      // B7: resume was requested but the transcript is missing for this cwd/id —
      // start a fresh session under the same id rather than failing on --resume.
      // Upstream replay re-seeds conversation context.
      if (this.spawnOptions.resume) {
        logger.info('Skipping --resume: no transcript for session under current cwd', {
          sessionId: this.sessionId,
          cwd: this.spawnOptions.workingDirectory,
        });
      }
      args.push('--session-id', this.sessionId);
    }

    if (this.spawnOptions.model) {
      args.push('--model', this.spawnOptions.model);
    }

    // WS14: automatic overload fallback. Never pass a fallback equal to the
    // primary — the CLI rejects that pairing.
    if (this.spawnOptions.fallbackModel && this.spawnOptions.fallbackModel !== this.spawnOptions.model) {
      args.push('--fallback-model', this.spawnOptions.fallbackModel);
    }

    // WS14: structured output for one-shot utility calls (review verdicts).
    if (this.spawnOptions.jsonSchema) {
      args.push('--json-schema', this.materializeInlineJsonArg(this.spawnOptions.jsonSchema));
    }

    const mappedReasoningEffort = this.mapReasoningEffort(this.spawnOptions.reasoningEffort);
    if (mappedReasoningEffort) {
      args.push('--effort', mappedReasoningEffort);
    }

    if (this.spawnOptions.maxTokens) {
      args.push('--max-tokens', this.spawnOptions.maxTokens.toString());
    }

    // Agentic-turn backstop. Bounds runaway sessions (outer caps bound
    // iterations/wall-clock, not turns within a single print-mode run).
    if (this.spawnOptions.maxTurns && this.spawnOptions.maxTurns > 0) {
      args.push('--max-turns', this.spawnOptions.maxTurns.toString());
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
        // D2 (#6): transient per-send override (loop cap wrap-up tools-disable).
        ...(this.disallowedToolsOverride ?? []),
      ]),
    );
    if (disallowedTools.length > 0) {
      args.push('--disallowedTools', disallowedTools.join(','));
    }

    // Don't pass system prompt when resuming - the session already has one
    // and Claude CLI doesn't support changing it mid-session.
    // Default is APPEND: `--system-prompt` REPLACES Claude Code's entire default
    // system prompt (tool guidance, safety, todo machinery) and also disables
    // --exclude-dynamic-system-prompt-sections. Our orchestration prompt and
    // agent profiles are written as overlays (agent.types.ts documents
    // systemPrompt as "to prepend"), so they must ride on top of the default,
    // not supplant it. Only explicit systemPromptMode: 'replace' (minimal
    // one-shot spawns like title generation) uses the replacing flag.
    if (this.spawnOptions.systemPrompt && !this.spawnOptions.resume) {
      const flag = this.spawnOptions.systemPromptMode === 'replace'
        ? '--system-prompt'
        : '--append-system-prompt';
      args.push(flag, this.spawnOptions.systemPrompt);
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
    this.lastResumeAttemptResult = this.shouldUseNativeResume()
      ? { source: 'native', confirmed: false, requestedSessionId: this.sessionId ?? undefined }
      : { source: 'fresh-fallback', confirmed: false };
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
      contentPreview: summarizeClaudeLogText(text),
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
        preview: summarizeClaudeLogText(raw, 400),
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
          preview: summarizeClaudeLogText(errorText, 220),
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

    // Clear any in-flight resident interrupt WITHOUT resolving it.
    // Do NOT resolve with 'rejected' here: the 'exit' event (emitted below) triggers
    // onInterruptedExit() → respawnAfterInterrupt(), which resolves respawnPromise only
    // after the new process is ready. Resolving the completion promise here with 'rejected'
    // would cause handleInterruptCompletion() to prematurely settle the instance to idle,
    // unblocking sendInput() against a null formatter and losing the queued steer message.
    // handleInterruptCompletion() will time out via its 15s deadline and return early;
    // the force-abort net (30s) is cancelled by resolveRespawnPromise() in respawnAfterInterrupt().
    if (this.pendingInterruptResolve) {
      this.pendingInterruptResolve = null;
      this.pendingInterruptRequestId = null;
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
        const assistantTimestamp = message.timestamp || Date.now();

        // Emit each text block as its OWN assistant output in document order,
        // interleaved with tool_use — never concatenated into one buffer flushed
        // after the loop (which merged a [text, tool_use, text] message into a
        // single string emitted after the tool, losing ordering and boundaries).
        // Per-block commit makes assistant text impossible to drop or reorder
        // across interleaved tool_use or non-content events. `precedingText` is
        // the response so far in this message, fed to AskUserQuestion as its
        // preamble; `pendingThinking` carries thinking to the next text block.
        let precedingText = '';
        let pendingThinking: ThinkingContent[] = [];

        const emitAssistantTextBlock = (rawText: string): void => {
          // headerStyle off: Claude emits reasoning as structured `thinking`
          // blocks, so re-parsing text mis-classifies real answers as thinking.
          const extracted = extractThinkingContent(rawText, { headerStyle: false });
          const response = extracted.response;
          const blockThinking = [
            ...pendingThinking,
            ...extracted.thinking.map(t => ({ ...t, timestamp: assistantTimestamp })),
          ];
          pendingThinking = [];
          if (response.trim() || blockThinking.length > 0) {
            this.emit('output', {
              id: generateId(),
              timestamp: assistantTimestamp,
              type: 'assistant',
              content: response,
              thinking: blockThinking.length > 0 ? blockThinking : undefined,
              thinkingExtracted: true,
            });
          }
          if (response.trim()) {
            precedingText = precedingText ? `${precedingText}\n${response}` : response;
          }
        };

        if (assistantMsg.message?.content) {
          for (const block of assistantMsg.message.content) {
            // Handle structured thinking blocks from Claude API (extended thinking)
            if (block.type === 'thinking' && block.thinking) {
              pendingThinking.push({
                id: generateId(),
                content: block.thinking,
                format: 'structured',
                timestamp: assistantTimestamp
              });
            } else if (block.type === 'text' && block.text) {
              emitAssistantTextBlock(block.text);
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
                  precedingText
                );
              }
            }
          }
        } else if (typeof assistantMsg.content === 'string') {
          emitAssistantTextBlock(assistantMsg.content);
        }

        // Flush thinking that never found a following text block (thinking-only
        // message), matching the prior behaviour of still surfacing an output.
        if (pendingThinking.length > 0) {
          this.emit('output', {
            id: generateId(),
            timestamp: assistantTimestamp,
            type: 'assistant',
            content: '',
            thinking: pendingThinking,
            thinkingExtracted: true,
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
          this.lastObservedContextUsage = { used: totalUsedTokens, total: contextWindow };
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
                contentPreview: summarizeClaudeLogText(block.content, 300),
                isPermissionDenial: isPermissionDenialContent(block.content)
              });
            }

            // YOLO runs with --dangerously-skip-permissions: the CLI cannot ask
            // for a permission grant, so denial-looking text here is either the
            // command's own output or an explicit settings deny rule — and the
            // "add allow rule + restart" recovery can fix neither. Restarting a
            // healthy YOLO session over it destroys context for nothing.
            if (
              !this.spawnOptions.yoloMode &&
              block.type === 'tool_result' &&
              block.is_error === true &&
              typeof block.content === 'string' &&
              isPermissionDenialContent(block.content)
            ) {
              logger.debug('Permission denial detected in tool_result', {
                toolUseId: block.tool_use_id,
                contentLength: block.content.length,
                contentPreview: summarizeClaudeLogText(block.content, 220)
              });

              const { action, path, displayPath } = extractPermissionDetails(
                block.content,
                block.tool_use_id,
                this.toolUseContexts
              );

              // Capture the authoritative tool name (e.g. 'Edit', 'Write') from the
              // original tool_use, so the renderer can request a precise settings.json
              // allow-rule on user approval.
              const denialToolContext = block.tool_use_id
                ? this.toolUseContexts.get(block.tool_use_id)
                : undefined;
              const denialToolName = denialToolContext?.name;

              // Create a unique key for this permission request to avoid duplicate prompts
              const permissionKey = createPermissionKey(action, path);

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
              const approvalTraceId = createApprovalTraceId('permission');
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
          this.lastObservedContextUsage = { used: totalUsedTokens, total: contextWindow };
          this.emit('context', {
            used: totalUsedTokens,
            total: contextWindow,
            percentage: Math.min(percentage, 100),
            costEstimate
          });
        }
        if (message.session_id) {
          this.sessionId = message.session_id;
          // Confirm or annotate the resume proof with the authoritative session_id
          if (this.lastResumeAttemptResult?.source === 'native') {
            this.lastResumeAttemptResult = {
              ...this.lastResumeAttemptResult,
              confirmed: message.session_id === this.lastResumeAttemptResult.requestedSessionId,
              actualSessionId: message.session_id,
            };
          } else if (this.lastResumeAttemptResult) {
            this.lastResumeAttemptResult = {
              ...this.lastResumeAttemptResult,
              actualSessionId: message.session_id,
            };
          }
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
        const approvalTraceId = createApprovalTraceId('input_required');
        const prompt = message.prompt || 'Input required';
        const timestamp = message.timestamp || Date.now();

        logger.debug('Processing input_required', {
          inputRequestId,
          promptLength: prompt.length,
          promptPreview: summarizeClaudeLogText(prompt)
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
          messagePreview: summarizeClaudeLogText(elicitationMsg),
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

      case 'rate_limit_event': {
        // Anthropic usage telemetry. `status: 'allowed'` is the steady state and
        // arrives every turn — keep it at debug so it doesn't spam as an
        // "unrecognized message". Only surface a user-visible notice the first
        // time the status flips into an actually-throttled state, so a stalled
        // session shows *why* instead of going silent.
        const info = (raw as { rate_limit_info?: CliRateLimitInfo }).rate_limit_info ?? null;
        this.lastRateLimitInfo = info;
        const status = info?.status;
        const throttled = Boolean(status && status !== 'allowed');
        const resetsAtMs = typeof info?.resetsAt === 'number' ? info.resetsAt * 1000 : undefined;
        // Dedupe against the last *emitted* notice: an unchanged throttle status
        // emits once even across interleaved `allowed` heartbeats or bare
        // repeats that omit window fields. Only a new window (explicitly
        // different, defined `resetsAt`) re-notifies. We deliberately do NOT
        // reset on `allowed` — that reset is what let duplicates stack.
        const isNewWindow =
          resetsAtMs !== undefined &&
          this.lastEmittedRateLimitResetsAt !== undefined &&
          resetsAtMs !== this.lastEmittedRateLimitResetsAt;
        const alreadyNotified =
          this.lastEmittedRateLimitStatus === status && !isNewWindow;
        if (throttled && !alreadyNotified) {
          this.lastEmittedRateLimitStatus = status ?? null;
          this.lastEmittedRateLimitResetsAt = resetsAtMs;
          const resetText = resetsAtMs ? new Date(resetsAtMs).toLocaleTimeString() : 'unknown';
          logger.warn('Provider rate limit active', {
            status,
            rateLimitType: info?.rateLimitType,
            overageStatus: info?.overageStatus,
            resetsAt: resetsAtMs,
          });
          this.emit('output', {
            id: generateId(),
            timestamp: message.timestamp || Date.now(),
            type: 'system',
            content: `Provider rate limit "${status}" (${info?.rateLimitType ?? 'window'}). Resets at ${resetText}.`,
            metadata: {
              rateLimit: true,
              status,
              rateLimitType: info?.rateLimitType,
              resetsAt: resetsAtMs,
            },
          });
        } else {
          logger.debug('Rate limit telemetry', {
            status,
            rateLimitType: info?.rateLimitType,
            resetsAt: info?.resetsAt,
          });
        }
        break;
      }

      case 'control_response': {
        // Resident-interrupt acknowledgement from Claude CLI.
        // Resolves the completion promise returned by interrupt() so the
        // orchestrator can proceed without a respawn cycle.
        //
        // Wire shape (stream-json control protocol): the payload is nested under
        // `response` and correlated by `request_id`:
        //   {type:'control_response', response:{subtype:'success'|'error', request_id, error?}}
        // A defensive fallback also accepts a flat {subtype,status,error} shape.
        const ctrl = raw as {
          response?: { subtype?: string; request_id?: string; error?: string };
          subtype?: string;
          status?: string;
          error?: string;
          request_id?: string;
        };
        const resp = ctrl.response ?? ctrl;
        const respId = resp.request_id ?? ctrl.request_id;
        // Correlate to the in-flight interrupt: match the echoed request_id when
        // present; if the CLI omits it, fall back to "any ack while one interrupt
        // is pending" (interrupts are serialized, so at most one is in flight).
        const matchesPending =
          this.pendingInterruptResolve !== null &&
          (respId === undefined ||
            this.pendingInterruptRequestId === null ||
            respId === this.pendingInterruptRequestId);
        if (matchesPending && this.pendingInterruptResolve) {
          const resolve = this.pendingInterruptResolve;
          this.pendingInterruptResolve = null;
          this.pendingInterruptRequestId = null;
          const subtype = resp.subtype ?? ctrl.subtype;
          const isError = subtype === 'error' || ctrl.status === 'error';
          if (!isError) {
            logger.info('Resident interrupt acknowledged by CLI', { sessionId: this.sessionId, requestId: respId });
            resolve({ status: 'interrupted' });
          } else {
            const reason = resp.error ?? ctrl.error ?? `control_response subtype=${subtype ?? ctrl.status}`;
            logger.warn('control_response interrupt non-success', {
              subtype,
              status: ctrl.status,
              error: reason,
              sessionId: this.sessionId,
            });
            resolve({ status: 'rejected', reason });
          }
        } else {
          logger.debug('control_response received with no matching pending interrupt', {
            respId,
            pendingRequestId: this.pendingInterruptRequestId,
            subtype: resp.subtype ?? ctrl.subtype,
          });
        }
        break;
      }

      default: {
        const unhandled = message as { type: string };
        logger.warn('Unrecognized CLI message type', {
          type: unhandled.type,
          keys: Object.keys(message),
          preview: summarizeClaudeLogText(JSON.stringify(message), 300)
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
    const approvalTraceId = createApprovalTraceId('ask_user_question');
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

}
