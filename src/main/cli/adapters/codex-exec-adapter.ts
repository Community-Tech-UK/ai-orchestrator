import type { CliAttachment, CliMessage, CliResponse } from './base-cli-adapter';
import { CodexBaseAdapter } from './codex-base-adapter';
import type { CodexCliConfig } from './codex-adapter-config';
import type { CodexConversationEntry } from './codex/exec-helpers';
import { getLogger } from '../../logging/logger';
import {
  isCodexModelUnavailableError,
  isRecoverableThreadResumeError,
} from './codex/exec-error-classifier';
import { parseCodexExecTranscript } from './codex/exec-transcript-parser';
import type { ThinkingBlock } from '../../../shared/utils/thinking-extractor';
import { computeTokenCost } from '../../../shared/data/model-pricing';
import { CODEX_TIMEOUTS } from '../../../shared/constants/limits';
import { CodexTimeoutError, type CodexExecPhase } from './codex/exec-timeout';
import { enrichSpawnError } from './base-cli-adapter-utils';
import {
  buildReplayPrompt,
  delay,
  normalizeAttachmentData,
  recordConversationTurn,
} from './codex/exec-helpers';
import { isFatalSpawnError } from './codex/exec-error-classifier';
import type {
  ContextUsage,
  FileAttachment,
  ThinkingContent,
} from '../../../shared/types/instance.types';
import {
  buildMessageWithFiles,
  processAttachments,
  type ProcessedAttachment,
} from '../file-handler';
import { supportsCodexInlineImage } from './codex/attachments';
import { generateId } from '../../../shared/utils/id-generator';
import { wrapCodexSystemInstructions } from './codex/codex-prompt-blocks';
import { wrapRtkAwareness } from '../rtk/rtk-awareness';
import type { CodexDiagnostic } from './codex/exec-diagnostics';
import {
  runCodexExecProcess,
  type CodexExecProcessResult,
} from './codex/exec-process-runner';

const logger = getLogger('CodexCliAdapter');

type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Exec-mode state and command construction shared by the app-server fallback. */
export abstract class CodexExecAdapter extends CodexBaseAdapter {
  protected conversationHistory: CodexConversationEntry[] = [];
  protected shouldResumeNextTurn: boolean;
  protected hasCompletedExecTurn = false;
  protected execModelArgSuppressed = false;
  protected systemPromptSent = false;
  protected rtkAwarenessSent = false;

  protected constructor(config: CodexCliConfig = {}) {
    super(config);
    this.shouldResumeNextTurn = Boolean(
      this.supportsNativeResume() && config.resume && config.sessionId,
    );
  }

  protected override buildArgs(message: CliMessage): string[] {
    const useResume = this.shouldUseResumeCommand();
    const args: string[] = useResume ? ['exec', 'resume'] : ['exec'];

    if (this.cliConfig.model && !this.execModelArgSuppressed) {
      args.push('--model', this.cliConfig.model);
    }
    args.push('--json');

    if (this.cliConfig.ephemeral && !useResume) args.push('--ephemeral');
    if (!useResume) {
      const sandboxMode = this.resolveExecSandboxMode();
      if (sandboxMode) args.push('--sandbox', sandboxMode);
      for (const dir of this.cliConfig.additionalWritableDirs || []) {
        args.push('--add-dir', dir);
      }
      if (this.cliConfig.outputSchemaPath) {
        args.push('--output-schema', this.cliConfig.outputSchemaPath);
      }
    }

    args.push('--skip-git-repo-check');
    for (const attachment of message.attachments || []) {
      if (attachment.type === 'image' && attachment.path) {
        args.push('-i', attachment.path);
      }
    }
    if (useResume && this.sessionId) args.push(this.sessionId);
    return args;
  }

  async sendMessage(message: CliMessage): Promise<CliResponse> {
    try {
      return await this.sendMessageExec(message);
    } catch (error) {
      if (
        this.cliConfig.model &&
        !this.execModelArgSuppressed &&
        isCodexModelUnavailableError(error)
      ) {
        logger.warn('Codex rejected the requested model; retrying with codex default model', {
          requestedModel: this.cliConfig.model,
          cause: error instanceof Error ? error.message : String(error),
        });
        this.execModelArgSuppressed = true;
        return this.sendMessageExec(message);
      }

      if (!isRecoverableThreadResumeError(error) || !this.shouldUseResumeCommand()) {
        throw error;
      }
      this.clearStaleExecResumeState(error);
      return this.sendMessageExec(message);
    }
  }

