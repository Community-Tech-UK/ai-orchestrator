import type {
  InterruptResult,
  AdapterInputDispatch,
  ResumeAttemptResult,
  TurnInterruptCompletion,
} from '../base-cli-adapter';
import type { ResumeCursor } from '../../../session/session-continuity.types';
import type {
  AppServerMethod,
  AppServerNotification,
  AppServerNotificationHandler,
  AppServerRequestParams,
  AppServerResponseResult,
  InjectedDeveloperMessageItem,
  TurnCaptureState,
  UserInput,
} from './app-server-types';
import type { CodexOutputLimitState } from './codex-app-server-spawn-policy';
import { CodexAppServerRuntimeError, isEmptyInputSteerRejection } from './app-server-runtime-errors';
import { assertAdapterInputCurrent } from '../adapter-input-dispatch';

export type CodexAppServerConnectionPhase =
  | 'detached'
  | 'ready'
  | 'closing'
  | 'closed'
  | 'failed';

export type CodexAppServerTurnPhase = 'idle' | 'starting' | 'running' | 'interrupting';

/**
 * Who started the active turn. `provider` turns were started by Codex itself,
 * e.g. a thread-goal continuation, and are followed rather than requested.
 */
export type CodexAppServerTurnOrigin = 'harness' | 'provider';

export interface CodexAppServerThreadBinding {
  threadId: string;
  resumeCursor: ResumeCursor | null;
  resumeProof: ResumeAttemptResult | null;
}

export interface CodexAppServerRuntimeSnapshot {
  revision: number;
  capturedAt: number;
  connectionPhase: CodexAppServerConnectionPhase;
  turnPhase: CodexAppServerTurnPhase;
  providerSessionId: string | null;
  nativeThreadId: string | null;
  activeTurnId: string | null;
  resumeCursor: ResumeCursor | null;
  resumeProof: ResumeAttemptResult | null;
}

export interface CodexAppServerRuntimeClient {
  readonly exitPromise: Promise<void>;
  request<M extends AppServerMethod>(
    method: M,
    params: AppServerRequestParams<M>,
    timeoutMs?: number,
  ): Promise<AppServerResponseResult<M>>;
  subscribeNotifications(handler: AppServerNotificationHandler): () => void;
  close?(): Promise<void>;
  getExitError?(): Error | null;
  getPid?(): number | undefined;
  isRunning?(): boolean;
  getOutputLimitState?(): CodexOutputLimitState;
}

/** Callbacks shared by Harness-started and provider-started turn capture. */
export interface CodexTurnCaptureCallbacks {
  createState(threadId: string): TurnCaptureState;
  belongsToTurn(state: TurnCaptureState, notification: AppServerNotification): boolean;
  handleNotification(state: TurnCaptureState, notification: AppServerNotification): void;
  toInterruptCompletion(state: TurnCaptureState): TurnInterruptCompletion;
  resolveNotificationIdleTimeoutMs(turnEstablished: boolean): number;
  hasPendingApproval(): boolean;
  onHeartbeat(): void;
  onAbandonedTurn(): void;
}

export interface CaptureCodexTurnOptions extends CodexTurnCaptureCallbacks {
  beforeInputDispatch?(): void;
  assertInputCurrent?(): void;
  /** A native request acknowledged the content, independently of turn completion. */
  onInputAccepted?(): void;
  autoContinuation?: boolean;
  onNativeTurnAcquired?(turnId: string): void;
  input: UserInput[];
  /**
   * Harness-authored turn text (LT-657). Appended as a developer-role item
   * before `turn/start`, so the turn starts without any user input and the
   * text is never recorded as the user's message.
   */
  developerInput?: string;
  turnParams: Record<string, unknown>;
  completeTurn(state: TurnCaptureState, turn: TurnCaptureState['finalTurn']): void;
}

interface PendingInterrupt {
  completion: Promise<TurnInterruptCompletion>;
  resolve(result: TurnInterruptCompletion): void;
  delivered: boolean;
}

interface ActiveTurn {
  state: TurnCaptureState;
  turnId: string | null;
  origin: CodexAppServerTurnOrigin;
  completionProof: Promise<TurnInterruptCompletion>;
  pendingInterrupt: PendingInterrupt | null;
}

