/**
 * ScriptedCliAdapter — a deterministic, in-memory CLI adapter for tests.
 *
 * Unlike `MockCliHarness` (which fakes a child *process* at the stdin/stdout
 * level), this is a full `BaseCliAdapter` that never spawns anything. You script
 * a turn as a list of typed steps; calling `sendMessage`/`sendMessageStream`
 * plays them in order, emitting the same event vocabulary a real adapter uses
 * (`output` / `tool_use` / `tool_result` / `status` / `error` / `complete` /
 * `spawned` / `exit`) and mirroring each of its OWN scripted emissions into a
 * {@link ReceiptBus}. (Direct `emit()` calls made by external code are not
 * auto-recorded — only the steps the adapter plays.)
 *
 * This gives downstream consumers (coordinators, loop supervisors, instance
 * lifecycle) a provider-neutral, deterministic adapter to test against. Tests
 * synchronise on receipts / turn-completion instead of sleeping. It is a test
 * double, not a member of the production `CliAdapter` union, so consumers typed
 * against that union take it via a cast.
 *
 * It extends `BaseCliAdapter`; the lifecycle methods (`getPid`/`isRunning`/
 * `interrupt`/`terminate`) are overridden to model a synthetic process that is
 * alive from first spawn until `terminate()`.
 */

import type { FileAttachment } from '../../../shared/types/instance.types';
import type { ContextUsage } from '../../../shared/types/instance.types';
import { estimateTokens } from '../../../shared/utils/token-estimate';
import { BaseCliAdapter } from './base-cli-adapter';
import type {
  AdapterRuntimeCapabilities,
  CliCapabilities,
  CliMessage,
  CliResponse,
  CliStatus,
  CliToolCall,
  TurnInterruptCompletion,
  CliUsage,
  InterruptResult,
} from './base-cli-adapter.types';
import { ReceiptBus } from './receipt-bus';

/** A single scripted step the adapter plays during a turn. */
export type ScriptStep =
  | { kind: 'output'; content: string; delayMs?: number }
  | { kind: 'tool_use'; toolCall: CliToolCall; delayMs?: number }
  | { kind: 'tool_result'; toolCall: CliToolCall; delayMs?: number }
  | { kind: 'status'; status: string; delayMs?: number }
  | { kind: 'context'; usage: ContextUsage; delayMs?: number }
  | { kind: 'error'; error: string; delayMs?: number; fail?: boolean }
  | { kind: 'complete'; response?: Partial<CliResponse>; delayMs?: number };

/**
 * A scripted turn. Either a fixed list of steps, or a function of the incoming
 * message (so a turn can echo the prompt, branch on content, etc.).
 */
export type ScriptedTurn = ScriptStep[] | ((message: CliMessage) => ScriptStep[]);

/**
 * Phase 0 fault-injection modes for interrupt/terminate/stdin behaviour.
 *
 * - `normal`            — `interrupt()` returns `accepted` with NO completion
 *                         (the default; tests must drive termination). This is
 *                         the "accepted-without-completion" case (A2).
 * - `accepted-no-completion` — explicit alias of `normal`, for readable tests.
 * - `completion-settles`— `interrupt()` returns `accepted` with a completion
 *                         promise that resolves to `interrupted`.
 * - `completion-never-settles` — `interrupt()` returns accepted with a promise
 *                         that never resolves (interrupt-completion deadline / A3).
 * - `ignores-sigterm`   — `terminate()` is a no-op; the adapter never exits.
 * - `exits-after-interrupt` — `interrupt()` accepted, then the synthetic process
 *                         emits `exit` on the next microtask (CLI that dies on SIGINT).
 * - `never-exits-after-interrupt` — `interrupt()` accepted but the process never
 *                         exits and `terminate()` is a no-op (wedged; force-abort path).
 * - `wrong-turn-id-interrupt` — `interrupt()` accepted with a mismatched `turnId`
 *                         (Codex abort-before-turnId race, §6.1).
 * - `stdin-drain-never-fires` — `sendInput()` records the input but never resolves
 *                         (stdin drain hang / D9).
 *
 * Out of this adapter's scope (modeled by other doubles/specs, not here):
 *   resume-not-found → resume-error-classifier.spec + session-recovery.spec;
 *   never-releases-mutex → session-mutex.spec;
 *   app-server-init-timeout / spawn-never-emits → base-cli-adapter watchdog +
 *   codex adapter specs; stale-adapter-send-after-respawn →
 *   interrupt-respawn-handler.spec generation-fence tests.
 */
export type InterruptFaultMode =
  | 'normal'
  | 'accepted-no-completion'
  | 'completion-settles'
  | 'completion-never-settles'
  | 'ignores-sigterm'
  | 'exits-after-interrupt'
  | 'never-exits-after-interrupt'
  | 'wrong-turn-id-interrupt'
  | 'stdin-drain-never-fires';

