/**
 * ScriptedCliAdapter — a deterministic, in-process CLI adapter for tests
 * (backlog A6: "scripted mock adapter emitting typed receipts").
 *
 * The existing {@link MockCliHarness} mocks at the child-process *stream* level
 * (stdin triggers → scripted stdout) and is great for testing a real adapter's
 * parse path. ScriptedCliAdapter sits one layer higher: it is a full
 * {@link BaseCliAdapter} subclass that, instead of spawning a process, replays a
 * scripted sequence of the canonical adapter lifecycle events
 * ({@link CliAdapterEvents}: spawned / output / tool_use / tool_result / status /
 * error / complete / exit). That lets a test drive any *consumer* of adapter
 * events (the runtime-event bridge, instance managers, loop coordinator) with a
 * precise, reproducible event stream — no real CLI, no flakiness, and no
 * `sleep()` timing guesses (pair it with the {@link awaitReceipt}/
 * {@link drainRuntime} helpers in `./runtime-receipts`).
 *
 * It is test-only infrastructure (lives under `__tests__/`, never bundled into
 * the production app and never registered in the adapter factory).
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

/** One scripted lifecycle step. `delayMs` (default 0) is awaited before emit. */
export type ScriptStep =
  | { kind: 'output'; content: string; delayMs?: number }
  | { kind: 'tool_use'; toolCall: CliToolCall; delayMs?: number }
  | { kind: 'tool_result'; toolCall: CliToolCall; delayMs?: number }
  | { kind: 'status'; status: string; delayMs?: number }
  | { kind: 'error'; error: Error | string; delayMs?: number }
  | { kind: 'complete'; response?: Partial<CliResponse>; usage?: CliUsage; delayMs?: number }
  | { kind: 'exit'; code?: number | null; signal?: string | null; delayMs?: number };

/** A single turn = the ordered steps replayed for one sendMessage/sendInput. */
export type ScriptedTurn = ScriptStep[];

export interface ScriptedCliAdapterOptions {
  name?: string;
  capabilities?: Partial<CliCapabilities>;
  status?: Partial<CliStatus>;
  /** Turns replayed in order; one per sendMessage/sendInput call. */
  turns?: ScriptedTurn[];
}

const DEFAULT_CAPABILITIES: CliCapabilities = {
  streaming: true,
  toolUse: true,
  fileAccess: true,
  shellExecution: true,
  multiTurn: true,
  vision: false,
  codeExecution: true,
  contextWindow: 200_000,
  outputFormats: ['text'],
};

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

let pidCounter = 1000;

export class ScriptedCliAdapter extends BaseCliAdapter {
  private readonly name: string;
  private readonly capabilities: CliCapabilities;
  private readonly statusOverride: Partial<CliStatus>;
  private readonly turns: ScriptedTurn[];
  private turnIndex = 0;
  private responseSeq = 0;

  constructor(options: ScriptedCliAdapterOptions = {}, config: Partial<CliAdapterConfig> = {}) {
    super({ command: 'scripted-cli', ...config });
    this.name = options.name ?? 'Scripted';
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
    this.statusOverride = options.status ?? {};
    this.turns = options.turns ? options.turns.map((t) => [...t]) : [];
  }

  // ---- Script management -------------------------------------------------

  /** Append a turn to replay on a later sendMessage/sendInput. Chainable. */
  enqueueTurn(turn: ScriptedTurn): this {
    this.turns.push([...turn]);
    return this;
  }

  /** Number of turns not yet replayed. */
  pendingTurns(): number {
    return Math.max(0, this.turns.length - this.turnIndex);
  }

  // ---- BaseCliAdapter contract -------------------------------------------

  getName(): string {
    return this.name;
  }

  getCapabilities(): CliCapabilities {
    return this.capabilities;
  }

  async checkStatus(): Promise<CliStatus> {
    return { available: true, version: '0.0.0-scripted', authenticated: true, ...this.statusOverride };
  }

  /** Replay the next scripted turn, resolving with its (synthesized) response. */
  async sendMessage(_message: CliMessage): Promise<CliResponse> {
    return this.replayNextTurn();
  }

  /** Stream the next turn's `output` steps; still emits the full event sequence. */
  async *sendMessageStream(_message: CliMessage): AsyncIterable<string> {
    const turn = this.takeNextTurn();
    this.emit('spawned', pidCounter++);
    for (const step of turn) {
      await sleep(step.delayMs ?? 0);
      this.applyStep(step, () => {});
      if (step.kind === 'output') yield step.content;
    }
  }

  /**
   * Scripted adapters do not parse raw provider output; the scripted steps ARE
   * the parsed events. Returned for contract completeness.
   */
  parseOutput(raw: string): CliResponse {
    return { id: `scripted-${++this.responseSeq}`, content: raw, role: 'assistant', raw };
  }

  protected buildArgs(_message: CliMessage): string[] {
    return [];
  }

  /** Public user-input path: replay the next turn (fire-and-forget emission). */
  protected async sendInputImpl(_message: string, _attachments?: unknown): Promise<void> {
    await this.replayNextTurn();
  }

  // ---- Internal ----------------------------------------------------------

  private takeNextTurn(): ScriptedTurn {
    const turn = this.turns[this.turnIndex];
    if (!turn) {
      // No script configured for this call — emit a trivial empty completion so
      // consumers still see a well-formed lifecycle.
      return [{ kind: 'complete' }, { kind: 'exit', code: 0 }];
    }
    this.turnIndex += 1;
    return turn;
  }

  private async replayNextTurn(): Promise<CliResponse> {
    const turn = this.takeNextTurn();
    this.emit('spawned', pidCounter++);

    let content = '';
    const toolCalls: CliToolCall[] = [];
    let response: CliResponse | null = null;

    for (const step of turn) {
      await sleep(step.delayMs ?? 0);
      this.applyStep(step, (chunk) => (content += chunk), (tc) => toolCalls.push(tc));
      if (step.kind === 'complete') {
        response = {
          id: `scripted-${++this.responseSeq}`,
          content: step.response?.content ?? content,
          role: 'assistant',
          toolCalls: step.response?.toolCalls ?? (toolCalls.length ? toolCalls : undefined),
          usage: step.usage ?? step.response?.usage,
          ...step.response,
        };
        this.emit('complete', response);
      }
    }

    // If the script never emitted an explicit 'complete', synthesize one so the
    // caller's Promise resolves with a well-formed response.
    if (!response) {
      response = {
        id: `scripted-${++this.responseSeq}`,
        content,
        role: 'assistant',
        toolCalls: toolCalls.length ? toolCalls : undefined,
      };
      this.emit('complete', response);
    }
    return response;
  }

  /** Emit the event(s) for one step. */
  private applyStep(
    step: ScriptStep,
    onOutput: (chunk: string) => void,
    onToolCall?: (tc: CliToolCall) => void,
  ): void {
    switch (step.kind) {
      case 'output':
        onOutput(step.content);
        this.emit('output', step.content);
        break;
      case 'tool_use':
        onToolCall?.(step.toolCall);
        this.emit('tool_use', step.toolCall);
        break;
      case 'tool_result':
        this.emit('tool_result', step.toolCall);
        break;
      case 'status':
        this.emit('status', step.status);
        break;
      case 'error':
        this.emit('error', step.error instanceof Error ? step.error : new Error(step.error));
        break;
      case 'complete':
        // The response object is assembled by the caller (replayNextTurn) so it
        // can fold in accumulated content; emit it there. Nothing to do here.
        break;
      case 'exit':
        this.emit('exit', step.code ?? 0, step.signal ?? null);
        break;
    }
  }
}