export interface CodexAppServerThreadRuntimeOptions {
  clock?: () => number;
}

/**
 * The context-safety policy's `steer-turn` instruction.
 *
 * LT-653 reworded it after agents recorded "James requested a stop"; LT-657
 * found the real cause: `turn/steer` input is persisted by Codex as a
 * `role: "user"` message, so the model saw the policy text as the user's own
 * words and later told the user "You did" ask to stop (session x7cpyakhs).
 * It is now appended with `thread/inject_items` as a developer-role item,
 * which reaches the running turn without ever becoming a user message.
 */
export const CONTEXT_POLICY_STEER_TEXT =
  'Harness context policy (automated; this is not a message from the user). '
  + 'Context usage is high. For the turn that is running now: wrap up broad exploration, '
  + 'synthesize what you already have, persist durable notes, and do not open new research threads. '
  + 'The user has not asked you to stop, pause, or change task. Never attribute this instruction to the user. '
  + 'Afterwards, continue the user\'s current task.';

/** A Harness instruction as a developer-role Responses item for `thread/inject_items`. */
export function developerMessageItem(text: string): InjectedDeveloperMessageItem {
  return { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] };
}

/** Owns one Codex app-server connection and its authoritative native thread. */
export class CodexAppServerThreadRuntime {
  private readonly clock: () => number;
  private client: CodexAppServerRuntimeClient | null = null;
  private binding: CodexAppServerThreadBinding | null = null;
  private connectionUnsubscribe: (() => void) | null = null;
  private connectionPhase: CodexAppServerConnectionPhase = 'detached';
  private turnPhase: CodexAppServerTurnPhase = 'idle';
  private activeTurn: ActiveTurn | null = null;
  private revision = 0;

  constructor(options: CodexAppServerThreadRuntimeOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
  }

  attach(
    client: CodexAppServerRuntimeClient,
    binding: CodexAppServerThreadBinding,
    onNotification?: AppServerNotificationHandler,
    onExit?: (error: Error | null) => void,
  ): void {
    if (this.client) throw new Error('Codex app-server runtime is already attached');
    this.client = client;
    this.binding = cloneBinding(binding);
    this.connectionPhase = 'ready';
    this.turnPhase = 'idle';
    this.bumpRevision();
    if (onNotification) {
      this.connectionUnsubscribe = client.subscribeNotifications(onNotification);
    }

    void client.exitPromise.then(() => {
      if (this.client !== client || this.connectionPhase === 'closing' || this.connectionPhase === 'closed') {
        return;
      }
      const error = client.getExitError?.() ?? null;
      this.connectionPhase = error ? 'failed' : 'closed';
      this.failActiveTurn(error ?? new Error('codex app-server connection closed'));
      this.bumpRevision();
      onExit?.(error);
    });
  }

  replaceBinding(binding: CodexAppServerThreadBinding): void {
    if (!this.client || this.connectionPhase !== 'ready') {
      throw new Error('Cannot replace Codex thread binding without a ready runtime');
    }
    if (this.activeTurn) {
      throw new Error('Cannot replace Codex thread binding during an active turn');
    }
    this.binding = cloneBinding(binding);
    this.bumpRevision();
  }

  getClient(): CodexAppServerRuntimeClient | null { return this.client; }
  getThreadId(): string | null { return this.binding?.threadId ?? null; }
  getCurrentTurnId(): string | null { return this.activeTurn?.turnId ?? null; }
  getActiveTurnOrigin(): CodexAppServerTurnOrigin | null { return this.activeTurn?.origin ?? null; }
  hasActiveTurn(): boolean { return this.activeTurn !== null; }
  isRunning(): boolean { return this.connectionPhase === 'ready' && (this.client?.isRunning?.() ?? true); }
  getPid(): number | null { return this.isRunning() ? this.client?.getPid?.() ?? null : null; }

