import { EventEmitter } from 'node:events';
import type { ContextUsage, FileAttachment, InstanceStatus, OutputMessage } from '../../../shared/types/instance.types';
import type { CliType } from '../cli-detection';
import type { UnifiedSpawnOptions } from '../adapters/adapter-factory';
import type {
  AdapterRuntimeCapabilities,
  CliCapabilities,
  CliMessage,
  CliResponse,
  CliSpawnMode,
  CliStatus,
  InterruptResult,
} from '../adapters/base-cli-adapter';
import type { DeferredToolUse } from '../adapters/claude-cli-adapter.types';
import { generateId } from '../../../shared/utils/id-generator';
import { getProviderModelContextWindow } from '../../../shared/types/provider.types';
import { computeTokenCost } from '../../../shared/data/model-pricing';
import { getPauseCoordinator } from '../../pause/pause-coordinator';
import { OrchestratorPausedError } from '../../pause/orchestrator-paused-error';
import {
  type CliSpawnGatewayPort,
  getCliSpawnWorkerGateway,
} from './cli-spawn-worker-gateway';
import { buildWorkerArgs } from './cli-adapter-worker-args';
import { formatClaudeWorkerInput } from './cli-adapter-worker-input';
import { parseWorkerOutput } from './cli-adapter-worker-output';

interface CliAdapterWorkerProxyOptions {
  cliType: Extract<CliType, 'claude' | 'gemini'>;
  instanceId: string;
  options: UnifiedSpawnOptions;
  gateway?: CliSpawnGatewayPort;
}

export class CliAdapterWorkerProxy extends EventEmitter {
  private readonly cliType: Extract<CliType, 'claude' | 'gemini'>;
  private readonly instanceId: string;
  private readonly options: UnifiedSpawnOptions;
  private readonly gateway: CliSpawnGatewayPort;
  private sessionId: string | null;
  private pid: number | null = null;
  private running = false;
  private spawned = false;
  private outputBuffer = '';
  private cumulativeTokensUsed = 0;
  private cumulativeCostUsd = 0;
  private spawnMode: CliSpawnMode;
  private stdoutLineBuffer = '';
  private lastKnownContextWindow: number;
  private deferredToolUse: DeferredToolUse | null = null;
  private geminiRtkAwarenessSent = false;

