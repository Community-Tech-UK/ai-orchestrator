import type {
  InterruptResult,
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
  TurnCaptureState,
  UserInput,
} from './app-server-types';
import { CodexAppServerRuntimeError } from './app-server-runtime-errors';

export type CodexAppServerConnectionPhase =
  | 'detached'
  | 'ready'
  | 'closing'
  | 'closed'
  | 'failed';

export type CodexAppServerTurnPhase = 'idle' | 'starting' | 'running' | 'interrupting';

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
}

export interface CaptureCodexTurnOptions {
  input: UserInput[];
  turnParams: Record<string, unknown>;
  createState(threadId: string): TurnCaptureState;
  belongsToTurn(state: TurnCaptureState, notification: AppServerNotification): boolean;
  handleNotification(state: TurnCaptureState, notification: AppServerNotification): void;
  completeTurn(state: TurnCaptureState, turn: TurnCaptureState['finalTurn']): void;
  toInterruptCompletion(state: TurnCaptureState): TurnInterruptCompletion;
  resolveNotificationIdleTimeoutMs(turnEstablished: boolean): number;
  hasPendingApproval(): boolean;
  onHeartbeat(): void;
  onAbandonedTurn(): void;
}

interface PendingInterrupt {
  completion: Promise<TurnInterruptCompletion>;
  resolve(result: TurnInterruptCompletion): void;
  delivered: boolean;
}

interface ActiveTurn {
  state: TurnCaptureState;
  turnId: string | null;
  completionProof: Promise<TurnInterruptCompletion>;
  pendingInterrupt: PendingInterrupt | null;
}

export interface CodexAppServerThreadRuntimeOptions {
  clock?: () => number;
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
  hasActiveTurn(): boolean { return this.activeTurn !== null; }
  isRunning(): boolean { return this.connectionPhase === 'ready' && (this.client?.isRunning?.() ?? true); }
  getPid(): number | null { return this.isRunning() ? this.client?.getPid?.() ?? null : null; }

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

    const state = options.createState(threadId);
    const completionProof = state.completion
      .then(options.toInterruptCompletion)
      .catch((error: unknown) => ({
        status: 'rejected' as const,
        turnId: state.turnId ?? undefined,
        reason: error instanceof Error ? error.message : String(error),
      }));
    const active: ActiveTurn = { state, turnId: null, completionProof, pendingInterrupt: null };
    this.activeTurn = active;
    this.turnPhase = 'starting';
    this.bumpRevision();

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let turnEstablished = false;
    const armIdleWatchdog = () => {
      if (idleTimer) clearTimeout(idleTimer);
      const timeoutMs = options.resolveNotificationIdleTimeoutMs(turnEstablished);
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
      const turnResult = await Promise.race<AppServerResponseResult<'turn/start'>>([
        client.request('turn/start', {
          ...options.turnParams,
          threadId,
          input: options.input,
        } as AppServerRequestParams<'turn/start'>),
        new Promise<never>((_, reject) => { void state.completion.catch(reject); }),
        client.exitPromise.then(() => {
          throw this.transportClosedError(client, 'during turn/start');
        }) as Promise<never>,
      ]);

      const responseTurnId = turnResult.turn?.id;
      if (responseTurnId) this.establishTurn(active, threadId, responseTurnId);

      for (const buffered of state.bufferedNotifications) {
        if (options.belongsToTurn(state, buffered)) options.handleNotification(state, buffered);
      }
      state.bufferedNotifications.length = 0;

      if (turnResult.turn?.status && turnResult.turn.status !== 'inProgress') {
        options.completeTurn(state, turnResult.turn);
      }
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