  /**
   * Same-turn context-policy steer: stop broad research, synthesize, and
   * archive. Delivered as a developer-role history item, never as user input.
   * Returns false when no live turn exists to steer, including when the turn
   * finished while the steer was in flight and the provider rejected it.
   * Other rejections still throw. `thread/inject_items` has no expected-turn
   * precondition: if the turn ends while the request is in flight, the item
   * stays in history as a developer note for the next turn. It still names
   * Harness and scopes itself to the turn that was running, so it cannot be
   * read as a user request (LT-657).
   */
  async steerActiveTurn(): Promise<boolean> {
    const client = this.client;
    const threadId = this.binding?.threadId;
    const active = this.activeTurn;
    const turnId = active?.turnId;
    if (!client || !threadId || !active || !turnId || this.turnPhase !== 'running') {
      return false;
    }
    try {
      await client.request('thread/inject_items', { threadId, items: [developerMessageItem(CONTEXT_POLICY_STEER_TEXT)] });
    } catch (error) {
      if (this.activeTurn !== active || active.turnId !== turnId || active.state.completed) return false;
      throw error;
    }
    return true;
  }

  /**
   * Delivers Harness input into the running provider turn: developer text via
   * `thread/inject_items`, user text via `turn/steer` pinned to that turn.
   * `delivered` is false when there is no such turn or it ended while a request
   * was in flight; `developerInjected` then says whether the developer item
   * already reached the thread history, so the caller must not send it again.
   */
  async steerProviderTurn(
    input: UserInput[],
    developerInput?: string,
    dispatch?: AdapterInputDispatch,
    onInputAccepted?: () => void,
  ): Promise<{ delivered: boolean; developerInjected: boolean }> {
    const client = this.client;
    const threadId = this.binding?.threadId;
    const active = this.activeTurn;
    const turnId = active?.turnId;
    let developerInjected = false;
    if (!client || !threadId || !active || !turnId || active.origin !== 'provider' || active.state.completed) {
      return { delivered: false, developerInjected };
    }
    try {
      assertAdapterInputCurrent(dispatch);
      dispatch?.beforeProviderDispatch?.();
      if (developerInput) {
        await client.request('thread/inject_items', { threadId, items: [developerMessageItem(developerInput)] });
        onInputAccepted?.();
        developerInjected = true;
      }
      if (input.length > 0) {
        assertAdapterInputCurrent(dispatch);
        await client.request('turn/steer', { threadId, expectedTurnId: turnId, input });
        onInputAccepted?.();
        active.state.steeredInputAccepted = true;
        if (active.state.completionTimer) {
          clearTimeout(active.state.completionTimer);
          active.state.completionTimer = null;
        }
      }
    } catch (error) {
      if (this.activeTurn !== active || active.state.completed) return { delivered: false, developerInjected };
      throw error;
    }
    return { delivered: true, developerInjected };
  }

  getSnapshot(): CodexAppServerRuntimeSnapshot {
    return {
      revision: this.revision,
      capturedAt: this.clock(),
      connectionPhase: this.connectionPhase,
      turnPhase: this.turnPhase,
      providerSessionId: this.binding?.threadId ?? null,
      nativeThreadId: this.binding?.threadId ?? null,
      activeTurnId: this.activeTurn?.turnId ?? null,
      resumeCursor: this.binding?.resumeCursor ? { ...this.binding.resumeCursor } : null,
      resumeProof: this.binding?.resumeProof ? { ...this.binding.resumeProof } : null,
    };
  }

  interrupt(): InterruptResult {
    const active = this.activeTurn;
    if (!active || !this.client || !this.binding) {
      return { status: 'no-active-turn', reason: 'No active Codex app-server turn' };
    }
    if (active.pendingInterrupt) {
      return {
        status: 'accepted',
        ...(active.turnId ? { turnId: active.turnId } : {}),
        completion: active.pendingInterrupt.completion,
      };
    }

    let resolve!: (result: TurnInterruptCompletion) => void;
    const completion = new Promise<TurnInterruptCompletion>((done) => { resolve = done; });
    active.pendingInterrupt = { completion, resolve, delivered: false };
    if (active.turnId) this.deliverPendingInterrupt(active);
    return {
      status: 'accepted',
      ...(active.turnId ? { turnId: active.turnId } : {}),
      completion,
    };
  }

