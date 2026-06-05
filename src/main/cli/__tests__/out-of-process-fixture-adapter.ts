/**
 * OutOfProcessFixtureAdapter — a minimal but REAL {@link BaseCliAdapter} that
 * spawns an actual child process (the {@link cli-fixture-runner} script) and
 * drives it through the production spawn → stdout-stream → close → parseOutput →
 * complete pipeline.
 *
 * Why this exists (backlog A6, the out-of-process tail):
 *   - {@link ScriptedCliAdapter} replays canonical lifecycle events IN-PROCESS,
 *     so it exercises event *consumers* but never the base class's real
 *     subprocess machinery: `spawnProcess()`, stdout/stderr wiring, line
 *     buffering across chunk boundaries, the `close` flush, exit-code handling
 *     and the idle watchdog.
 *   - This adapter is the smallest faithful implementation of the same
 *     spawn+parse contract every real provider adapter follows, pointed at a
 *     deterministic fixture binary instead of a real CLI. It lets tests prove
 *     the real subprocess path end-to-end (and through the runtime-event bridge)
 *     without a network, a provider account, or flaky timing.
 *
 * Test-only: lives under `__tests__/`, never bundled and never registered in the
 * adapter factory.
 *
 * Fixture NDJSON schema (one JSON object per stdout line):
 *   {"type":"output","content":"..."}                         assistant text
 *   {"type":"tool_use","id","name","input":{...}}             tool call
 *   {"type":"result","usage":{input_tokens,output_tokens,
 *       cache_read_input_tokens,cache_creation_input_tokens},
 *       total_cost_usd}                                        final tally
 */

import {
  BaseCliAdapter,
  type CliAdapterConfig,
  type CliCapabilities,
  type CliMessage,
  type CliResponse,
  type CliStatus,
  type CliToolCall,
  type CliUsage,
} from '../adapters/base-cli-adapter';

const DEFAULT_CAPABILITIES: CliCapabilities = {
  streaming: true,
  toolUse: true,
  fileAccess: false,
  shellExecution: false,
  multiTurn: false,
  vision: false,
  codeExecution: false,
  contextWindow: 200_000,
  outputFormats: ['text'],
};

export interface OutOfProcessFixtureAdapterOptions {
  /** Absolute path to `cli-fixture-runner.mjs`. */
  fixtureRunnerPath: string;
  /** Absolute path to the scenario JSON the runner should replay. */
  scenarioPath: string;
  name?: string;
  capabilities?: Partial<CliCapabilities>;
}

interface FixtureLine {
  type?: string;
  content?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    total_tokens?: number;
  };
  total_cost_usd?: number;
}

export class OutOfProcessFixtureAdapter extends BaseCliAdapter {
  private readonly name: string;
  private readonly capabilities: CliCapabilities;
  private readonly fixtureRunnerPath: string;
  private readonly scenarioPath: string;
  private responseSeq = 0;
  /** Carries an incomplete trailing line between stdout chunks. */
  private streamRemainder = '';

  constructor(options: OutOfProcessFixtureAdapterOptions, config: Partial<CliAdapterConfig> = {}) {
    // The "CLI" is just node running our fixture script.
    super({ command: process.execPath, ...config });
    this.fixtureRunnerPath = options.fixtureRunnerPath;
    this.scenarioPath = options.scenarioPath;
    this.name = options.name ?? 'OutOfProcessFixture';
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  }

  getName(): string {
    return this.name;
  }

  getCapabilities(): CliCapabilities {
    return this.capabilities;
  }

  async checkStatus(): Promise<CliStatus> {
    return { available: true, version: '0.0.0-fixture', authenticated: true };
  }

  protected buildArgs(_message: CliMessage): string[] {
    return [this.fixtureRunnerPath, this.scenarioPath];
  }

