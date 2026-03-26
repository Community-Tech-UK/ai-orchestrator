/**
 * Codex CLI Adapter - Spawns and manages OpenAI Codex CLI processes
 * https://github.com/openai/codex
 *
 * Uses `codex exec` / `codex exec resume` in stateless job mode while
 * preserving native Codex thread continuity across messages.
 */

import {
  BaseCliAdapter,
  AdapterRuntimeCapabilities,
  CliAdapterConfig,
  CliAttachment,
  CliCapabilities,
  CliMessage,
  CliResponse,
  CliStatus,
  CliToolCall,
  CliUsage,
} from './base-cli-adapter';
import type { ContextUsage, FileAttachment, InstanceStatus, OutputMessage, ThinkingContent } from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { extractThinkingContent, ThinkingBlock } from '../../../shared/utils/thinking-extractor';
import { buildMessageWithFiles, processAttachments, type ProcessedAttachment } from '../file-handler';

type CodexApprovalMode = 'suggest' | 'auto-edit' | 'full-auto';
type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

interface CodexDiagnostic {
  category: 'auth' | 'mcp' | 'models' | 'process' | 'sandbox' | 'session' | 'startup' | 'unknown';
  fatal: boolean;
  line: string;
  level: 'error' | 'info' | 'warning';
}

interface CodexExecutionResult {
  code: number | null;
  diagnostics: CodexDiagnostic[];
  raw: string;
  response: CliResponse & { metadata: Record<string, unknown>; thinking?: ThinkingBlock[] };
}

interface CodexExecutionState {
  diagnostics: CodexDiagnostic[];
  partialStderr: string;
  partialStdout: string;
  rawStderr: string;
  rawStdout: string;
  toolCalls: CliToolCall[];
  threadId?: string;
  usage?: CliUsage;
}

interface CodexConversationEntry {
  content: string;
  role: 'assistant' | 'user';
}

/**
 * Codex CLI specific configuration
 */
export interface CodexCliConfig {
  /** Approval mode: suggest, auto-edit, or full-auto */
  approvalMode?: CodexApprovalMode;
  /** Additional writable directories */
  additionalWritableDirs?: string[];
  /** Run without persisting session files to disk */
  ephemeral?: boolean;
  /** Model to use (gpt-5.4, gpt-5.3-codex, etc.) */
  model?: string;
  /** Path to a JSON schema file describing the final output */
  outputSchemaPath?: string;
  /** Resume the provided session/thread on the next exec */
  resume?: boolean;
  /** Sandbox mode: read-only, workspace-write, or danger-full-access */
  sandboxMode?: CodexSandboxMode;
  /** Existing Codex session/thread id */
  sessionId?: string;
  /** System prompt to inject into each exec request */
  systemPrompt?: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Working directory */
  workingDir?: string;
}

/**
 * Events emitted by CodexCliAdapter (for InstanceManager compatibility)
 */
export interface CodexCliAdapterEvents {
  'context': (usage: ContextUsage) => void;
  'error': (error: Error) => void;
  'exit': (code: number | null, signal: string | null) => void;
  'output': (message: OutputMessage) => void;
  'spawned': (pid: number) => void;
  'status': (status: InstanceStatus) => void;
}

/**
 * Codex CLI Adapter - Implementation for OpenAI Codex CLI
 */
export class CodexCliAdapter extends BaseCliAdapter {
  private static readonly MAX_REPLAY_CHARS_PER_ENTRY = 1200;
  private static readonly MAX_REPLAY_ENTRIES = 16;

  private cliConfig: CodexCliConfig;
  private conversationHistory: CodexConversationEntry[] = [];
  private isSpawned = false;
  private shouldResumeNextTurn: boolean;
  /** Running total of tokens used across all turns */
  private cumulativeTokensUsed = 0;