  async captureTurn(options: CaptureCodexTurnOptions): Promise<TurnCaptureState> {
    const { client, threadId } = this.requireIdleConnection();
    options.beforeInputDispatch?.();
    const active = this.beginActiveTurn(options, 'harness');
    let turnStartRequested = false;
    try { return await this.runCapture(active, client, threadId, options, async (capture) => {
      options.assertInputCurrent?.();
      if (options.developerInput) {
        await client.request('thread/inject_items', { threadId, items: [developerMessageItem(options.developerInput)] });
        options.onInputAccepted?.();
      }
      options.assertInputCurrent?.();
      // A native turn may start while developer injection is acknowledged.
      if (options.autoContinuation && active.turnId !== null) {
        const error = new Error('Codex acquired native turn ownership before turn/start');
        error.name = 'AbortError';
        throw error;
      }
      let turnResult: AppServerResponseResult<'turn/start'>;
      try {
        turnStartRequested = true;
        turnResult = await Promise.race<AppServerResponseResult<'turn/start'>>([
          client.request('turn/start', {
            ...options.turnParams,
            threadId,
            input: options.input,
          } as AppServerRequestParams<'turn/start'>).then((result) => {
            // The RPC may acknowledge content after completion/exit wins the race.
            if (options.input.length > 0) options.onInputAccepted?.();
            return result;
          }),
          new Promise<never>((_, reject) => { void active.state.completion.catch(reject); }),
          client.exitPromise.then(() => {
            throw this.transportClosedError(client, 'during turn/start');
          }) as Promise<never>,
        ]);
      } catch (error) {
        // `turn/start` steers into a turn Codex started on its own (a goal
        // continuation), and Codex rejects an empty steer. The developer item
        // injected above already reached that turn, so follow it instead.
        if (options.autoContinuation || !options.developerInput || !isEmptyInputSteerRejection(error)) throw error;
        const runningTurnId = active.turnId ?? await this.findInProgressTurnId(client, threadId);
        if (!runningTurnId) throw error;
        turnResult = { turn: { id: runningTurnId, status: 'inProgress' } };
      }

      const responseTurnId = turnResult.turn?.id;
      if (responseTurnId) this.establishTurn(active, threadId, responseTurnId);
      capture.flushBuffered();

      if (turnResult.turn?.status && turnResult.turn.status !== 'inProgress') {
        options.completeTurn(active.state, turnResult.turn);
      }
    }); } finally {
      // An unsolicited turn seen before our start belongs to Codex; keep following it after aborting this input.
      if (options.autoContinuation && !turnStartRequested && active.turnId && !active.state.completed) {
        options.onNativeTurnAcquired?.(active.turnId);
      }
    }
  }

  /**
   * Follows a turn Codex started without a Harness request, such as a
   * thread-goal continuation. Without this the turn's output never reached the
   * transcript and the session read as idle while it worked (xqs4fg7sl).
   * Returns null when a turn is already being captured.
   */
  captureProviderTurn(
    turnId: string,
    options: CodexTurnCaptureCallbacks,
    startedNotification?: AppServerNotification,
  ): Promise<TurnCaptureState> | null {
    const client = this.client;
    const threadId = this.binding?.threadId;
    if (!client || !threadId || this.connectionPhase !== 'ready' || this.activeTurn) return null;
    const active = this.beginActiveTurn(options, 'provider');
    this.establishTurn(active, threadId, turnId);
    if (startedNotification) options.handleNotification(active.state, startedNotification);
    return this.runCapture(active, client, threadId, options, async () => undefined);
  }

  async close(): Promise<void> {
    const client = this.client;
    if (!client || this.connectionPhase === 'closed') return;
    this.connectionPhase = 'closing';
    this.bumpRevision();
    this.connectionUnsubscribe?.();
    this.connectionUnsubscribe = null;
    this.failActiveTurn(new Error('Codex app-server runtime closed'));
    try {
      await client.close?.();
    } finally {
      if (this.client === client) {
        this.client = null;
        this.binding = null;
        this.activeTurn = null;
        this.turnPhase = 'idle';
        this.connectionPhase = 'closed';
        this.bumpRevision();
      }
    }
  }