export interface ScriptedAdapterOptions {
  /** Reuse an external bus (e.g. shared across adapters); one is created if omitted. */
  receiptBus?: ReceiptBus;
  /** Capability flags advertised by `getCapabilities()`. */
  capabilities?: Partial<CliCapabilities>;
  /** Runtime capabilities advertised by `getRuntimeCapabilities()`. */
  runtimeCapabilities?: Partial<AdapterRuntimeCapabilities>;
  /** Synthetic pid reported by `spawned`/`getPid()`-style consumers. */
  pid?: number;
  /** Turns to enqueue up front. */
  turns?: ScriptedTurn[];
  /** Played when the turn queue is empty (defaults to a single empty completion). */
  defaultTurn?: ScriptedTurn;
  /**
   * Controls how interrupt() and terminate() behave (Phase 0 fault injection).
   * Default: 'normal'.
   */
  interruptFaultMode?: InterruptFaultMode;
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

function delay(ms: number | undefined, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortError(signal));
  }
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(abortError(signal));
    }, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'Scripted turn aborted'));
}

export class ScriptedCliAdapter extends BaseCliAdapter {
  readonly receipts: ReceiptBus;

  private readonly capabilities: CliCapabilities;
  private readonly runtimeCaps: AdapterRuntimeCapabilities;
  private readonly syntheticPid: number;
  private readonly turnQueue: ScriptedTurn[] = [];
  private defaultTurn: ScriptedTurn;

  private idCounter = 0;
  private spawnedEmitted = false;
  private terminated = false;
  private readonly interruptFaultMode: InterruptFaultMode;
  /** Promise tracking the currently-playing turn, awaited by `drain()`. */
  private inflight: Promise<void> = Promise.resolve();
  private activeTurnAbort: AbortController | null = null;
  /** Records inputs delivered via `sendInput`, for assertions. */
  readonly inputs: { message: string; attachments?: FileAttachment[] }[] = [];

  constructor(options: ScriptedAdapterOptions = {}) {
    super({ command: 'scripted-mock', sessionPersistence: true, persistLargeOutputs: false });
    this.receipts = options.receiptBus ?? new ReceiptBus();
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
    this.runtimeCaps = {
      supportsResume: false,
      supportsForkSession: false,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
      selfManagedAutoCompaction: false,
      ...options.runtimeCapabilities,
    };
    this.syntheticPid = options.pid ?? 424242;
    this.interruptFaultMode = options.interruptFaultMode ?? 'normal';
    this.defaultTurn = options.defaultTurn ?? [{ kind: 'complete' }];
    if (options.turns) this.turnQueue.push(...options.turns);
  }

  // ---- scripting API -------------------------------------------------------

  /** Enqueue a turn to be played by the next `sendMessage`/`sendMessageStream`. */
  enqueueTurn(turn: ScriptedTurn): this {
    this.turnQueue.push(turn);
    return this;
  }

  /** Convenience: enqueue a turn that emits one text chunk then completes. */
  enqueueResponse(content: string, usage?: CliUsage): this {
    return this.enqueueTurn([
      { kind: 'output', content },
      { kind: 'complete', response: { content, usage } },
    ]);
  }

  /** Set the turn played when the queue is empty. */
  setDefaultTurn(turn: ScriptedTurn): this {
    this.defaultTurn = turn;
    return this;
  }

  /**
   * Resolve once the in-flight turn has finished playing.
   *
   * - For `sendMessage`, this resolves when the turn completes.
   * - For `sendMessageStream`, `inflight` is armed eagerly when the generator is
   *   created and resolves when iteration completes. Because a generator only
   *   advances as the consumer pulls, `drain()` must be awaited from a DIFFERENT
   *   task than the one iterating (awaiting it from the consuming task itself
   *   would deadlock — the generator can't advance while you block on drain).
   *   For streaming, the simplest sync primitive is usually
   *   `awaitReceipt(adapter.receipts, byType('complete'))`.
   */
  drain(): Promise<void> {
    return this.inflight;
  }

  /** Abort the currently-playing scripted turn at its next delay boundary. */
  abortActiveTurn(reason = 'Scripted turn aborted'): boolean {
    const controller = this.activeTurnAbort;
    if (!controller || controller.signal.aborted) {
      return false;
    }
    const error = new Error(reason);
    this.fire('error', error);
    controller.abort(error);
    return true;
  }

  // ---- BaseCliAdapter contract ---------------------------------------------

  getName(): string {
    return 'scripted';
  }

  getCapabilities(): CliCapabilities {
    return { ...this.capabilities };
  }