  constructor(opts: CliAdapterWorkerProxyOptions) {
    super();
    this.cliType = opts.cliType;
    this.instanceId = opts.instanceId;
    this.options = opts.options;
    this.gateway = opts.gateway ?? getCliSpawnWorkerGateway();
    this.sessionId = opts.options.sessionId ?? `${opts.cliType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.spawnMode = opts.cliType === 'gemini' ? 'subprocess-exec' : 'subprocess-stream';
    this.lastKnownContextWindow = opts.cliType === 'claude'
      ? getProviderModelContextWindow('claude-cli', opts.options.model)
      : 1000000;
    this.gateway.registerInstance(this.instanceId, {
      spawned: (pid) => {
        this.pid = pid;
        this.running = true;
        this.emit('spawned', pid);
      },
      stdout: (chunk) => this.handleStdout(chunk),
      stderr: (chunk) => this.handleStderr(chunk),
      exited: (code, signal) => this.handleExit(code, signal),
      streamIdle: (timeoutMs) => {
        this.emit('stream:idle', {
          adapter: this.getName(),
          timeoutMs,
          pid: this.pid,
        });
      },
      epipe: (pipe) => {
        this.emit('stderr', `EPIPE on ${pipe}`);
      },
    });
  }

  getName(): string {
    return this.cliType === 'claude' ? 'claude-cli' : 'gemini-cli';
  }

  getCapabilities(): CliCapabilities {
    if (this.cliType === 'claude') {
      return {
        streaming: true,
        toolUse: true,
        fileAccess: true,
        shellExecution: true,
        multiTurn: true,
        vision: true,
        codeExecution: true,
        contextWindow: getProviderModelContextWindow('claude-cli', this.options.model),
        outputFormats: ['ndjson', 'text', 'json'],
      };
    }
    return {
      streaming: true,
      toolUse: true,
      fileAccess: true,
      shellExecution: true,
      multiTurn: true,
      vision: false,
      codeExecution: true,
      contextWindow: 1000000,
      outputFormats: ['text', 'json', 'markdown'],
    };
  }

  async checkStatus(): Promise<CliStatus> {
    const probeInstanceId = `${this.instanceId}:status:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let output = '';
    this.gateway.registerInstance(probeInstanceId, {
      stdout: (chunk) => { output += chunk; },
      stderr: (chunk) => { output += chunk; },
    });
    try {
      await this.gateway.spawnInstance({
        instanceId: probeInstanceId,
        command: this.command(),
        args: ['--version'],
        cwd: this.options.workingDirectory ?? process.cwd(),
        env: this.options.env ?? {},
        closeStdin: true,
        streamIdleTimeoutMs: 5000,
      });
      await this.gateway.terminate(probeInstanceId, false).catch(() => undefined);
      const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
      return {
        available: true,
        authenticated: true,
        path: this.command(),
        version: versionMatch?.[1] ?? 'worker-offload',
      };
    } catch (err) {
      return {
        available: false,
        error: `Failed to spawn ${this.command()}: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      this.gateway.unregisterInstance(probeInstanceId);
    }
  }

  async spawn(): Promise<number> {
    if (this.spawned) {
      throw new Error('Adapter already spawned');
    }
    if (this.cliType === 'gemini') {
      const status = await this.checkStatus();
      if (!status.available) {
        throw new Error(`Gemini CLI not available: ${status.error ?? 'gemini command not found'}`);
      }
      this.spawned = true;
      this.pid = Math.floor(Math.random() * 100000) + 10000;
      this.emit('spawned', this.pid);
      this.emit('status', 'idle' as InstanceStatus);
      return this.pid;
    }
    const result = await this.spawnWorkerProcess(this.buildArgs({ role: 'user', content: '' }));
    this.spawned = true;
    this.emit('status', 'idle' as InstanceStatus);
    return result.pid;
  }

  async sendInput(message: string, attachments?: FileAttachment[]): Promise<void> {
    if (getPauseCoordinator().isPaused()) {
      throw new OrchestratorPausedError('CLI input refused while orchestrator is paused');
    }
    if (!this.spawned) {
      throw new Error('Adapter not spawned - call spawn() first');
    }
    this.emit('status', 'busy' as InstanceStatus);
    if (this.cliType === 'gemini') {
      if (attachments && attachments.length > 0) {
        throw new Error('Gemini adapter does not currently support attachments in orchestrator mode.');
      }
      this.outputBuffer = '';
      await this.runTurn(this.buildArgs({ role: 'user', content: message }), undefined, { closeStdin: true });
      this.geminiRtkAwarenessSent = true;
      return;
    }
    await this.gateway.writeStdin(this.instanceId, await this.formatClaudeInput(message, attachments));
  }

  async sendMessage(message: CliMessage): Promise<CliResponse> {
    const stdin = this.cliType === 'claude'
      ? await this.formatClaudeInput(message.content, message.attachments as FileAttachment[] | undefined)
      : undefined;
    const response = await this.runTurn(this.buildArgs(message), stdin, {
      closeStdin: this.cliType === 'gemini',
      closeStdinAfterWrite: this.cliType === 'claude',
    });
    if (this.cliType === 'gemini') this.geminiRtkAwarenessSent = true;
    return response;
  }

  private async runTurn(
    args: string[],
    stdin: string | undefined,
    opts: { closeStdin?: boolean; closeStdinAfterWrite?: boolean } = {},
  ): Promise<CliResponse> {
    this.outputBuffer = '';
    this.stdoutLineBuffer = '';
    return new Promise((resolve, reject) => {
      let settled = false;
      const onComplete = (response: CliResponse) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(response);
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onExit = (code: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (code === 0 || this.outputBuffer.trim()) {
          resolve(this.parseOutput(this.outputBuffer));
          return;
        }
        reject(new Error(`${this.getName()} exited with code ${code}`));
      };
      const cleanup = () => {
        this.off('complete', onComplete);
        this.off('error', onError);
        this.off('exit', onExit);
      };
      this.once('complete', onComplete);
      this.once('error', onError);
      this.once('exit', onExit);
      this.spawnWorkerProcess(args, opts)
        .then(() => stdin ? this.gateway.writeStdin(this.instanceId, stdin, { closeAfterWrite: opts.closeStdinAfterWrite }) : undefined)
        .catch(onError);
    });
  }

  async *sendMessageStream(message: CliMessage): AsyncIterable<string> {
    const chunks: string[] = [];
    const onOutput = (output: OutputMessage | string) => {
      if (typeof output === 'string') {
        chunks.push(output);
      } else if (output.type === 'assistant') {
        chunks.push(output.content);
      }
    };
    this.on('output', onOutput);
    try {
      await this.sendMessage(message);
      while (chunks.length > 0) {
        const chunk = chunks.shift();
        if (chunk) yield chunk;
      }
    } finally {
      this.off('output', onOutput);
    }
  }

  parseOutput(raw: string): CliResponse {
    return parseWorkerOutput(raw, this.cliType, this.getName());
  }

  async terminate(graceful = true): Promise<void> {
    if (this.running) {
      await this.gateway.terminate(this.instanceId, graceful);
    }
    this.running = false;
    this.spawned = false;
    this.pid = null;
    this.outputBuffer = '';
    this.gateway.unregisterInstance(this.instanceId);
  }

  interrupt(): InterruptResult {
    if (!this.running || !this.pid) {
      return { status: 'already-idle', reason: 'No running process to interrupt' };
    }
    this.gateway.sendSignal(this.instanceId, 'SIGINT');
    return { status: 'accepted' };
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  getDeferredToolUse(): DeferredToolUse | null {
    return this.deferredToolUse;
  }

  clearDeferredToolUse(): void {
    this.deferredToolUse = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  getPid(): number | null {
    return this.pid;
  }

  getConfig(): { command: string; args: string[]; cwd?: string; timeout?: number; env?: Record<string, string> } {
    return {
      command: this.command(),
      args: [],
      cwd: this.options.workingDirectory,
      timeout: this.options.timeout,
      env: this.options.env,
    };
  }

  getSpawnMode(): CliSpawnMode {
    return this.spawnMode;
  }

  getRuntimeCapabilities(): AdapterRuntimeCapabilities {
    return {
      supportsResume: this.cliType === 'claude',
      supportsForkSession: this.cliType === 'claude',
      supportsNativeCompaction: false,
      supportsPermissionPrompts: this.cliType === 'claude',
      supportsDeferPermission: this.cliType === 'claude' && Boolean(this.options.permissionHookPath && !this.options.yoloMode),
      selfManagedAutoCompaction: this.cliType === 'claude',
    };
  }

  setStreamIdleTimeoutMs(): void {
    // The timeout is captured when the worker process is spawned.
  }

  noteActivity(): void {
    this.emit('heartbeat');
  }

  private async spawnWorkerProcess(args: string[], opts: { closeStdin?: boolean } = {}): Promise<{ pid: number }> {
    this.outputBuffer = '';
    return this.gateway.spawnInstance({
      instanceId: this.instanceId,
      command: this.command(),
      args,
      cwd: this.options.workingDirectory ?? process.cwd(),
      env: this.options.env ?? {},
      streamIdleTimeoutMs: this.options.timeout,
      closeStdin: opts.closeStdin,
    });
  }

  private command(): string {
    return this.cliType === 'claude' ? 'claude' : 'gemini';
  }

  private buildArgs(message: CliMessage): string[] {
    return buildWorkerArgs(this.cliType, this.options, this.sessionId, message, {
      includeGeminiRtkAwareness: !this.geminiRtkAwarenessSent,
    });
  }

  private async formatClaudeInput(message: string, attachments?: FileAttachment[]): Promise<string> {
    return formatClaudeWorkerInput(message, attachments, this.sessionId, this.options.workingDirectory);
  }

  private handleStdout(chunk: string): void {
    this.outputBuffer += chunk;
    const combined = this.stdoutLineBuffer + chunk;
    const parts = combined.split('\n');
    this.stdoutLineBuffer = parts.pop() ?? '';
    const lines = parts.filter((line) => line.trim());
    for (const line of lines) {
      this.emitOutputFromLine(line);
    }
  }

  private emitOutputFromLine(line: string): void {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (this.cliType === 'claude') {
        this.emitClaudeOutput(event);
        return;
      }
      this.emitGeminiOutput(event, line);
    } catch {
      if (this.cliType === 'gemini' && line.trim() && !line.startsWith('{') && !line.includes('YOLO mode')) {
        this.emit('output', {
          id: generateId(),
          timestamp: Date.now(),
          type: 'assistant',
          content: line,
        } as OutputMessage);
      }
    }
  }

  private emitClaudeOutput(event: Record<string, unknown>): void {
    switch (event['type']) {
      case 'assistant':
        this.emitClaudeAssistant(event);
        return;
      case 'system':
        this.emitClaudeSystem(event);
        return;
      case 'tool_use':
        this.emit('output', {
          id: generateId(),
          timestamp: Date.now(),
          type: 'tool_use',
          content: `Using tool: ${String((event['tool'] as { name?: unknown } | undefined)?.name ?? 'unknown')}`,
          metadata: event,
        } as OutputMessage);
        return;
      case 'tool_result':
        this.emit('output', {
          id: generateId(),
          timestamp: Date.now(),
          type: 'tool_result',
          content: typeof event['content'] === 'string' ? event['content'] : JSON.stringify(event),
          metadata: event,
        } as OutputMessage);
        return;
      case 'input_required':
      case 'elicitation':
        this.emit('input_required', {
          id: typeof event['id'] === 'string' ? event['id'] : generateId(),
          prompt: typeof event['prompt'] === 'string' ? event['prompt'] : 'Input required',
          timestamp: typeof event['timestamp'] === 'number' ? event['timestamp'] : Date.now(),
          metadata: typeof event['metadata'] === 'object' && event['metadata'] !== null
            ? event['metadata'] as Record<string, unknown>
            : { raw: event },
        });
        return;
      case 'result':
        this.emitClaudeResult(event);
    }
  }

  private emitClaudeAssistant(event: Record<string, unknown>): void {
    const message = event['message'] as { content?: Record<string, unknown>[]; usage?: Record<string, number> } | undefined;
    for (const block of message?.content ?? []) {
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        this.emit('output', {
          id: generateId(),
          timestamp: Date.now(),
          type: 'assistant',
          content: block['text'],
        } as OutputMessage);
      } else if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
        this.emit('output', {
          id: generateId(),
          timestamp: Date.now(),
          type: 'tool_use',
          content: `Using tool: ${block['name']}`,
          metadata: block,
        } as OutputMessage);
      }
    }
    if (message?.usage) {
      this.emitClaudeContextFromUsage(message.usage);
    }
  }

  private emitClaudeSystem(event: Record<string, unknown>): void {
    this.updateSessionId(event);
    const usage = event['usage'];
    if (event['subtype'] === 'context_usage' && this.isRecord(usage)) {
      this.emitClaudeContextFromUsage(usage as Record<string, number>);
    }
    if (typeof event['content'] === 'string' && event['content'].trim()) {
      this.emit('output', {
        id: generateId(),
        timestamp: typeof event['timestamp'] === 'number' ? event['timestamp'] : Date.now(),
        type: 'system',
        content: event['content'],
      } as OutputMessage);
    }
  }

  private emitClaudeResult(event: Record<string, unknown>): void {
    this.updateSessionId(event);
    const modelUsage = event['modelUsage'];
    if (this.isRecord(modelUsage)) {
      const firstModel = Object.values(modelUsage)[0];
      if (this.isRecord(firstModel) && typeof firstModel['contextWindow'] === 'number') {
        this.lastKnownContextWindow = Math.max(firstModel['contextWindow'], this.lastKnownContextWindow);
      }
    }
    if (this.isRecord(event['usage'])) {
      this.emitClaudeContextFromUsage(event['usage'] as Record<string, number>);
    } else if (this.isRecord(modelUsage)) {
      const firstModel = Object.values(modelUsage)[0];
      if (this.isRecord(firstModel)) {
        const used = Number(firstModel['inputTokens'] ?? 0) + Number(firstModel['outputTokens'] ?? 0);
        if (used > 0) this.emitContext({ used, total: this.lastKnownContextWindow });
      }
    }
    if (typeof event['total_cost_usd'] === 'number') {
      this.emit('cost', { costEstimate: event['total_cost_usd'] });
    }
    if (event['stop_reason'] === 'tool_deferred' && this.isRecord(event['deferred_tool_use'])) {
      const deferred = event['deferred_tool_use'] as Record<string, unknown>;
      this.emitDeferredPermission(event, deferred);
    }
    this.emit('status', 'idle' as InstanceStatus);
  }

  private emitDeferredPermission(event: Record<string, unknown>, deferred: Record<string, unknown>): void {
    const toolName = typeof deferred['name'] === 'string' ? deferred['name'] : 'unknown';
    const toolUseId = typeof deferred['id'] === 'string' ? deferred['id'] : generateId();
    const toolInput = this.isRecord(deferred['input']) ? deferred['input'] as Record<string, unknown> : {};
    this.deferredToolUse = {
      toolName,
      toolInput,
      toolUseId,
      sessionId: typeof event['session_id'] === 'string' ? event['session_id'] : this.sessionId ?? '',
      deferredAt: Date.now(),
    };
    const command = toolName === 'Bash' && typeof toolInput['command'] === 'string'
      ? `Bash: \`${toolInput['command']}\``
      : toolName;
    this.emit('status', 'waiting_for_permission' as InstanceStatus);
    this.emit('input_required', {
      id: generateId(),
      prompt: `Permission required: Claude wants to run ${command}`,
      timestamp: Date.now(),
      metadata: {
        type: 'deferred_permission',
        tool_name: toolName,
        tool_input: toolInput,
        tool_use_id: toolUseId,
        session_id: typeof event['session_id'] === 'string' ? event['session_id'] : this.sessionId,
      },
    });
  }

  private emitGeminiOutput(event: Record<string, unknown>, raw: string): void {
    let content = '';
    if (event['type'] === 'message' && event['role'] === 'assistant' && typeof event['content'] === 'string') {
      content = event['content'];
    } else if (event['type'] === 'text' && typeof event['text'] === 'string') {
      content = event['text'];
    }
    if (content) {
      this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: 'assistant',
        content,
        metadata: { raw },
      } as OutputMessage);
    }
  }

