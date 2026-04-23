/**
 * Copilot CLI Adapter - Spawns and manages the GitHub Copilot CLI
 * via the standalone `copilot` binary when available, or `gh copilot` as a fallback.
 *
 * Replaces the former `copilot-sdk-adapter` which wrapped `@github/copilot-sdk`.
 * That SDK proxied the same underlying CLI via JSON-RPC and had repeated
 * ESM/packaging issues (missing `.js` extensions in the 0.x line). Since every
 * feature we used is also exposed as CLI flags (`-p`, `--output-format json`,
 * `--stream`, `--resume`), we spawn the CLI directly — matching the Claude /
 * Codex / Gemini adapters — and drop a whole class of fragility.
 *
 * Execution model: exec-per-message (like Gemini), not a persistent process
 * (like Claude). Each `sendInput()` invocation spawns a fresh `copilot -p`
 * child. Multi-turn is achieved by capturing the Copilot `result.sessionId`
 * from the first turn and passing it back via `--resume=<id>` on subsequent
 * turns. This is also how Copilot's own `--continue` flag is implemented
 * upstream.
 */

import {
  BaseCliAdapter,
  AdapterRuntimeCapabilities,
  CliAdapterConfig,
  CliCapabilities,
  CliMessage,
  CliResponse,
  CliStatus,
  CliUsage,
} from './base-cli-adapter';
import { getLogger } from '../../logging/logger';
import type {
  OutputMessage,
  ContextUsage,
  InstanceStatus,
  ThinkingContent,
} from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { extractThinkingContent, ThinkingBlock } from '../../../shared/utils/thinking-extractor';
import { getDefaultCopilotCliLaunch } from '../copilot-cli-launch';

const logger = getLogger('CopilotCliAdapter');

/**
 * Copilot CLI specific configuration
 */
export interface CopilotCliConfig {
  /** Model to use (e.g. 'claude-sonnet-4-6', 'gpt-5.5', 'gemini-2.5-pro'). */
  model?: string;
  /** Working directory for the CLI process. */
  workingDir?: string;
  /** System prompt / additional instructions.
   *  The Copilot CLI does not expose a dedicated system-prompt flag in non-interactive
   *  mode, so when set we prepend it to the user prompt. */
  systemPrompt?: string;
  /** YOLO mode — grant all permissions without prompting. Required for non-interactive
   *  use; the CLI `-p` mode also requires `--allow-all-tools` which we always set.
   *  `yoloMode` additionally passes `--yolo` which enables all path+URL permissions. */
  yoloMode?: boolean;
  /** Timeout in milliseconds for a single message call. */
  timeout?: number;
}

/**
 * Events emitted by CopilotCliAdapter (preserved from CopilotSdkAdapter for
 * source-level compatibility with existing event wiring in CopilotCliProvider).
 */
export interface CopilotCliAdapterEvents {
  output: (message: OutputMessage) => void;
  status: (status: InstanceStatus) => void;
  context: (usage: ContextUsage) => void;
  error: (error: Error) => void;
  exit: (code: number | null, signal: string | null) => void;
  spawned: (pid: number) => void;
}

/**
 * Simplified model info for orchestrator use.
 * Identical shape to the former SDK adapter's CopilotModelInfo so downstream
 * callers (settings UI, model picker, parity tests) don't need changes.
 */
export interface CopilotModelInfo {
  id: string;
  name: string;
  supportsVision: boolean;
  contextWindow: number;
  enabled: boolean;
}

export const COPILOT_AUTO_MODEL_ID = 'auto';

const COPILOT_MODEL_DISCOVERY_CACHE_TTL_MS = 5 * 60_000;

let cachedCopilotModels: CopilotModelInfo[] | null = null;
let cachedCopilotModelsAt = 0;
let copilotModelDiscoveryPromise: Promise<CopilotModelInfo[]> | null = null;

/** Default context window when we don't know the model. Matches the old SDK adapter. */
const DEFAULT_CONTEXT_WINDOW = 128_000;

function toTitleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatCopilotModelDisplayName(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) {
    return modelId;
  }

  if (normalized === COPILOT_AUTO_MODEL_ID) {
    return 'Auto';
  }

  if (normalized === 'o3') {
    return 'OpenAI o3';
  }

  const parts = normalized.split('-');
  if (parts.length === 0) {
    return modelId;
  }

  if (parts[0] === 'gpt' && parts[1]) {
    const [, version, ...rest] = parts;
    return [`GPT-${version}`, ...rest.map(toTitleCase)].join(' ');
  }

  return parts
    .map((part, index) => {
      if (index > 0 && /^\d/.test(part)) {
        return part;
      }
      return toTitleCase(part);
    })
    .join(' ');
}

function estimateCopilotModelContextWindow(modelId: string): number {
  const normalized = modelId.trim().toLowerCase();
  if (
    normalized.includes('claude-sonnet-4.6')
    || normalized.includes('claude-opus-4.6')
    || normalized.includes('claude-opus-4.7')
  ) {
    return 1_000_000;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

function toCopilotModelInfo(modelId: string): CopilotModelInfo {
  return {
    id: modelId,
    name: formatCopilotModelDisplayName(modelId),
    supportsVision: normalizedCopilotVisionModel(modelId),
    contextWindow: estimateCopilotModelContextWindow(modelId),
    enabled: true,
  };
}

function normalizedCopilotVisionModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return normalized === COPILOT_AUTO_MODEL_ID
    || normalized.startsWith('claude-')
    || normalized.startsWith('gpt-')
    || normalized.startsWith('gemini-')
    || normalized === 'o3'
    || normalized.startsWith('grok-')
    || normalized.startsWith('goldeneye')
    || normalized.startsWith('raptor');
}

function ensureCopilotAutoModel(models: CopilotModelInfo[]): CopilotModelInfo[] {
  if (models.some(model => model.id === COPILOT_AUTO_MODEL_ID)) {
    return models;
  }

  return [toCopilotModelInfo(COPILOT_AUTO_MODEL_ID), ...models];
}

function parseCopilotModelIdsFromHelpConfig(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const modelIds: string[] = [];
  let inModelSection = false;

  for (const line of lines) {
    if (!inModelSection) {
      if (/^\s*`model`:\s+AI model to use for Copilot CLI/i.test(line)) {
        inModelSection = true;
      }
      continue;
    }

    if (/^\s*`[^`]+`:/i.test(line)) {
      break;
    }

    const match = line.match(/^\s*-\s+"([^"]+)"\s*$/);
    if (match?.[1]) {
      modelIds.push(match[1]);
    }
  }

  return [...new Set(modelIds)];
}

/**
 * Default Copilot models (used as fallback when CLI runtime model listing
 * isn't reachable). This list mirrors the current stable `copilot help config`
 * output, with an explicit `auto` entry added because Copilot CLI accepts
 * `--model auto` even though `help config` does not list it.
 */
export const COPILOT_DEFAULT_MODELS: CopilotModelInfo[] = [
  'auto',
  'claude-sonnet-4.6',
  'claude-sonnet-4.5',
  'claude-haiku-4.5',
  'claude-opus-4.7',
  'claude-opus-4.6',
  'claude-opus-4.6-fast',
  'claude-opus-4.5',
  'claude-sonnet-4',
  'gpt-5.5',
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5.5-mini',
  'gpt-5-mini',
  'gpt-4.1',
].map(toCopilotModelInfo);

/**
 * Copilot CLI Adapter - Spawns the `copilot` binary per message.
 */
export class CopilotCliAdapter extends BaseCliAdapter {
  private cliConfig: CopilotCliConfig;
  /** Running total of tokens used across all turns (cumulative spend). */
  private cumulativeTokensUsed = 0;
  /** Marks the adapter as ready to accept messages. The CLI runs exec-per-message,
   *  so there is no persistent process; spawn() just gates usage and validates. */
  private isSpawned = false;
  /** Copilot's own session ID, captured from the `result` event on each turn.
   *  Used on subsequent turns via `--resume=<id>` to stitch multi-turn conversations
   *  together without maintaining a persistent process. */
  private copilotSessionId: string | null = null;
  /** Reasoning blocks accumulated during the current turn (reset per message). */
  private currentMessageReasoning: ThinkingContent[] = [];

  constructor(config: CopilotCliConfig = {}) {
    const launch = getDefaultCopilotCliLaunch();
    const adapterConfig: CliAdapterConfig = {
      command: launch.command,
      args: [...launch.argsPrefix],
      cwd: config.workingDir,
      timeout: config.timeout ?? 300_000,
      sessionPersistence: true,
    };
    super(adapterConfig);

    this.cliConfig = { ...config };
    this.sessionId = `copilot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // ============ BaseCliAdapter Abstract Implementations ============

  getName(): string {
    return 'copilot-cli';
  }

  getCapabilities(): CliCapabilities {
    return {
      streaming: true,
      toolUse: true,
      // The standalone copilot CLI cannot accept orchestrator attachments yet.
      fileAccess: false,
      shellExecution: true,
      multiTurn: true,
      vision: false,
      codeExecution: true,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      outputFormats: ['text', 'json'],
    };
  }

  override getRuntimeCapabilities(): AdapterRuntimeCapabilities {
    return {
      // Copilot supports --resume=<sessionId>, which we use transparently in
      // sendInput once we've captured a sessionId from a prior `result` event.
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
        output += data.toString();
      });
      proc.stderr?.on('data', (data) => {
        errorOutput += data.toString();
      });

      const timer = setTimeout(() => {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* ignored */
        }
        resolve({
          available: false,
          error: 'Timeout checking Copilot CLI',
        });
      }, 5000);

      proc.on('close', (code) => {
        clearTimeout(timer);
        const combined = `${output}\n${errorOutput}`;
        const versionMatch = combined.match(/(\d+\.\d+\.\d+)/);

        if (code === 0 || versionMatch) {
          resolve({
            available: true,
            version: versionMatch?.[1] ?? 'unknown',
            path: 'copilot',
            // We can't tell definitively from --version; assume authenticated
            // when the binary runs. `copilot login` + `copilot --version`
            // don't interact, so a real auth probe would need a no-op -p run.
            authenticated: true,
          });
        } else {
          resolve({
            available: false,
            error: `Copilot CLI not found or failed (exit ${code}): ${combined.trim() || 'no output'}`,
          });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          available: false,
          error: `Failed to spawn copilot: ${err.message}`,
        });
      });
    });
  }

  async sendMessage(message: CliMessage): Promise<CliResponse> {
    if (message.attachments && message.attachments.length > 0) {
      // The `copilot` CLI has no non-interactive attachment flag today; the
      // SDK wrapper supported this via the JSON-RPC session interface. If we
      // ever need this for orchestrator mode we can inline attachments by
      // reference (@filepath) in the prompt.
      throw new Error('Copilot adapter does not currently support attachments in orchestrator mode.');
    }

    const startTime = Date.now();
    this.outputBuffer = '';
    this.currentMessageReasoning = [];

    return new Promise<CliResponse>((resolve, reject) => {
      const args = this.buildArgs(message);
      logger.debug('Spawning copilot', {
        args: this.redactPromptForLog(args),
        hasResumeId: !!this.copilotSessionId,
      });
      this.process = this.spawnProcess(args);

      // Handle spawn errors (e.g., ENOENT when binary doesn't exist)
      this.process.on('error', (err) => {
        this.process = null;
        reject(new Error(`Failed to spawn copilot CLI: ${err.message}`));
      });

      // Copilot -p reads the prompt from --prompt argument; close stdin.
      if (this.process.stdin) {
        this.process.stdin.end();
      }

      // Per-turn streaming state
      let streamingMessageId: string | null = null;
      let hasReceivedStreamingDeltas = false;
      let streamingContent = '';
      const activeToolCalls = new Map<string, { name: string; input?: Record<string, unknown> }>();

      // Line-buffered JSON parsing (Copilot emits one JSON object per line
      // on stdout under `--output-format json`). We don't use NdjsonParser
      // directly because Copilot's event shape differs from CliStreamMessage.
      let lineBuffer = '';

      const ensureStreamingMessageId = (preferredId?: string): string => {
        if (!streamingMessageId) {
          streamingMessageId = preferredId?.trim() || generateId();
        }
        return streamingMessageId;
      };

      const emitStreamingAssistantUpdate = (messageId: string, content: string): void => {
        const extracted = extractThinkingContent(content);
        const thinking = [...this.currentMessageReasoning, ...extracted.thinking];

        this.emit('output', {
          id: messageId,
          timestamp: Date.now(),
          type: 'assistant',
          content,
          metadata: { streaming: true, accumulatedContent: extracted.response },
          thinking: thinking.length > 0 ? thinking : undefined,
          thinkingExtracted: true,
        } as OutputMessage);
      };

      const normalizeToolInput = (value: unknown): Record<string, unknown> | undefined => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return value as Record<string, unknown>;
        }
        return undefined;
      };

      const handleCopilotEvent = (event: CopilotEvent): void => {
        switch (event.type) {
          case 'assistant.message_delta': {
            const delta = event.data?.deltaContent ?? '';
            if (!delta) break;
            hasReceivedStreamingDeltas = true;
            const messageId = ensureStreamingMessageId(event.data?.messageId);
            streamingContent += delta;
            emitStreamingAssistantUpdate(messageId, streamingContent);
            break;
          }

          case 'assistant.message': {
            const content = event.data?.content ?? '';
            if (!content) break;

            const messageId = ensureStreamingMessageId(event.data?.messageId);

            if (hasReceivedStreamingDeltas) {
              if (!streamingContent) {
                streamingContent = content;
                emitStreamingAssistantUpdate(messageId, streamingContent);
                break;
              }

              if (content === streamingContent || streamingContent.startsWith(content)) {
                emitStreamingAssistantUpdate(messageId, streamingContent);
                break;
              }

              if (content.startsWith(streamingContent)) {
                streamingContent = content;
                emitStreamingAssistantUpdate(messageId, streamingContent);
                break;
              }

              logger.warn('Copilot assistant final does not extend streamed content; replacing accumulated text', {
                streamedLength: streamingContent.length,
                finalLength: content.length,
              });
              streamingContent = content;
              emitStreamingAssistantUpdate(messageId, streamingContent);
              break;
            }

            streamingContent = content;
            const extracted = extractThinkingContent(content);
            const thinking: ThinkingContent[] = [
              ...this.currentMessageReasoning,
              ...extracted.thinking.map((t) => ({ ...t, timestamp: Date.now() })),
            ];

            this.emit('output', {
              id: messageId,
              timestamp: Date.now(),
              type: 'assistant',
              content: extracted.response,
              thinking: thinking.length > 0 ? thinking : undefined,
              thinkingExtracted: true,
            } as OutputMessage);

            // Per-turn token accounting: prefer outputTokens from the
            // assistant.message event; we get full usage from `result`.
            if (typeof event.data?.outputTokens === 'number') {
              // Recorded but emitted as context on `result` to avoid double-emit.
            }
            break;
          }

          case 'assistant.reasoning': {
            const reasoning = event.data?.content;
            if (reasoning) {
              this.currentMessageReasoning.push({
                id: generateId(),
                content: reasoning,
                format: 'sdk',
                timestamp: Date.now(),
              });
            }
            break;
          }

          case 'tool.execution_start': {
            const toolName = event.data?.toolName ?? 'unknown';
            const toolCallId = event.data?.toolCallId;
            const input = normalizeToolInput(event.data?.arguments);

            if (toolCallId) {
              activeToolCalls.set(toolCallId, { name: toolName, input });
            }

            this.emit('output', {
              id: generateId(),
              timestamp: Date.now(),
              type: 'tool_use',
              content: `Using tool: ${toolName}`,
              metadata: {
                id: toolCallId,
                name: toolName,
                input,
                tool_use_id: toolCallId,
                toolName,
                toolCallId,
              },
            } as OutputMessage);
            break;
          }

          case 'tool.execution_complete': {
            const toolCallId = event.data?.toolCallId;
            const toolContext = toolCallId ? activeToolCalls.get(toolCallId) : undefined;
            if (toolCallId) {
              activeToolCalls.delete(toolCallId);
            }

            const toolName = toolContext?.name ?? event.data?.toolName ?? 'unknown';
            const input = toolContext?.input;
            const toolSucceeded = event.data?.success !== false;
            const errorMessage = typeof event.data?.error?.message === 'string'
              ? event.data.error.message
              : undefined;

            this.emit('output', {
              id: generateId(),
              timestamp: Date.now(),
              type: 'tool_result',
              content: toolSucceeded
                ? `Tool ${toolName} completed`
                : `Tool ${toolName} failed${errorMessage ? `: ${errorMessage}` : ''}`,
              metadata: {
                name: toolName,
                input,
                tool_use_id: toolCallId,
                is_error: !toolSucceeded,
                toolName,
                toolCallId,
                success: toolSucceeded,
                output: event.data?.result,
                error: event.data?.error,
              },
            } as OutputMessage);
            if (!toolSucceeded) {
              this.emit('output', {
                id: generateId(),
                timestamp: Date.now(),
                type: 'error',
                content: `Copilot tool call failed (${toolName}${toolCallId ? `, ${toolCallId}` : ''})${errorMessage ? `: ${errorMessage}` : ''}`,
                metadata: {
                  name: toolName,
                  input,
                  tool_use_id: toolCallId,
                  toolName,
                  toolCallId,
                  error: event.data?.error,
                  raw: event,
                },
              } as OutputMessage);
            }
            break;
          }

          case 'session.error': {
            const sessionErrMsg = event.data?.message ?? 'Copilot session error';
            // Also emit as an `error` OutputMessage so it lands in the
            // instance's output buffer and becomes visible in the UI plus
            // in the child-exit summary fallback.
            this.emit('output', {
              id: generateId(),
              timestamp: Date.now(),
              type: 'error',
              content: sessionErrMsg,
              metadata: { source: 'copilot-session-error' },
            } as OutputMessage);
            this.emit('error', new Error(sessionErrMsg));
            break;
          }

          case 'result': {
            // Terminal event. Captures sessionId (for --resume), exitCode,
            // and per-session usage.
            if (event.sessionId) {
              this.copilotSessionId = event.sessionId;
            }
            if (event.usage) {
              const usage = event.usage;
              // Copilot's `result.usage` doesn't give input/output token
              // split — it gives premiumRequests + durations + code changes.
              // Use outputTokens from `assistant.message` if we saw one.
              // Fall back to a rough estimate from accumulated content.
              const outputTokens = this.estimateTokens(streamingContent || this.outputBuffer);
              this.cumulativeTokensUsed += outputTokens;
              const contextWindow = this.getCapabilities().contextWindow;
              // Report occupancy as the running cumulative estimate
              // (input + output across turns) rather than this-turn output
              // only, which dramatically under-reported and kept the
              // context bar near zero indefinitely. Flagged `isEstimated`
              // because copilot's usage object doesn't expose real input
              // token counts.
              const used = Math.min(this.cumulativeTokensUsed, contextWindow);
              const contextUsage: ContextUsage = {
                used,
                total: contextWindow,
                percentage: contextWindow > 0 ? Math.min((used / contextWindow) * 100, 100) : 0,
                cumulativeTokens: this.cumulativeTokensUsed,
                isEstimated: true,
              };
              this.emit('context', contextUsage);

              // Also log cost signal for diagnostics.
              logger.debug('Copilot turn complete', {
                sessionId: event.sessionId,
                premiumRequests: usage.premiumRequests,
                totalApiDurationMs: usage.totalApiDurationMs,
                sessionDurationMs: usage.sessionDurationMs,
              });
            }
            break;
          }

          // Session setup events — ignored (they're noise for the orchestrator,
          // but we keep them listed here to document what we're intentionally
          // dropping):
          case 'session.mcp_server_status_changed':
          case 'session.mcp_servers_loaded':
          case 'session.skills_loaded':
          case 'session.tools_updated':
          case 'session.idle':
          case 'user.message':
          case 'assistant.turn_start':
          case 'assistant.turn_end':
            break;

          default:
            logger.debug('Unhandled copilot event type', { type: (event as { type?: string }).type });
        }
      };

      this.process.stdout?.on('data', (data) => {
        const chunk = data.toString();
        this.outputBuffer += chunk;
        lineBuffer += chunk;

        // Split into complete lines; keep the last partial line for next chunk.
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let event: CopilotEvent;
          try {
            event = JSON.parse(trimmed) as CopilotEvent;
          } catch {
            // Non-JSON output (shouldn't happen under --output-format json, but
            // `copilot update` banners or similar can sneak through). Skip.
            continue;
          }

          handleCopilotEvent(event);
        }
      });

      this.process.stderr?.on('data', (data) => {
        const errorStr = data.toString();
        // Heuristic: the CLI writes banners/info to stderr too. Only escalate
        // if it looks like a real error.
        if (/error|fatal|failed/i.test(errorStr)) {
          logger.warn('copilot stderr', { text: errorStr.trim() });
        }
      });

      this.process.on('close', (code) => {
        // Flush any final partial line (shouldn't have JSON mid-object under
        // --stream on because each event is newline-terminated, but be safe).
        if (lineBuffer.trim()) {
          try {
            const trailingEvent = JSON.parse(lineBuffer.trim()) as CopilotEvent;
            handleCopilotEvent(trailingEvent);
          } catch {
            /* drop incomplete trailing line */
          }
          lineBuffer = '';
        }

        const duration = Date.now() - startTime;

        if (code !== 0 && code !== null) {
          this.process = null;
          reject(new Error(`Copilot exited with code ${code}`));
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
          reject(new Error(`Copilot CLI timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.process.on('close', () => clearTimeout(timeout));
    });
  }

  async *sendMessageStream(message: CliMessage): AsyncIterable<string> {
    const args = this.buildArgs(message);
    this.process = this.spawnProcess(args);

    let spawnError: Error | null = null;
    this.process.on('error', (err) => {
      spawnError = new Error(`Failed to spawn copilot CLI: ${err.message}`);
      this.emit('error', spawnError);
      this.process = null;
    });

    if (this.process.stdin) {
      this.process.stdin.end();
    }

    const stdout = this.process.stdout;
    if (!stdout) return;

    let lineBuffer = '';
    for await (const chunk of stdout) {
      if (spawnError) return;
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as CopilotEvent;
          if (event.type === 'assistant.message_delta' && event.data?.deltaContent) {
            yield event.data.deltaContent;
          } else if (event.type === 'result' && event.sessionId) {
            this.copilotSessionId = event.sessionId;
          }
        } catch {
          /* skip non-JSON */
        }
      }
    }
  }

  parseOutput(raw: string): CliResponse & { thinking?: ThinkingBlock[] } {
    const id = this.generateResponseId();
    let finalContent = '';
    const usage: CliUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    const lines = raw.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as CopilotEvent;
        if (event.type === 'assistant.message' && event.data?.content) {
          finalContent = event.data.content;
          if (typeof event.data.outputTokens === 'number') {
            usage.outputTokens = event.data.outputTokens;
            usage.totalTokens = event.data.outputTokens;
          }
        }
      } catch {
        /* skip non-JSON */
      }
    }

    // Fallback: estimate tokens from content length if the CLI didn't report them.
    if (!usage.outputTokens) {
      usage.outputTokens = this.estimateTokens(finalContent);
      usage.totalTokens = usage.outputTokens;
    }

    const extracted = extractThinkingContent(finalContent);

    return {
      id,
      content: extracted.response,
      role: 'assistant',
      usage,
      raw,
      thinking: extracted.thinking.length > 0 ? extracted.thinking : undefined,
    };
  }

  protected buildArgs(message: CliMessage): string[] {
    const args: string[] = [];

    // Model selection. Pass `auto` explicitly so the CLI uses its own
    // auto-routing instead of falling through to any saved config override.
    const configuredModel = this.cliConfig.model?.trim();
    if (configuredModel) {
      const normalizedModel = configuredModel.toLowerCase() === COPILOT_AUTO_MODEL_ID
        ? COPILOT_AUTO_MODEL_ID
        : configuredModel;
      args.push('--model', normalizedModel);
    }

    // Non-interactive mode requires --allow-all-tools. Tighten via
    // --available-tools/--deny-tool if we ever want finer control.
    args.push('--allow-all-tools');

    // YOLO mode additionally allows all paths + URLs. Without this the CLI
    // will prompt for file/URL access, which is fatal in non-interactive mode.
    if (this.cliConfig.yoloMode) {
      args.push('--yolo');
    } else {
      // Even without yolo we need to allow paths+urls for non-interactive runs.
      // The CLI's own docs say --allow-all-tools is required for -p; path/url
      // prompts are a separate permission domain. We opt for both-allow in
      // orchestrator mode — the orchestrator itself is the approval layer.
      args.push('--allow-all-paths', '--allow-all-urls');
    }

    // Streaming JSON output — line-delimited, one event per line.
    args.push('--output-format', 'json');
    args.push('--stream', 'on');

    // Keep startup fast: disable auto-update check and suppress the log file.
    args.push('--no-auto-update');
    args.push('--log-level', 'none');

    // Silence the stats footer in text mode; under --output-format json this
    // is a no-op but harmless.
    args.push('-s');

    // Resume the Copilot session we captured on a prior turn, if any.
    // This is how we achieve multi-turn without a persistent process.
    if (this.copilotSessionId) {
      args.push('--resume', this.copilotSessionId);
    }

    // Compose the prompt. Copilot has no dedicated system-prompt flag in
    // non-interactive mode, so we prepend when provided.
    const prompt = this.cliConfig.systemPrompt
      ? `${this.cliConfig.systemPrompt}\n\n${message.content}`
      : message.content;

    args.push('--prompt', prompt);

    return args;
  }

  /**
   * Redact the prompt body from arg logs — prompts can contain sensitive data
   * and we don't want it in log files. Shows `--prompt <redacted N chars>`.
   */
  private redactPromptForLog(args: string[]): string[] {
    const out = [...args];
    const i = out.indexOf('--prompt');
    if (i >= 0 && out[i + 1] !== undefined) {
      const len = out[i + 1].length;
      out[i + 1] = `<redacted ${len} chars>`;
    }
    return out;
  }

  // ============ InstanceManager Compatibility API ============

  /**
   * "Spawn" the adapter — validates the CLI is available and marks as ready.
   * The CLI runs exec-per-message, so there is no persistent process.
   */
  async spawn(): Promise<number> {
    if (this.isSpawned) {
      throw new Error('Adapter already spawned');
    }

    const status = await this.checkStatus();
    if (!status.available) {
      throw new Error(
        `GitHub Copilot CLI not available: ${status.error ?? 'copilot command not found'}. ` +
        'Install GitHub CLI and run `gh copilot`, or install `@github/copilot` globally.',
      );
    }

    this.isSpawned = true;
    // Use a synthetic PID — there's no persistent process to attach to.
    // Each sendInput() will spawn a new child; its real PID is available via
    // getPid() while that call is in flight.
    const fakePid = Math.floor(Math.random() * 100_000) + 10_000;
    this.emit('spawned', fakePid);
    this.emit('status', 'idle' as InstanceStatus);

    return fakePid;
  }

  /**
   * Send a message to Copilot via exec command. Each call spawns a new
   * `copilot -p` child. Multi-turn is handled via --resume.
   */
  async sendInput(message: string, attachments?: unknown[]): Promise<void> {
    if (!this.isSpawned) {
      throw new Error('Adapter not spawned - call spawn() first');
    }

    if (attachments && attachments.length > 0) {
      throw new Error('Copilot adapter does not currently support attachments in orchestrator mode.');
    }

    // Fold the outgoing user message into the cumulative-token estimate so
    // the context bar reflects input as well as output. Copilot's `result.usage`
    // doesn't split input/output tokens, so this is the only place we can
    // credit input bytes against context occupancy.
    this.cumulativeTokensUsed += this.estimateTokens(message);

    this.emit('status', 'busy' as InstanceStatus);

    try {
      const cliMessage: CliMessage = {
        role: 'user',
        content: message,
      };

      // sendMessage() emits streaming OutputMessages and context events
      // during the turn; we only need to flip to idle on success here.
      await this.sendMessage(cliMessage);
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
   * Override terminate to clean up spawned state.
   */
  override async terminate(graceful = true): Promise<void> {
    const wasSpawned = this.isSpawned;
    await super.terminate(graceful);
    this.isSpawned = false;
    this.copilotSessionId = null;
    this.currentMessageReasoning = [];
    if (wasSpawned) {
      this.emit('exit', 0, null);
    }
  }

  // ============ Additional API surface preserved from the SDK adapter ============

  /**
   * Return the latest Copilot session ID captured from a `result` event.
   * Used by session-persistence tooling that wants to stitch together turns.
   */
  getCopilotSessionId(): string | null {
    return this.copilotSessionId;
  }

  /**
   * Lists available Copilot models. The CLI does not expose a stable
   * machine-readable model listing, so we parse the installed binary's
   * `help config` output and cache the result. This keeps the renderer and
   * model validation aligned with the actual local Copilot CLI version.
   */
  async listAvailableModels(): Promise<CopilotModelInfo[]> {
    const now = Date.now();
    if (cachedCopilotModels && (now - cachedCopilotModelsAt) < COPILOT_MODEL_DISCOVERY_CACHE_TTL_MS) {
      return cachedCopilotModels;
    }

    if (copilotModelDiscoveryPromise) {
      return copilotModelDiscoveryPromise;
    }

    copilotModelDiscoveryPromise = new Promise<CopilotModelInfo[]>((resolve, reject) => {
      const proc = this.spawnProcess(['--no-auto-update', '--log-level', 'none', 'help', 'config']);
      let output = '';
      let errorOutput = '';

      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });
      proc.stderr?.on('data', (data) => {
        errorOutput += data.toString();
      });

      const timer = setTimeout(() => {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* ignored */
        }
        reject(new Error('Timeout fetching Copilot model list'));
      }, 5000);

      proc.on('close', (code) => {
        clearTimeout(timer);
        const discoveredIds = parseCopilotModelIdsFromHelpConfig(output);
        if (code === 0 && discoveredIds.length > 0) {
          const models = ensureCopilotAutoModel(discoveredIds.map(toCopilotModelInfo));
          cachedCopilotModels = models;
          cachedCopilotModelsAt = Date.now();
          resolve(models);
          return;
        }

        reject(
          new Error(
            `Failed to parse Copilot model list (exit ${code}): ${errorOutput.trim() || 'no output'}`
          )
        );
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    }).catch((error) => {
      logger.warn('Falling back to default Copilot model list', {
        error: error instanceof Error ? error.message : String(error),
      });
      return COPILOT_DEFAULT_MODELS;
    }).finally(() => {
      copilotModelDiscoveryPromise = null;
    });

    return copilotModelDiscoveryPromise;
  }
}

// ============ Internal types for parsing Copilot's JSONL event schema ============

/**
 * Events emitted by `copilot -p --output-format json --stream on`.
 * Not exhaustive; we only type the fields we actually read.
 */
type CopilotEvent =
  | {
      type: 'assistant.message_delta';
      data?: { messageId?: string; deltaContent?: string };
    }
  | {
      type: 'assistant.message';
      data?: {
        messageId?: string;
        content?: string;
        outputTokens?: number;
      };
    }
  | {
      type: 'assistant.reasoning';
      data?: { content?: string; reasoningId?: string };
    }
  | {
      type: 'tool.execution_start';
      data?: {
        toolName?: string;
        toolCallId?: string;
        arguments?: Record<string, unknown>;
      };
    }
  | {
      type: 'tool.execution_complete';
      data?: {
        toolCallId?: string;
        toolName?: string;
        success?: boolean;
        result?: {
          content?: string;
          detailedContent?: string;
          contents?: unknown[];
        };
        error?: {
          message?: string;
          code?: string;
        };
      };
    }
  | {
      type: 'session.error';
      data?: { message?: string };
    }
  | {
      type: 'result';
      sessionId?: string;
      exitCode?: number;
      usage?: {
        premiumRequests?: number;
        totalApiDurationMs?: number;
        sessionDurationMs?: number;
        codeChanges?: { linesAdded?: number; linesRemoved?: number; filesModified?: string[] };
      };
    }
  | {
      // Uninterpreted setup / housekeeping events.
      type:
        | 'session.mcp_server_status_changed'
        | 'session.mcp_servers_loaded'
        | 'session.skills_loaded'
        | 'session.tools_updated'
        | 'session.idle'
        | 'user.message'
        | 'assistant.turn_start'
        | 'assistant.turn_end';
      data?: unknown;
    };
