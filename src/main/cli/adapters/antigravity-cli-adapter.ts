/**
 * Antigravity CLI Adapter — spawns and manages Google Antigravity CLI (`agy`).
 *
 * Replaces the retired Google Gemini CLI adapter. Antigravity runs one process
 * per message in non-interactive print mode (`agy --print <prompt>`) and emits
 * PLAIN TEXT on stdout (it has no `--output-format stream-json` mode), so this
 * adapter parses raw text rather than JSON event streams. It exposes the same
 * spawn/sendInput surface the InstanceManager expects.
 *
 * agy reports no token usage or dollar cost, so usage is estimated from the
 * response length and priced via the shared pricing table.
 */

import {
  BaseCliAdapter,
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
import type {
  OutputMessage,
  ContextUsage,
  InstanceStatus,
  FileAttachment,
} from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { computeTokenCost } from '../../../shared/data/model-pricing';
import { extractThinkingContent, ThinkingBlock } from '../../../shared/utils/thinking-extractor';
import { wrapRtkAwareness } from '../rtk/rtk-awareness';

const logger = getLogger('AntigravityCliAdapter');

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
  /** Timeout in milliseconds */
  timeout?: number;
  /** Auto-approve mode (maps to `--dangerously-skip-permissions`). */
  yolo?: boolean;
  /** System prompt (prepended to the message content; agy has no system flag). */
  systemPrompt?: string;
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
  private cliConfig: AntigravityCliConfig;
  /** Running total of tokens used across all turns. */
  private cumulativeTokensUsed = 0;
  /** Running USD cost across all turns (priced locally; agy reports none). */
  private cumulativeCostUsd = 0;
  private isSpawned = false;

  constructor(config: AntigravityCliConfig = {}) {
    const adapterConfig: CliAdapterConfig = {
      command: 'agy',
      args: [],
      cwd: config.workingDir,
      timeout: config.timeout || 300000,
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
      streaming: false, // agy --print returns the full response on close
      toolUse: true,
      fileAccess: true,
      shellExecution: true,
      multiTurn: true,
      vision: false,
      codeExecution: true,
      contextWindow: 1000000,
      outputFormats: ['text'],
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
        const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
        if (code === 0 || versionMatch) {
          resolve({
            available: true,
            version: versionMatch?.[1] || 'unknown',
            path: 'agy',
            authenticated: !/not authenticated|sign in|login required/i.test(output),
          });
        } else {
          resolve({
            available: false,
            error: `Antigravity CLI (agy) not found or not configured: ${output}`,
          });
        }
      });

      proc.on('error', (err) => {
        resolve({
          available: false,
          error: `Failed to spawn agy: ${err.message}`,
        });
      });

      setTimeout(() => {
        proc.kill();
        resolve({ available: false, error: 'Timeout checking Antigravity CLI' });
      }, 5000);
    });
  }

  async sendMessage(message: CliMessage): Promise<CliResponse> {
    if (message.attachments && message.attachments.length > 0) {
      throw new Error('Antigravity adapter does not currently support attachments in orchestrator mode.');
    }

    const startTime = Date.now();
    this.outputBuffer = '';

    return new Promise((resolve, reject) => {
      const args = this.buildArgs(message);
      this.process = this.spawnProcess(args);

      this.process.on('error', (err) => {
        this.process = null;
        reject(new Error(`Failed to spawn agy CLI: ${err.message}`));
      });

      // agy reads its prompt from argv; close stdin.
      if (this.process.stdin) {
        this.process.stdin.end();
      }

      const streamingMessageId = generateId();
      let accumulatedContent = '';

      this.process.stdout?.on('data', (data) => {
        const chunk = data.toString();
        this.outputBuffer += chunk;
        accumulatedContent += chunk;
        // agy emits plain text; surface it incrementally for a live feel.
        this.emit('output', {
          id: streamingMessageId,
          timestamp: Date.now(),
          type: 'assistant',
          content: chunk,
          metadata: { streaming: true, accumulatedContent },
        } as OutputMessage);
      });

      this.process.stderr?.on('data', (data) => {
        const trimmed = data.toString().trim();
        if (!trimmed) return;
        const looksLikeError =
          /error|fatal|failed|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|Exception|not authenticated|sign in/i.test(trimmed);
        if (looksLikeError) {
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'error',
            content: trimmed.slice(0, 2000),
          } as OutputMessage);
          this.emitErrorIfObserved(new Error(trimmed));
        } else {
          logger.debug('agy stderr', { text: trimmed.slice(0, 500) });
        }
      });

      this.process.on('close', (code) => {
        const duration = Date.now() - startTime;
        if (code === 0 || this.outputBuffer.trim()) {
          const response = this.parseOutput(this.outputBuffer);
          response.usage = { ...response.usage, duration };
          this.completeResponse(response);
          resolve(response);
        } else {
          reject(new Error(`agy exited with code ${code}`));
        }
        this.process = null;
      });

      const timeout = setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGTERM');
          reject(new Error('Antigravity CLI timeout'));
        }
      }, this.config.timeout);

      this.process.on('close', () => clearTimeout(timeout));
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

    for await (const chunk of stdout) {
      if (spawnError) return;
      yield chunk.toString();
    }
  }

  parseOutput(raw: string): CliResponse & { thinking?: ThinkingBlock[] } {
    const id = this.generateResponseId();
    const extracted = extractThinkingContent(raw.trim());
    const usage = this.extractUsage(raw);

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

    // Model selection is intentionally NOT forwarded yet. agy's accepted
    // `--model` ID format is undocumented (its `agy models` output is
    // display-only) and a wrong value errors, so the antigravity model catalog
    // ships empty and agy is left to pick its own default. The only `model`
    // values that can reach here are stale `gemini-*` ids carried by a legacy
    // Gemini instance normalized to antigravity — passing those to agy would
    // crash the spawn. Re-enable once agy's accepted IDs are confirmed.
    // if (this.cliConfig.model) { args.push('--model', this.cliConfig.model); }

    if (this.cliConfig.sandbox) {
      args.push('--sandbox');
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

    // `--print <prompt>` must come last: the prompt is consumed as its value.
    const baseContent = this.cliConfig.systemPrompt
      ? `${this.cliConfig.systemPrompt}\n\n${message.content}`
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
    logger.warn('Antigravity CLI error without listener', { error: error.message });
  }

  /** agy reports no token usage; estimate from the response content. */
  private extractUsage(raw: string): CliUsage {
    const outputTokens = this.estimateTokens(raw);
    return { inputTokens: 0, outputTokens, totalTokens: outputTokens };
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

  protected override async sendInputImpl(message: string, attachments?: FileAttachment[]): Promise<void> {
    if (!this.isSpawned) {
      throw new Error('Adapter not spawned - call spawn() first');
    }
    if (attachments && attachments.length > 0) {
      throw new Error('Antigravity adapter does not currently support attachments in orchestrator mode.');
    }

    this.emit('status', 'busy' as InstanceStatus);

    try {
      const response = await this.sendMessage({ role: 'user', content: message });

      if (response.usage) {
        const inputTokens = response.usage.inputTokens || 0;
        const outputTokens = response.usage.outputTokens || 0;
        const turnTokens = inputTokens || outputTokens
          ? inputTokens + outputTokens
          : (response.usage.totalTokens || 0);
        this.cumulativeTokensUsed += turnTokens;
        this.cumulativeCostUsd += computeTokenCost(this.cliConfig.model, { inputTokens, outputTokens });
        const contextWindow = this.getCapabilities().contextWindow;
        const used = Math.min(turnTokens, contextWindow);
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
      this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error',
        content: error instanceof Error ? error.message : String(error),
      } as OutputMessage);
      this.emit('status', 'error' as InstanceStatus);
      this.emitErrorIfObserved(error instanceof Error ? error : new Error(String(error)));
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