  override getRuntimeCapabilities(): AdapterRuntimeCapabilities {
    return { ...this.runtimeCaps };
  }

  // The base lifecycle methods key off `this.process`, which the scripted
  // adapter never sets. Model the synthetic "process" as alive from first
  // spawn until terminate so getPid/isRunning/interrupt are mutually coherent.

  override getPid(): number | null {
    return this.spawnedEmitted && !this.terminated ? this.syntheticPid : null;
  }

  override isRunning(): boolean {
    return this.spawnedEmitted && !this.terminated;
  }

  override interrupt(): InterruptResult {
    if (!this.isRunning()) {
      return { status: 'already-idle', reason: 'No running scripted turn to interrupt' };
    }
    switch (this.interruptFaultMode) {
      case 'completion-settles': {
        const completion = Promise.resolve<TurnInterruptCompletion>({
          status: 'interrupted',
          turnId: undefined,
        });
        return { status: 'accepted', completion };
      }
      case 'completion-never-settles': {
        // Never-settling completion: used to test the interrupt-completion deadline (A3).
        const completion = new Promise<TurnInterruptCompletion>(() => undefined);
        return { status: 'accepted', completion };
      }
      case 'exits-after-interrupt': {
        // Model a CLI that exits shortly after receiving SIGINT.
        queueMicrotask(() => {
          if (this.spawnedEmitted && !this.terminated) {
            this.terminated = true;
            this.receipts.record('exit', { code: 0, signal: 'SIGINT' });
            this.emit('exit', 0, 'SIGINT');
          }
        });
        return { status: 'accepted' };
      }
      case 'wrong-turn-id-interrupt':
        // Codex abort-before-turnId race (§6.1): accepted but with a turnId the
        // caller never issued.
        return { status: 'accepted', turnId: 'mismatched-turn-id' };
      default:
        // 'normal' / 'accepted-no-completion' / 'never-exits-after-interrupt' /
        // 'ignores-sigterm' / 'stdin-drain-never-fires': accepted, no completion.
        return { status: 'accepted' };
    }
  }

  override async terminate(graceful = true): Promise<void> {
    if (
      this.interruptFaultMode === 'ignores-sigterm' ||
      this.interruptFaultMode === 'never-exits-after-interrupt'
    ) {
      // Fault injection: adapter ignores SIGTERM / stays wedged — never emits exit.
      return;
    }
    await super.terminate(graceful);
    if (this.spawnedEmitted && !this.terminated) {
      this.terminated = true;
      this.receipts.record('exit', { code: 0, signal: null });
      this.emit('exit', 0, null);
    }
  }

  async checkStatus(): Promise<CliStatus> {
    return { available: true, version: 'scripted', authenticated: true };
  }

  async sendMessage(message: CliMessage): Promise<CliResponse> {
    this.markSpawned();
    const steps = this.takeTurn(message);
    let result: CliResponse | undefined;
    const abortController = new AbortController();
    this.activeTurnAbort = abortController;
    this.inflight = (async () => {
      try {
        result = await this.playSteps(steps, abortController.signal);
      } finally {
        if (this.activeTurnAbort === abortController) {
          this.activeTurnAbort = null;
        }
      }
    })();
    await this.inflight;
    // playSteps always returns a CliResponse (synthesises one if no `complete`).
    return result as CliResponse;
  }

  sendMessageStream(message: CliMessage): AsyncIterable<string> {
    // Arm `inflight` + emit `spawned` EAGERLY (when the generator is created),
    // not lazily on first pull, so `drain()` reflects the streaming turn and
    // `spawned` is deterministic.
    this.markSpawned();
    const steps = this.takeTurn(message);
    const abortController = new AbortController();
    this.activeTurnAbort = abortController;
    let resolveInflight!: () => void;
    this.inflight = new Promise<void>((resolve) => {
      resolveInflight = resolve;
    });
    return this.playStream(steps, resolveInflight, abortController);
  }

  /** Inner generator for `sendMessageStream`; `done` resolves the `inflight` latch. */
  private async *playStream(
    steps: ScriptStep[],
    done: () => void,
    abortController: AbortController,
  ): AsyncGenerator<string> {
    const outputs: string[] = [];
    let completed = false;
    try {
      for (const step of steps) {
        await delay(step.delayMs, abortController.signal);
        switch (step.kind) {
          case 'output':
            this.fireOutput(step.content);
            outputs.push(step.content);
            yield step.content;
            break;
          case 'tool_use':
            this.fire('tool_use', step.toolCall);
            break;
          case 'tool_result':
            this.fire('tool_result', step.toolCall);
            break;
          case 'status':
            this.fire('status', step.status);
            break;
          case 'context':
            this.fireContext(step.usage);
            break;
          case 'error':
            this.fire('error', step.error);
            if (step.fail) throw new Error(step.error);
            break;
          case 'complete':
            this.fireComplete(this.buildResponse(step.response, outputs));
            completed = true;
            break;
        }
      }
      if (!completed) this.fireComplete(this.buildResponse(undefined, outputs));
    } finally {
      // Always resolve so `drain()` reflects turn completion even when the
      // consumer breaks early or the turn throws.
      if (this.activeTurnAbort === abortController) {
        this.activeTurnAbort = null;
      }
      done();
    }
  }