  async *sendMessageStream(message: CliMessage): AsyncIterable<string> {
    const response = await this.sendMessage(message);
    if (response.content) yield response.content;
  }

  parseOutput(raw: string): CliResponse & { thinking?: ThinkingBlock[] } {
    return parseCodexExecTranscript(raw, [], this.generateResponseId()).response;
  }

  protected async prepareMessage(message: CliMessage): Promise<CliMessage> {
    const normalizedMessage = await this.normalizeMessage(message);
    return this.prepareMessageForExecution(normalizedMessage);
  }

  protected async normalizeMessage(message: CliMessage): Promise<CliMessage> {
    let content = message.content;
    let preparedAttachments: CliAttachment[] | undefined;
    if (message.attachments && message.attachments.length > 0) {
      const processed = await this.prepareAttachments(message.attachments);
      const images = processed.filter(
        (attachment) => attachment.isImage && supportsCodexInlineImage(attachment.mimeType),
      );
      const files = processed.filter(
        (attachment) => !attachment.isImage || !supportsCodexInlineImage(attachment.mimeType),
      );
      if (files.length > 0) content = buildMessageWithFiles(content, files);
      if (images.length > 0) {
        preparedAttachments = images.map((attachment) => ({
          type: 'image',
          path: attachment.filePath,
          mimeType: attachment.mimeType,
          name: attachment.originalName,
        }));
      }
    }
    return { ...message, content, attachments: preparedAttachments };
  }

  protected prepareMessageForExecution(message: CliMessage): CliMessage {
    let content = message.content;
    if (!this.shouldUseResumeCommand() && this.conversationHistory.length > 0) {
      content = buildReplayPrompt(
        this.conversationHistory,
        content,
        CodexExecAdapter.MAX_REPLAY_ENTRIES,
        CodexExecAdapter.MAX_REPLAY_CHARS_PER_ENTRY,
      );
    }
    if (!this.shouldUseResumeCommand() && this.cliConfig.systemPrompt?.trim()) {
      content = wrapCodexSystemInstructions(
        CodexExecAdapter.truncateSystemPrompt(this.cliConfig.systemPrompt.trim()),
        content,
      );
    }
    if (!this.shouldUseResumeCommand() && !this.rtkAwarenessSent && this.cliConfig.rtkEnabled) {
      content = [wrapRtkAwareness(), '', content].join('\n');
      this.rtkAwarenessSent = true;
    }
    return { ...message, content };
  }

  private async prepareAttachments(
    attachments: CliAttachment[],
  ): Promise<ProcessedAttachment[]> {
    const workingDirectory = this.cliConfig.workingDir || process.cwd();
    const files: FileAttachment[] = attachments.map((attachment, index) => ({
      name: attachment.name || `attachment-${index}`,
      type: attachment.mimeType
        || (attachment.type === 'image' ? 'image/png' : 'application/octet-stream'),
      size: attachment.content?.length || 0,
      data: normalizeAttachmentData(attachment.content || ''),
    }));
    return processAttachments(files, this.sessionId || generateId(), workingDirectory);
  }