  private handleStderr(chunk: string): void {
    const trimmed = chunk.trim();
    if (!trimmed) return;
    this.emit('stderr', trimmed);
    this.emit('output', {
      id: generateId(),
      timestamp: Date.now(),
      type: 'error',
      content: trimmed.slice(0, 2000),
    } as OutputMessage);
    const looksLikeError = /error|fatal|failed|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|Exception/i.test(trimmed);
    if (this.cliType === 'gemini' && looksLikeError) {
      this.emit('error', new Error(trimmed));
    }
  }

  private handleExit(code: number | null, signal: string | null): void {
    const wasRunning = this.running;
    this.running = false;
    this.pid = null;
    if (this.stdoutLineBuffer.trim()) {
      this.emitOutputFromLine(this.stdoutLineBuffer);
      this.stdoutLineBuffer = '';
    }
    if (this.outputBuffer.trim()) {
      const response = this.parseOutput(this.outputBuffer);
      if (this.cliType === 'gemini' && response.usage) {
        const inputTokens = response.usage.inputTokens ?? 0;
        const outputTokens = response.usage.outputTokens ?? 0;
        const turnTokens = inputTokens + outputTokens || response.usage.totalTokens || 0;
        this.cumulativeTokensUsed += turnTokens;
        this.cumulativeCostUsd += computeTokenCost(this.options.model, { inputTokens, outputTokens });
        const contextWindow = this.getCapabilities().contextWindow;
        this.emit('context', {
          used: Math.min(turnTokens, contextWindow),
          total: contextWindow,
          percentage: contextWindow > 0 ? Math.min((turnTokens / contextWindow) * 100, 100) : 0,
          cumulativeTokens: this.cumulativeTokensUsed,
          costEstimate: this.cumulativeCostUsd,
          inputTokens,
          outputTokens,
        } as ContextUsage);
      }
      this.emit('complete', response);
    } else if (wasRunning && code !== 0) {
      this.emit('error', new Error(`${this.getName()} exited with code ${code}`));
    }
    this.emit('exit', code, signal);
    if (this.spawned) this.emit('status', 'idle' as InstanceStatus);
  }

  private updateSessionId(event: Record<string, unknown>): void {
    if (typeof event['session_id'] === 'string') {
      this.sessionId = event['session_id'];
    }
  }

  private emitClaudeContextFromUsage(usage: Record<string, number>): void {
    const inputTokens = Number(usage['input_tokens'] ?? 0)
      + Number(usage['cache_creation_input_tokens'] ?? 0)
      + Number(usage['cache_read_input_tokens'] ?? 0);
    const outputTokens = Number(usage['output_tokens'] ?? 0);
    this.emitContext({
      used: inputTokens + outputTokens,
      total: this.lastKnownContextWindow,
      inputTokens,
      outputTokens,
    });
  }

  private emitContext(usage: { used: number; total: number; inputTokens?: number; outputTokens?: number }): void {
    const total = usage.total;
    this.emit('context', {
      used: usage.used,
      total,
      percentage: total > 0 ? Math.min((usage.used / total) * 100, 100) : 0,
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    } as ContextUsage);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