  parseOutput(raw: string): CliResponse {
    return { id: this.nextId(), content: raw, role: 'assistant' };
  }

  protected buildArgs(): string[] {
    // No real process is spawned; args are irrelevant for the scripted adapter.
    return [];
  }

  protected async sendInputImpl(message: string, attachments?: FileAttachment[]): Promise<void> {
    this.inputs.push({ message, attachments });
    if (this.interruptFaultMode === 'stdin-drain-never-fires') {
      // Fault injection (D9): the stdin write never drains. Used to test that
      // callers bound their sendInput await rather than hanging forever.
      await new Promise<void>(() => undefined);
    }
  }

  // ---- internals -----------------------------------------------------------

  private markSpawned(): void {
    this.responseStartedAt = Date.now();
    if (!this.spawnedEmitted) {
      this.spawnedEmitted = true;
      this.fire('spawned', this.syntheticPid);
    }
  }

  private takeTurn(message: CliMessage): ScriptStep[] {
    const turn = this.turnQueue.shift() ?? this.defaultTurn;
    return typeof turn === 'function' ? turn(message) : turn;
  }

  private async playSteps(steps: ScriptStep[], signal: AbortSignal): Promise<CliResponse> {
    const outputs: string[] = [];
    let response: CliResponse | undefined;
    for (const step of steps) {
      await delay(step.delayMs, signal);
      switch (step.kind) {
        case 'output':
          this.fireOutput(step.content);
          outputs.push(step.content);
          break;
        case 'tool_use':
          this.fire('tool_use', step.toolCall);
          break;
        case 'tool_result':
          this.fire('tool_result', step.toolCall);
          break;
        case 'status':
          this.fire('status', step.status);
          break;
        case 'context':
          this.fireContext(step.usage);
          break;
        case 'error':
          this.fire('error', step.error);
          if (step.fail) throw new Error(step.error);
          break;
        case 'complete':
          response = this.buildResponse(step.response, outputs);
          this.fireComplete(response);
          break;
      }
    }
    if (!response) {
      response = this.buildResponse(undefined, outputs);
      this.fireComplete(response);
    }
    return response;
  }

  private buildResponse(partial: Partial<CliResponse> | undefined, outputs: string[]): CliResponse {
    const content = partial?.content ?? outputs.join('');
    return {
      id: partial?.id ?? this.nextId(),
      role: 'assistant',
      content,
      ...(partial?.toolCalls ? { toolCalls: partial.toolCalls } : {}),
      usage: partial?.usage ?? defaultUsage(content),
      ...(partial?.metadata ? { metadata: partial.metadata } : {}),
      ...(partial?.degradedReason ? { degradedReason: partial.degradedReason } : {}),
    };
  }

  private nextId(): string {
    this.idCounter += 1;
    return `scripted-${this.idCounter}`;
  }

  // Record-then-emit so the ReceiptBus mirrors exactly what listeners receive.
  private fireOutput(content: string): void {
    this.receipts.record('output', content);
    this.emit('output', content);
  }

  private fireComplete(response: CliResponse): void {
    this.receipts.record('complete', response);
    this.emit('complete', response);
  }

  private fireContext(usage: ContextUsage): void {
    this.receipts.record('context', usage);
    this.emit('context', usage);
  }

  private fire(
    event: 'tool_use' | 'tool_result' | 'status' | 'error' | 'spawned',
    payload: CliToolCall | string | number | Error,
  ): void {
    // The payload type lines up with the event by construction at every call site.
    this.receipts.record(event, payload as never);
    // Node's EventEmitter throws if an 'error' event is emitted with no
    // listener. The receipt above is the primary assertion channel, so only
    // emit 'error' when someone is actually listening — real consumers attach a
    // listener, tests that only inspect receipts don't have to.
    if (event === 'error' && this.listenerCount('error') === 0) return;
    this.emit(event, payload);
  }
}

/** A small, deterministic usage estimate (~4 chars/token) for scripted turns. */
function defaultUsage(content: string): CliUsage {
  const outputTokens = Math.max(1, estimateTokens(content));
  return { inputTokens: 0, outputTokens, totalTokens: outputTokens };
}