  protected async sendMessageExec(message: CliMessage): Promise<CliResponse> {
    const normalizedMessage = await this.normalizeMessage(message);
    const preparedMessage = this.prepareMessageForExecution(normalizedMessage);
    const phase: CodexExecPhase = this.hasCompletedExecTurn ? 'turn' : 'startup';
    const timeoutMs = phase === 'startup'
      ? Math.min(CODEX_TIMEOUTS.EXEC_STARTUP_MS, this.resolveDeadlineMs())
      : this.resolveTurnIdleTimeoutMs();
    const maxAttempts = 2;
    let lastError: Error | null = null;
    const resumeCommandAtStart = this.shouldUseResumeCommand();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const execution = await this.executePreparedMessage(preparedMessage, { timeoutMs, phase });
        const response = execution.response;
        if (response.usage && typeof response.usage.cost !== 'number') {
          response.usage.cost = computeTokenCost(this.cliConfig.model, {
            inputTokens: response.usage.inputTokens || 0,
            outputTokens: response.usage.outputTokens || 0,
          });
        }
        const hasMeaningfulOutput =
          response.content.trim().length > 0 || (response.toolCalls?.length || 0) > 0;
        const shouldRetry = attempt < maxAttempts
          && !hasMeaningfulOutput
          && !execution.diagnostics.some((diagnostic) => diagnostic.fatal);

        if (!shouldRetry) {
          this.conversationHistory = recordConversationTurn(
            this.conversationHistory,
            normalizedMessage,
            response,
            CodexExecAdapter.MAX_REPLAY_ENTRIES,
          );
          this.hasCompletedExecTurn = true;
          return response;
        }
        logger.info('Codex exec produced no meaningful output, retrying', {
          attempt,
          maxAttempts,
          diagnosticsCount: execution.diagnostics.length,
        });
        await delay(250 * attempt);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (lastError instanceof CodexTimeoutError) {
          logger.warn('Codex exec timed out — not retrying', {
            phase: lastError.phase,
            kind: lastError.kind,
            timeoutMs: lastError.timeoutMs,
            networkErrorCount: lastError.networkErrorCount,
            lastNetworkError: lastError.lastNetworkError,
            attempt,
          });
          throw lastError;
        }
        if (isFatalSpawnError(lastError)) {
          logger.error('Codex spawn failed — not retrying', lastError, {
            attempt,
            cwd: this.config.cwd,
          });
          throw enrichSpawnError(lastError, this.config.command, this.config.cwd);
        }
        if (isRecoverableThreadResumeError(lastError)) {
          if (resumeCommandAtStart) {
            logger.info(
              'Codex exec resume failed with a stale thread/session id - skipping same-command retry',
              { attempt, maxAttempts, errorMessage: lastError.message },
            );
          }
          throw lastError;
        }
        if (isCodexModelUnavailableError(lastError) || attempt >= maxAttempts) {
          throw lastError;
        }
        logger.info('Codex exec threw transient error, retrying', {
          attempt,
          maxAttempts,
          errorMessage: lastError.message,
        });
        await delay(250 * attempt);
      }
    }
    throw lastError || new Error('Codex execution failed without a diagnostic error.');
  }

  protected async execSendMessage(
    message: string,
    attachments?: FileAttachment[],
  ): Promise<void> {
    await this.execSendMessageInner(message, attachments);
  }

  private async execSendMessageInner(
    message: string,
    attachments?: FileAttachment[],
  ): Promise<void> {
    const cliMessage: CliMessage = {
      role: 'user',
      content: message,
      attachments: attachments?.map((attachment) => ({
        type: attachment.type.startsWith('image/') ? 'image' : 'file',
        content: attachment.data,
        mimeType: attachment.type,
        name: attachment.name,
      })),
    };
    const response = await this.sendMessage(cliMessage) as CliResponse & {
      metadata?: { diagnostics?: CodexDiagnostic[] };
      thinking?: ThinkingBlock[];
    };

    this.emitDiagnostics(response.metadata?.diagnostics);
    for (const tool of response.toolCalls ?? []) {
      this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: 'tool_use',
        content: tool.name === 'command_execution' && typeof tool.arguments['command'] === 'string'
          ? `Running command: ${tool.arguments['command'] as string}`
          : `Using tool: ${tool.name}`,
        metadata: { ...tool } as Record<string, unknown>,
      });
      if (typeof tool.result === 'string' && tool.result.trim()) {
        this.emit('output', {
          id: generateId(),
          timestamp: Date.now(),
          type: 'tool_result',
          content: tool.result,
          metadata: { ...tool, is_error: false } as Record<string, unknown>,
        });
      }
    }

    if (response.content || response.thinking?.length) {
      const thinking: ThinkingContent[] | undefined = response.thinking?.map((block) => ({
        id: block.id,
        content: block.content,
        format: block.format,
        timestamp: block.timestamp || Date.now(),
      }));
      this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: 'assistant',
        content: response.content,
        thinking,
        metadata: { thinkingExtracted: true, metadata: response.metadata },
      });
    }

    if (response.usage) {
      const turnTokens = response.usage.inputTokens !== undefined
        || response.usage.outputTokens !== undefined
        ? (response.usage.inputTokens || 0) + (response.usage.outputTokens || 0)
        : (response.usage.totalTokens || 0);
      this.cumulativeTokensUsed += turnTokens;
      const turnCostUsd = typeof response.usage.cost === 'number'
        && Number.isFinite(response.usage.cost)
        ? Math.max(0, response.usage.cost)
        : computeTokenCost(this.cliConfig.model, {
            inputTokens: response.usage.inputTokens || 0,
            outputTokens: response.usage.outputTokens || 0,
          });
      response.usage.cost = turnCostUsd;
      this.cumulativeCostUsd += turnCostUsd;
      const contextWindow = this.resolveContextWindow();
      const used = this.lastTurnTokens > 0 ? this.lastTurnTokens : 0;
      const contextUsage: ContextUsage = {
        used,
        total: contextWindow,
        percentage: contextWindow > 0 ? Math.min((used / contextWindow) * 100, 100) : 0,
        cumulativeTokens: this.cumulativeTokensUsed,
        costEstimate: this.cumulativeCostUsd,
        isEstimated: true,
      };
      this.emit('context', contextUsage);
    }

    this.completeResponse(response);
  }

  protected async executePreparedMessage(
    message: CliMessage,
    options: { timeoutMs: number; phase: CodexExecPhase },
  ): Promise<CodexExecProcessResult> {
    const args = this.buildArgs(message);
    return runCodexExecProcess({
      message,
      timeoutMs: options.timeoutMs,
      phase: options.phase,
      deadlineMs: this.resolveDeadlineMs(),
      turnIdleTimeoutMs: this.resolveTurnIdleTimeoutMs(),
      spawn: () => this.spawnProcess(args),
      setProcess: (process) => {
        this.process = process;
      },
      isActiveProcess: (process) => this.process === process,
      emitOutput: (output) => this.emit('output', output),
      emitHeartbeat: () => this.emit('heartbeat'),
      emitExit: (code, signal) => this.emit('exit', code, signal),
      generateResponseId: () => this.generateResponseId(),
      recordActivity: this.activityDetector
        ? (chunk) => this.activityDetector!.recordTerminalActivity(chunk)
        : undefined,
      onThreadId: (threadId) => {
        if (!this.supportsNativeResume()) return;
        this.sessionId = threadId;
        this.shouldResumeNextTurn = true;
      },
    });
  }

  private emitDiagnostics(diagnostics?: CodexDiagnostic[]): void {
    if (!diagnostics?.length) return;
    const seen = new Set<string>();
    for (const diagnostic of diagnostics) {
      if (diagnostic.level === 'info' || diagnostic.streamed) continue;
      const key = `${diagnostic.category}:${diagnostic.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: diagnostic.fatal ? 'error' : 'system',
        content: `[codex] ${diagnostic.line}`,
        metadata: {
          diagnostic: true,
          category: diagnostic.category,
          fatal: diagnostic.fatal,
          level: diagnostic.level,
        },
      });
    }
  }

  protected shouldUseResumeCommand(): boolean {
    return Boolean(this.shouldResumeNextTurn && this.sessionId);
  }

  private clearStaleExecResumeState(error: unknown): void {
    logger.warn('Codex exec resume failed, retrying with a fresh session', {
      previousSessionId: this.sessionId,
      cause: error instanceof Error ? error.message : String(error),
    });
    this.sessionId = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.shouldResumeNextTurn = false;
    this.resumeCursor = null;
    this.systemPromptSent = false;
    this.rtkAwarenessSent = false;
  }

  private resolveExecSandboxMode(): CodexSandboxMode | null {
    if (this.cliConfig.approvalMode === 'full-auto') return 'danger-full-access';
    return this.cliConfig.sandboxMode ?? null;
  }

  protected static readonly MAX_REPLAY_CHARS_PER_ENTRY = 1200;
  protected static readonly MAX_REPLAY_ENTRIES = 16;
  private static readonly MAX_SYSTEM_PROMPT_CHARS = 4000;

  protected static truncateSystemPrompt(prompt: string): string {
    if (prompt.length <= this.MAX_SYSTEM_PROMPT_CHARS) return prompt;
    const tailChars = 800;
    const headChars = this.MAX_SYSTEM_PROMPT_CHARS - tailChars;
    return (
      prompt.slice(0, headChars) +
      '\n[... middle of system prompt truncated to protect Codex latency ...]\n' +
      prompt.slice(-tailChars)
    );
  }

  protected abstract resolveDeadlineMs(): number;
  protected abstract resolveTurnIdleTimeoutMs(): number;
}