  private requireIdleConnection(): { client: CodexAppServerRuntimeClient; threadId: string } {
    const client = this.client;
    const threadId = this.binding?.threadId;
    if (!client || !threadId || this.connectionPhase !== 'ready') {
      throw new CodexAppServerRuntimeError({
        kind: 'transport-closed',
        message: 'Codex app-server runtime is not ready',
        recoverability: 'retry-thread',
      });
    }
    if (this.activeTurn) {
      throw new CodexAppServerRuntimeError({
        kind: 'request-rejected',
        message: 'Codex app-server runtime already has an active turn',
        recoverability: 'retry-thread',
      });
    }
    return { client, threadId };
  }

  private beginActiveTurn(options: CodexTurnCaptureCallbacks, origin: CodexAppServerTurnOrigin): ActiveTurn {
    const threadId = this.binding!.threadId;
    const state = options.createState(threadId);
    const completionProof = state.completion
      .then(options.toInterruptCompletion)
      .catch((error: unknown) => ({
        status: 'rejected' as const,
        turnId: state.turnId ?? undefined,
        reason: error instanceof Error ? error.message : String(error),
      }));
    const active: ActiveTurn = { state, turnId: null, origin, completionProof, pendingInterrupt: null };
    this.activeTurn = active;
    this.turnPhase = 'starting';
    this.bumpRevision();
    return active;
  }

  /**
   * Routes notifications to the active turn, arms the stall watchdog, runs
   * `start`, then waits for completion. Always releases the turn slot.
   */
  private async runCapture(
    active: ActiveTurn,
    client: CodexAppServerRuntimeClient,
    threadId: string,
    options: CodexTurnCaptureCallbacks,
    start: (capture: { flushBuffered(): void }) => Promise<void>,
  ): Promise<TurnCaptureState> {
    const state = active.state;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let turnEstablished = false;
    const armIdleWatchdog = () => {
      if (idleTimer) clearTimeout(idleTimer);
      // A known turn id proves the turn started, even if its turn/started was missed.
      const timeoutMs = options.resolveNotificationIdleTimeoutMs(turnEstablished || active.turnId !== null);
      idleTimer = setTimeout(() => {
        if (state.completed) return;
        if (options.hasPendingApproval()) {
          options.onHeartbeat();
          armIdleWatchdog();
          return;
        }
        state.rejectCompletion(new CodexAppServerRuntimeError({
          kind: 'turn-stalled',
          message: `Codex turn stalled: no notifications received for ${timeoutMs}ms`,
          recoverability: 'retry-thread',
        }));
      }, timeoutMs);
      idleTimer.unref?.();
    };

    const unsubscribe = client.subscribeNotifications((notification) => {
      if (notification.method === 'thread/compacted') return;
      if (
        notification.method === 'turn/started'
        && notification.params['threadId'] === threadId
      ) {
        const turn = notification.params['turn'];
        const turnId = turn && typeof turn === 'object'
          ? (turn as Record<string, unknown>)['id']
          : null;
        if (typeof turnId === 'string') this.establishTurn(active, threadId, turnId);
        turnEstablished = true;
      }
      armIdleWatchdog();
      options.onHeartbeat();

      if (notification.method === 'thread/started' || notification.method === 'thread/name/updated') {
        options.handleNotification(state, notification);
        return;
      }
      if (!state.turnId) {
        state.bufferedNotifications.push(notification);
        return;
      }
      if (options.belongsToTurn(state, notification)) {
        options.handleNotification(state, notification);
      }
    });

    try {
      armIdleWatchdog();
      await start({
        flushBuffered: () => {
          for (const buffered of state.bufferedNotifications) {
            if (options.belongsToTurn(state, buffered)) options.handleNotification(state, buffered);
          }
          state.bufferedNotifications.length = 0;
        },
      });
      armIdleWatchdog();

      return await Promise.race([
        state.completion,
        client.exitPromise.then(() => {
          if (state.completed) return state;
          throw this.transportClosedError(client, 'during turn');
        }),
      ]);
    } finally {
      if (!state.completed) options.onAbandonedTurn();
      if (this.activeTurn === active) {
        this.settleUndeliveredInterrupt(active);
        this.activeTurn = null;
        this.turnPhase = 'idle';
        this.bumpRevision();
      }
      if (idleTimer) clearTimeout(idleTimer);
      if (state.completionTimer) clearTimeout(state.completionTimer);
      unsubscribe();
    }
  }