  async sendMessage(_message: CliMessage): Promise<CliResponse> {
    this.outputBuffer = '';
    this.streamRemainder = '';
    const startTime = Date.now();

    return new Promise<CliResponse>((resolve, reject) => {
      let settled = false;

      const proc = this.spawnProcess(this.buildArgs(_message));
      this.process = proc;

      proc.stdout?.on('data', (chunk: Buffer) => {
        const raw = chunk.toString();
        this.outputBuffer += raw;
        this.emitStreamedLines(raw);
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          this.emit('error', new Error(text));
        }
      });

      // Mirror real adapters: surface the process exit separately from the
      // stdout `close` so consumers (instance-communication) see both signals.
      proc.on('exit', (code, signal) => {
        this.emit('exit', code, signal);
      });

      proc.on('close', (code) => {
        if (settled) return;
        settled = true;
        this.process = null;
        if (code !== 0 && !this.outputBuffer) {
          reject(new Error(`fixture CLI exited with code ${code ?? 'null'}`));
          return;
        }
        const response = this.parseOutput(this.outputBuffer);
        response.usage = { ...response.usage, duration: Date.now() - startTime };
        this.emit('complete', response);
        resolve(response);
      });

      proc.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        this.process = null;
        this.emit('error', err);
        reject(err);
      });
    });
  }

  async *sendMessageStream(message: CliMessage): AsyncIterable<string> {
    // Drive the same real subprocess, but surface output chunks as they arrive.
    const queue: string[] = [];
    let done = false;
    let failure: Error | null = null;
    let notify: (() => void) | null = null;
    const wake = (): void => {
      const n = notify;
      notify = null;
      n?.();
    };

    const onOutput = (msg: unknown): void => {
      const content = typeof msg === 'string' ? msg : (msg as { content?: string })?.content;
      if (typeof content === 'string' && content.length > 0) {
        queue.push(content);
        wake();
      }
    };
    this.on('output', onOutput);

    const finished = this.sendMessage(message)
      .catch((err: unknown) => {
        failure = err instanceof Error ? err : new Error(String(err));
      })
      .finally(() => {
        done = true;
        wake();
      });

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift() as string;
          continue;
        }
        if (done) break;
        await new Promise<void>((r) => {
          notify = r;
        });
      }
    } finally {
      this.off('output', onOutput);
      await finished;
    }

    if (failure) throw failure;
  }

  parseOutput(raw: string): CliResponse {
    let content = '';
    const toolCalls: CliToolCall[] = [];
    let usage: CliUsage | undefined;

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: FixtureLine;
      try {
        msg = JSON.parse(trimmed) as FixtureLine;
      } catch {
        continue; // tolerate non-JSON noise, exactly like the real adapters
      }

      switch (msg.type) {
        case 'output':
          if (typeof msg.content === 'string') content += msg.content;
          break;
        case 'tool_use':
          toolCalls.push({
            id: msg.id ?? `tool-${toolCalls.length + 1}`,
            name: msg.name ?? 'unknown',
            arguments: msg.input ?? {},
          });
          break;
        case 'result': {
          const u = msg.usage;
          if (u) {
            usage = {
              inputTokens: u.input_tokens,
              outputTokens: u.output_tokens,
              totalTokens:
                u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
              // Surface cache tokens separately so cost accounting can price them
              // (same contract as the real Claude adapter, A5 iter 3).
              ...(typeof u.cache_read_input_tokens === 'number'
                ? { cacheReadTokens: u.cache_read_input_tokens }
                : {}),
              ...(typeof u.cache_creation_input_tokens === 'number'
                ? { cacheWriteTokens: u.cache_creation_input_tokens }
                : {}),
            };
          }
          if (typeof msg.total_cost_usd === 'number') {
            usage = { ...usage, cost: msg.total_cost_usd };
          }
          break;
        }
        default:
          break;
      }
    }

    return {
      id: `fixture-${++this.responseSeq}`,
      content,
      role: 'assistant',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      raw,
    };
  }

  protected async sendInputImpl(_message: string, _attachments?: unknown): Promise<void> {
    await this.sendMessage({ role: 'user', content: _message });
  }

  /**
   * Emit an `output` event for each NDJSON `output` line completed by the latest
   * stdout chunk, and a `tool_use` event for each completed tool line — bridging
   * chunk boundaries via {@link streamRemainder}. This reproduces the real
   * adapters' incremental streaming (output appears before the turn closes).
   */
  private emitStreamedLines(chunk: string): void {
    const combined = this.streamRemainder + chunk;
    const parts = combined.split('\n');
    this.streamRemainder = parts.pop() ?? '';
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: FixtureLine;
      try {
        msg = JSON.parse(trimmed) as FixtureLine;
      } catch {
        continue;
      }
      if (msg.type === 'output' && typeof msg.content === 'string') {
        this.emit('output', { content: msg.content });
      } else if (msg.type === 'tool_use') {
        this.emit('tool_use', {
          id: msg.id ?? 'tool',
          name: msg.name ?? 'unknown',
          arguments: msg.input ?? {},
        } satisfies CliToolCall);
      }
    }
  }
}