  constructor(config: CodexCliConfig = {}) {
    const adapterConfig: CliAdapterConfig = {
      command: 'codex',
      args: [],
      cwd: config.workingDir,
      timeout: config.timeout || 300000,
      sessionPersistence: !config.ephemeral,
    };
    super(adapterConfig);

    this.cliConfig = config;
    this.sessionId = config.sessionId || `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.shouldResumeNextTurn = Boolean(this.supportsNativeResume() && config.resume && config.sessionId);
  }

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
      vision: true,
      codeExecution: true,
      contextWindow: 400000,
      outputFormats: ['text', 'json'],
    };
  }

  override getRuntimeCapabilities(): AdapterRuntimeCapabilities {
    return {
      supportsResume: this.supportsNativeResume(),
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
            authenticated: true,
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
    const normalizedMessage = await this.normalizeMessage(message);
    const preparedMessage = this.prepareMessageForExecution(normalizedMessage);
    const maxAttempts = 2;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const execution = await this.executePreparedMessage(preparedMessage);
        const response = execution.response;
        const content = response.content.trim();
        const hasMeaningfulOutput = content.length > 0 || (response.toolCalls?.length || 0) > 0;
        const shouldRetry = attempt < maxAttempts
          && !hasMeaningfulOutput
          && !execution.diagnostics.some((diagnostic) => diagnostic.fatal);

        if (!shouldRetry) {
          this.recordConversationTurn(normalizedMessage, response);
          this.emit('complete', response);
          return response;
        }

        await this.delay(250 * attempt);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= maxAttempts) {
          throw lastError;
        }
        await this.delay(250 * attempt);
      }
    }

    throw lastError || new Error('Codex execution failed without a diagnostic error.');
  }

  async *sendMessageStream(message: CliMessage): AsyncIterable<string> {
    const response = await this.sendMessage(message);
    if (response.content) {
      yield response.content;
    }
  }

  parseOutput(raw: string): CliResponse & { thinking?: ThinkingBlock[] } {
    const parsed = this.parseTranscript(raw, []);
    return parsed.response;
  }

  protected buildArgs(message: CliMessage): string[] {
    const useResume = this.shouldUseResumeCommand();
    const args: string[] = useResume ? ['exec', 'resume'] : ['exec'];

    if (this.cliConfig.model) {
      args.push('--model', this.cliConfig.model);
    }

    args.push('--json');

    if (this.cliConfig.ephemeral) {
      args.push('--ephemeral');
    }

    if (!useResume) {
      if (this.cliConfig.approvalMode === 'full-auto') {
        args.push('--full-auto');
      } else if (this.cliConfig.sandboxMode) {
        args.push('--sandbox', this.cliConfig.sandboxMode);
      }
    } else if (this.cliConfig.approvalMode === 'full-auto') {
      args.push('--full-auto');
    }

    if (!useResume) {
      for (const dir of this.cliConfig.additionalWritableDirs || []) {
        args.push('--add-dir', dir);
      }
    }

    if (!useResume && this.cliConfig.outputSchemaPath) {
      args.push('--output-schema', this.cliConfig.outputSchemaPath);
    }

    args.push('--skip-git-repo-check');

    // Disable Codex-native MCP servers during exec calls.  In interactive
    // mode these servers stay running, but `codex exec` cold-starts them on
    // every invocation — adding minutes of latency (one startup_timeout per
    // server).  The orchestrator manages its own MCP integrations.
    args.push('-c', 'mcp_servers={}');

    for (const attachment of message.attachments || []) {
      if (attachment.type === 'image' && attachment.path) {
        args.push('-i', attachment.path);
      }
    }

    if (useResume && this.sessionId) {
      args.push(this.sessionId);
    }

    // Prompt is written to stdin in executePreparedMessage, not as a positional arg.
    // Modern Codex CLI reads from stdin ("Reading prompt from stdin...").

    return args;
  }

  async spawn(): Promise<number> {
    if (this.isSpawned) {
      throw new Error('Adapter already spawned');
    }

    const status = await this.checkStatus();
    if (!status.available) {
      throw new Error(status.error || 'Codex CLI is unavailable');
    }

    this.isSpawned = true;
    const fakePid = Math.floor(Math.random() * 100000) + 10000;
    this.emit('spawned', fakePid);
    this.emit('status', 'idle' as InstanceStatus);
    return fakePid;
  }

  async sendInput(message: string, attachments?: FileAttachment[]): Promise<void> {
    if (!this.isSpawned) {
      throw new Error('Adapter not spawned - call spawn() first');
    }

    this.emit('status', 'busy' as InstanceStatus);
    const isResume = this.shouldUseResumeCommand();
    this.emit('output', {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content: isResume
        ? '[codex] Resuming Codex thread...'
        : '[codex] Starting Codex CLI... (this may take a moment if MCP servers are loading)',
    });

    try {
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
        metadata?: {
          diagnostics?: CodexDiagnostic[];
        };
        thinking?: ThinkingBlock[];
      };

      this.emitDiagnostics(response.metadata?.diagnostics);

      if (response.toolCalls) {
        for (const tool of response.toolCalls) {
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
      }

      if (response.content || (response.thinking && response.thinking.length > 0)) {
        const thinkingContent: ThinkingContent[] | undefined = response.thinking?.map((block) => ({
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
          thinking: thinkingContent,
          thinkingExtracted: true,
          metadata: response.metadata,
        });
      }

      if (response.usage) {
        const turnTokens = response.usage.inputTokens !== undefined || response.usage.outputTokens !== undefined
          ? (response.usage.inputTokens || 0) + (response.usage.outputTokens || 0)
          : (response.usage.totalTokens || 0);
        this.cumulativeTokensUsed += turnTokens;
        const contextWindow = this.getCapabilities().contextWindow;
        const contextUsage: ContextUsage = {
          used: this.cumulativeTokensUsed,
          total: contextWindow,
          percentage: Math.min((this.cumulativeTokensUsed / contextWindow) * 100, 100),
        };
        this.emit('context', contextUsage);
      }

      this.emit('status', 'idle' as InstanceStatus);
    } catch (error) {
      this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error',
        content: `Codex error: ${error instanceof Error ? error.message : String(error)}`,
      });
      this.emit('status', 'error' as InstanceStatus);
      throw error;
    }
  }

  override async terminate(graceful = true): Promise<void> {
    this.isSpawned = false;
    await super.terminate(graceful);
  }

  private classifyDiagnostic(line: string): CodexDiagnostic {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    const hasErrorLevel = /\berror\b/i.test(trimmed);
    const hasWarnLevel = /\bwarn\b/i.test(trimmed);

    if (
      lower.includes('failed to refresh available models')
      || lower.includes('timeout waiting for child process to exit')
    ) {
      return { category: 'models', fatal: false, line: trimmed, level: 'warning' };
    }

    if (
      lower.includes('failed to terminate mcp process group')
      || lower.includes('failed to kill mcp process group')
    ) {
      return { category: 'mcp', fatal: false, line: trimmed, level: 'warning' };
    }

    if (lower.includes('failed to delete shell snapshot')) {
      return { category: 'startup', fatal: false, line: trimmed, level: 'warning' };
    }

    // Internal Codex state-db housekeeping logs (e.g. "state db missing rollout path for thread ...")
    // These are non-actionable Rust-level diagnostics that should not surface to the user.
    if (lower.includes('state db missing rollout path') || lower.includes('codex_core::rollout')) {
      return { category: 'unknown', fatal: false, line: trimmed, level: 'info' };
    }

    if (
      lower.includes('unauthorized')
      || lower.includes('authentication')
      || lower.includes('forbidden')
      || lower.includes('login required')
    ) {
      return { category: 'auth', fatal: true, line: trimmed, level: 'error' };
    }

    if (
      lower.includes('unknown model')
      || lower.includes('model not found')
      || lower.includes('invalid model')
    ) {
      return { category: 'models', fatal: true, line: trimmed, level: 'error' };
    }

    if (
      lower.includes('session not found')
      || lower.includes('thread not found')
      || lower.includes('no matching session')
    ) {
      return { category: 'session', fatal: true, line: trimmed, level: 'error' };
    }

    if (
      lower.includes('permission denied')
      || lower.includes('sandbox')
      || lower.includes('dangerously-bypass-approvals-and-sandbox')
    ) {
      return { category: 'sandbox', fatal: hasErrorLevel, line: trimmed, level: hasErrorLevel ? 'error' : 'warning' };
    }

    if (hasWarnLevel) {
      return { category: 'unknown', fatal: false, line: trimmed, level: 'warning' };
    }

    if (hasErrorLevel) {
      return { category: 'process', fatal: false, line: trimmed, level: 'warning' };
    }

    return { category: 'unknown', fatal: false, line: trimmed, level: 'info' };
  }

  private cleanContent(raw: string): string {
    const nonJsonContent = raw
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() && !line.trim().startsWith('{'))
      .join('\n');
    const { response } = extractThinkingContent(nonJsonContent);
    return response
      .replace(/\[TOOL:\s*\w+\][\s\S]*?\[\/TOOL\]/g, '')
      .replace(/\[codex\].*$/gim, '')
      .trim();
  }

  private async executePreparedMessage(message: CliMessage): Promise<CodexExecutionResult> {
    return new Promise((resolve, reject) => {
      const args = this.buildArgs(message);
      const process = this.spawnProcess(args);
      const state: CodexExecutionState = {
        diagnostics: [],
        partialStderr: '',
        partialStdout: '',
        rawStderr: '',
        rawStdout: '',
        toolCalls: [],
      };

      this.process = process;

      // Write the prompt to stdin — modern Codex CLI reads from stdin, not positional args
      if (process.stdin) {
        if (message.content) {
          process.stdin.write(message.content);
        }
        process.stdin.end();
      }

      process.stdout?.on('data', (data) => {
        const chunk = data.toString();
        state.rawStdout += chunk;
        state.partialStdout = this.consumeLines(chunk, state.partialStdout, (line) => {
          this.processStdoutLine(line, state);
        });
      });

      process.stderr?.on('data', (data) => {
        const chunk = data.toString();
        state.rawStderr += chunk;
        state.partialStderr = this.consumeLines(chunk, state.partialStderr, (line) => {
          const diagnostic = this.classifyDiagnostic(line);
          state.diagnostics.push(diagnostic);

          // Emit fatal diagnostics immediately so the user doesn't wait
          // minutes only to discover an auth/config error at the end.
          if (diagnostic.fatal) {
            this.emit('output', {
              id: generateId(),
              timestamp: Date.now(),
              type: 'error',
              content: `[codex] ${diagnostic.line}`,
              metadata: { diagnostic: true, category: diagnostic.category, fatal: true },
            });
          }
        });
      });

      const timeout = setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGTERM');
          this.process = null;
          reject(new Error('Codex CLI timeout'));
        }
      }, this.config.timeout);

      process.on('error', (error) => {
        clearTimeout(timeout);
        this.process = null;
        reject(error);
      });

      process.on('close', (code, signal) => {
        clearTimeout(timeout);

        if (state.partialStdout.trim()) {
          this.processStdoutLine(state.partialStdout, state);
        }
        if (state.partialStderr.trim()) {
          state.diagnostics.push(this.classifyDiagnostic(state.partialStderr));
        }

        const parsed = this.parseTranscript(state.rawStdout, state.diagnostics);
        const raw = [state.rawStdout.trim(), state.rawStderr.trim()].filter(Boolean).join('\n');

        if (parsed.threadId && this.supportsNativeResume()) {
          this.sessionId = parsed.threadId;
          this.shouldResumeNextTurn = true;
        }

        this.process = null;
        this.emit('exit', code, signal);

        if (code !== 0 && !parsed.hasMeaningfulOutput) {
          const diagnosticSummary = state.diagnostics.map((diagnostic) => diagnostic.line).join('\n');
          reject(new Error(diagnosticSummary || `Codex exited with code ${code}`));
          return;
        }

        resolve({
          code,
          diagnostics: state.diagnostics,
          raw,
          response: {
            ...parsed.response,
            metadata: {
              ...parsed.response.metadata,
              diagnostics: state.diagnostics,
            },
            raw,
          },
        });
      });
    });
  }

  private async prepareMessage(message: CliMessage): Promise<CliMessage> {
    const normalizedMessage = await this.normalizeMessage(message);
    return this.prepareMessageForExecution(normalizedMessage);
  }

  private async normalizeMessage(message: CliMessage): Promise<CliMessage> {
    let content = message.content;
    let preparedAttachments: CliAttachment[] | undefined;

    if (message.attachments && message.attachments.length > 0) {
      const processedAttachments = await this.prepareAttachments(message.attachments);
      const imageAttachments = processedAttachments.filter((attachment) => attachment.isImage);
      const fileAttachments = processedAttachments.filter((attachment) => !attachment.isImage);

      if (fileAttachments.length > 0) {
        content = buildMessageWithFiles(content, fileAttachments);
      }

      if (imageAttachments.length > 0) {
        preparedAttachments = imageAttachments.map((attachment) => ({
          type: 'image',
          path: attachment.filePath,
          mimeType: attachment.mimeType,
          name: attachment.originalName,
        }));
      }
    }

    return {
      ...message,
      content,
      attachments: preparedAttachments,
    };
  }

  /**
   * Max chars for the system prompt injected into message content.
   * Codex CLI natively loads instruction files (AGENTS.md, CLAUDE.md, etc.)
   * from the working directory, so the orchestrator's merged instruction
   * content is largely redundant.  Injecting 15 KB+ of duplicate instructions
   * causes dramatic latency increases (minutes instead of seconds) because
   * every `codex exec` call re-processes the giant prompt through the model.
   * Cap the injection so only the compact orchestrator-specific context (agent
   * role, observation, tool permissions) is sent.
   */
  private static readonly MAX_SYSTEM_PROMPT_CHARS = 4000;

  private prepareMessageForExecution(message: CliMessage): CliMessage {
    let content = message.content;

    if (!this.shouldUseResumeCommand() && this.conversationHistory.length > 0) {
      content = this.buildReplayPrompt(content);
    }

    // Skip system prompt on resume turns — the Codex thread already has full
    // context from the initial turn.  Re-injecting it wastes tokens.
    if (!this.shouldUseResumeCommand() && this.cliConfig.systemPrompt?.trim()) {
      const prompt = this.cliConfig.systemPrompt.trim();
      // Only inject the system prompt when it is reasonably short.  Large
      // prompts are almost certainly the merged project instruction files
      // which Codex already loads natively from the working directory.
      if (prompt.length <= CodexCliAdapter.MAX_SYSTEM_PROMPT_CHARS) {
        content = [
          '[SYSTEM INSTRUCTIONS]',
          prompt,
          '[/SYSTEM INSTRUCTIONS]',
          '',
          content,
        ].join('\n');
      }
    }

    return {
      ...message,
      content,
    };
  }

  private async prepareAttachments(attachments: CliAttachment[]): Promise<ProcessedAttachment[]> {
    const workingDirectory = this.cliConfig.workingDir || process.cwd();
    const fileAttachments: FileAttachment[] = attachments.map((attachment, index) => ({
      name: attachment.name || `attachment-${index}`,
      type: attachment.mimeType || (attachment.type === 'image' ? 'image/png' : 'application/octet-stream'),
      size: attachment.content?.length || 0,
      data: this.normalizeAttachmentData(attachment.content || ''),
    }));
    return processAttachments(fileAttachments, this.sessionId || generateId(), workingDirectory);
  }

  private emitDiagnostics(diagnostics?: CodexDiagnostic[]): void {
    if (!diagnostics || diagnostics.length === 0) {
      return;
    }

    const seen = new Set<string>();
    for (const diagnostic of diagnostics) {
      if (diagnostic.level === 'info') {
        continue;
      }
      const key = `${diagnostic.category}:${diagnostic.line}`;
      if (seen.has(key)) {
        continue;
      }
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

  private extractTextFromItem(item: Record<string, unknown>): string | undefined {
    if (typeof item['text'] === 'string') {
      return item['text'];
    }

    const message = item['message'];
    if (message && typeof message === 'object' && typeof (message as Record<string, unknown>)['content'] === 'string') {
      return (message as Record<string, unknown>)['content'] as string;
    }

    const content = item['content'];
    if (typeof content === 'string') {
      return content;
    }

    return undefined;
  }

  private parseTranscript(
    rawStdout: string,
    diagnostics: CodexDiagnostic[]
  ): {
    hasMeaningfulOutput: boolean;
    response: CliResponse & { metadata: Record<string, unknown>; thinking?: ThinkingBlock[] };
    threadId?: string;
  } {
    const lines = rawStdout.split('\n').map((line) => line.trim()).filter(Boolean);
    const contentParts: string[] = [];
    const toolCalls: CliToolCall[] = [];
    let usage: CliUsage | undefined;
    let threadId: string | undefined;

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const type = typeof event['type'] === 'string' ? event['type'] : '';

        // Capture thread/session ID from various Codex event formats.
        // Different Codex CLI versions use different event names.
        if (!threadId) {
          const id = event['thread_id'] ?? event['session_id'] ?? event['id'];
          if (
            typeof id === 'string'
            && (type === 'thread.started'
              || type === 'session.started'
              || type === 'session.created'
              || type === 'thread.created')
          ) {
            threadId = id;
            continue;
          }
        }

        if (type === 'turn.completed' && event['usage'] && typeof event['usage'] === 'object') {
          const usageEvent = event['usage'] as Record<string, unknown>;
          const inputTokens = typeof usageEvent['input_tokens'] === 'number' ? usageEvent['input_tokens'] : 0;
          const outputTokens = typeof usageEvent['output_tokens'] === 'number' ? usageEvent['output_tokens'] : 0;
          usage = {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
          };
          continue;
        }

        if (type === 'item.completed' && event['item'] && typeof event['item'] === 'object') {
          const item = event['item'] as Record<string, unknown>;
          const itemType = typeof item['type'] === 'string' ? item['type'] : '';

          if (itemType === 'agent_message') {
            const text = this.extractTextFromItem(item);
            if (text) {
              contentParts.push(text);
            }
            continue;
          }

          if (itemType === 'command_execution') {
            toolCalls.push({
              id: typeof item['id'] === 'string' ? item['id'] : `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name: 'command_execution',
              arguments: {
                command: item['command'],
                exitCode: item['exit_code'],
                status: item['status'],
              },
              result: typeof item['aggregated_output'] === 'string' ? item['aggregated_output'] : undefined,
            });
            continue;
          }

          const fallbackText = this.extractTextFromItem(item);
          if (fallbackText) {
            contentParts.push(fallbackText);
          }
          continue;
        }

        if (type === 'message' && typeof event['content'] === 'string') {
          contentParts.push(event['content']);
          continue;
        }

        if (type === 'agent_message' && event['message'] && typeof event['message'] === 'object') {
          const message = event['message'] as Record<string, unknown>;
          if (typeof message['content'] === 'string') {
            contentParts.push(message['content']);
          }
          continue;
        }

        if (type === 'text' && typeof event['text'] === 'string') {
          contentParts.push(event['text']);
          continue;
        }
      } catch {
        if (!line.startsWith('{')) {
          contentParts.push(line);
        }
      }
    }

    let content = contentParts.join('\n').trim();
    if (!content) {
      content = this.cleanContent(rawStdout);
    }

    if (toolCalls.length === 0) {
      toolCalls.push(...this.extractToolCallsFromFallback(rawStdout));
    }

    const extracted = extractThinkingContent(content);

    return {
      hasMeaningfulOutput: extracted.response.trim().length > 0 || toolCalls.length > 0,
      response: {
        id: this.generateResponseId(),
        content: extracted.response,
        role: 'assistant',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage,
        metadata: {
          diagnostics,
          threadId,
        },
        raw: rawStdout,
        thinking: extracted.thinking.length > 0 ? extracted.thinking : undefined,
      },
      threadId,
    };
  }

  private processStdoutLine(line: string, state: CodexExecutionState): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const eventType = typeof event['type'] === 'string' ? event['type'] : '';

      // Capture thread/session ID from various Codex event names
      if (!state.threadId) {
        const id = event['thread_id'] ?? event['session_id'] ?? event['id'];
        if (
          typeof id === 'string'
          && (eventType === 'thread.started'
            || eventType === 'session.started'
            || eventType === 'session.created'
            || eventType === 'thread.created')
        ) {
          state.threadId = id as string;
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'system',
            content: '[codex] Connected to Codex thread, waiting for response...',
          });
        }
      }

      // Emit real-time tool use events so the UI isn't silent during long executions
      if (eventType === 'item.created' && event['item'] && typeof event['item'] === 'object') {
        const item = event['item'] as Record<string, unknown>;
        if (item['type'] === 'command_execution' && typeof item['command'] === 'string') {
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_use',
            content: `Running command: ${item['command'] as string}`,
            metadata: { streaming: true },
          });
        }
      }

      return;
    } catch {
      // Non-JSON lines are kept in raw stdout and parsed later as fallback content.
    }
  }

  private shouldUseResumeCommand(): boolean {
    return Boolean(this.shouldResumeNextTurn && this.sessionId);
  }

  /**
   * Whether the adapter can use `codex exec resume` for subsequent turns.
   * Thread resumption is a Codex thread-continuity feature and is independent
   * of the approval policy.  Previously this was gated on `full-auto`, which
   * meant resume was never used for suggest/read-only instances — causing every
   * turn to re-send the full system prompt + conversation history and
   * burning 100K+ tokens per message.
   */
  private supportsNativeResume(): boolean {
    return true;
  }

  private buildReplayPrompt(currentMessage: string): string {
    const replayEntries = this.conversationHistory
      .slice(-CodexCliAdapter.MAX_REPLAY_ENTRIES)
      .map((entry) => {
        const role = entry.role === 'user' ? 'User' : 'Assistant';
        return [
          `<${role}>`,
          this.truncateReplayContent(entry.content),
          `</${role}>`,
        ].join('\n');
      });

    return [
      '[CONVERSATION HISTORY]',
      'Use the recent transcript below as context for the current request.',
      '',
      ...replayEntries,
      '',
      '[/CONVERSATION HISTORY]',
      '',
      '[CURRENT USER MESSAGE]',
      currentMessage,
      '[/CURRENT USER MESSAGE]',
    ].join('\n');
  }

  private truncateReplayContent(content: string): string {
    const normalized = content.trim();
    if (normalized.length <= CodexCliAdapter.MAX_REPLAY_CHARS_PER_ENTRY) {
      return normalized;
    }
    return `${normalized.slice(0, CodexCliAdapter.MAX_REPLAY_CHARS_PER_ENTRY)}...[truncated]`;
  }

  private consumeLines(
    chunk: string,
    carry: string,
    handleLine: (line: string) => void
  ): string {
    const combined = carry + chunk;
    const lines = combined.split('\n');
    const remainder = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) {
        handleLine(line);
      }
    }
    return remainder;
  }

  private extractToolCallsFromFallback(raw: string): CliToolCall[] {
    const toolCalls: CliToolCall[] = [];
    const toolPattern = /\[TOOL:\s*(\w+)\]([\s\S]*?)\[\/TOOL\]/g;
    let match: RegExpExecArray | null;

    while ((match = toolPattern.exec(raw)) !== null) {
      toolCalls.push({
        id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: match[1],
        arguments: { raw: match[2].trim() },
      });
    }

    return toolCalls;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private recordConversationTurn(message: CliMessage, response: CliResponse): void {
    const userContent = this.buildHistoryEntryContent(message);
    if (userContent) {
      this.conversationHistory.push({ role: 'user', content: userContent });
    }

    const assistantContent = response.content.trim() || this.summarizeToolCalls(response.toolCalls);
    if (assistantContent) {
      this.conversationHistory.push({ role: 'assistant', content: assistantContent });
    }

    if (this.conversationHistory.length > CodexCliAdapter.MAX_REPLAY_ENTRIES) {
      this.conversationHistory = this.conversationHistory.slice(-CodexCliAdapter.MAX_REPLAY_ENTRIES);
    }
  }

  private buildHistoryEntryContent(message: CliMessage): string {
    const imageNames = (message.attachments || [])
      .filter((attachment) => attachment.type === 'image')
      .map((attachment) => attachment.name || 'image');
    const imageSummary = imageNames.length > 0
      ? `[Attached images: ${imageNames.join(', ')}]`
      : '';

    if (message.content.trim() && imageSummary) {
      return `${message.content.trim()}\n${imageSummary}`;
    }

    return message.content.trim() || imageSummary;
  }

  private summarizeToolCalls(toolCalls?: CliToolCall[]): string {
    if (!toolCalls || toolCalls.length === 0) {
      return '';
    }

    return toolCalls
      .slice(0, 3)
      .map((toolCall) => {
        if (toolCall.name === 'command_execution' && typeof toolCall.arguments['command'] === 'string') {
          return `Executed command: ${toolCall.arguments['command'] as string}`;
        }
        return `Used tool: ${toolCall.name}`;
      })
      .join('\n');
  }

  private normalizeAttachmentData(data: string): string {
    if (!data) {
      return data;
    }

    if (data.startsWith('data:')) {
      return data;
    }

    if (this.looksLikeBase64(data)) {
      return data;
    }

    return Buffer.from(data, 'utf-8').toString('base64');
  }

  private looksLikeBase64(data: string): boolean {
    if (data.length < 16 || data.length % 4 !== 0) {
      return false;
    }
    return /^[A-Za-z0-9+/]+={0,2}$/.test(data);
  }
}