  /** The newest turn when Codex reports it still running, else null. */
  private async findInProgressTurnId(
    client: CodexAppServerRuntimeClient,
    threadId: string,
  ): Promise<string | null> {
    try {
      const turns = await client.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc' });
      const latest = turns.data[0];
      return latest?.status === 'inProgress' ? latest.id : null;
    } catch {
      return null;
    }
  }

  private establishTurn(active: ActiveTurn, threadId: string, turnId: string): void {
    if (this.activeTurn !== active || active.turnId && active.turnId !== turnId) return;
    active.turnId = turnId;
    active.state.turnId = turnId;
    active.state.threadTurnIds.set(threadId, turnId);
    this.turnPhase = 'running';
    this.bumpRevision();
    this.deliverPendingInterrupt(active);
  }

  private deliverPendingInterrupt(active: ActiveTurn): void {
    const pending = active.pendingInterrupt;
    const threadId = this.binding?.threadId;
    if (!pending || pending.delivered || !active.turnId || !threadId) return;
    pending.delivered = true;
    this.turnPhase = 'interrupting';
    this.bumpRevision();
    void this.interruptActiveTurn(active, threadId, active.turnId).then(pending.resolve);
  }

  private async interruptActiveTurn(
    active: ActiveTurn,
    threadId: string,
    turnId: string,
  ): Promise<TurnInterruptCompletion> {
    const client = this.client;
    if (!client) return { status: 'rejected', turnId, reason: 'Codex app-server client is not connected' };
    const isStale = () => this.activeTurn !== active || active.turnId !== turnId || active.state.completed;
    if (isStale()) return { status: 'unknown', turnId, reason: 'turn already ended before interrupt was sent' };
    try {
      const response = await client.request('turn/interrupt', { threadId, turnId });
      if (response.success === false) {
        if (isStale()) return { status: 'unknown', turnId, reason: 'turn ended before interrupt was acknowledged' };
        return { status: 'rejected', turnId, reason: 'Codex did not accept turn/interrupt' };
      }
      return await active.completionProof;
    } catch (error) {
      if (isStale()) return { status: 'unknown', turnId, reason: 'turn ended before interrupt resolved' };
      return {
        status: 'rejected',
        turnId,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private settleUndeliveredInterrupt(active: ActiveTurn): void {
    const pending = active.pendingInterrupt;
    if (pending && !pending.delivered) {
      pending.resolve({ status: 'unknown', reason: 'turn ended before pending interrupt could fire' });
    }
  }

  private failActiveTurn(error: Error): void {
    const active = this.activeTurn;
    if (!active) return;
    this.settleUndeliveredInterrupt(active);
    if (!active.state.completed) {
      active.state.rejectCompletion(new CodexAppServerRuntimeError({
        kind: 'transport-closed',
        message: error.message,
        recoverability: 'retry-thread',
        cause: error,
      }));
    }
  }

  private transportClosedError(client: CodexAppServerRuntimeClient, suffix: string): CodexAppServerRuntimeError {
    const cause = client.getExitError?.() ?? null;
    return new CodexAppServerRuntimeError({
      kind: 'transport-closed',
      message: `codex app-server exited unexpectedly ${suffix}`,
      recoverability: 'retry-thread',
      cause,
    });
  }

  private bumpRevision(): void { this.revision += 1; }
}

export function createCodexTurnCaptureState(threadId: string): TurnCaptureState {
  let resolveCompletion!: (state: TurnCaptureState) => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<TurnCaptureState>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  return {
    threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    steeredInputAccepted: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    lastAgentMessage: '',
    reviewText: '',
    reasoningSummary: [],
    error: null,
    messages: [],
    streamingAgentMessages: new Map(),
    finalAgentOutputId: null,
    fileChanges: [],
    commandExecutions: [],
    onProgress: null,
  };
}

function cloneBinding(binding: CodexAppServerThreadBinding): CodexAppServerThreadBinding {
  return {
    threadId: binding.threadId,
    resumeCursor: binding.resumeCursor ? { ...binding.resumeCursor } : null,
    resumeProof: binding.resumeProof ? { ...binding.resumeProof } : null,
  };
}
