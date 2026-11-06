/**
 * Remote CLI Adapter - Proxies CLI operations to a remote worker node via RPC.
 *
 * Instead of spawning a local process, this adapter forwards all commands to a
 * worker node through the WorkerNodeConnectionServer WebSocket connection.
 * Output, state changes, and permission requests arrive asynchronously from the
 * worker and are forwarded as EventEmitter events — matching the event contract
 * of the local CLI adapters.
 */
import { EventEmitter } from 'events';
import { randomUUID } from 'node:crypto';
import { getLogger } from '../../logging/logger';
import type { WorkerNodeConnectionServer } from '../../remote-node/worker-node-connection';
import { getWorkerNodeRegistry } from '../../remote-node/worker-node-registry';
import type { CliType } from '../cli-detection';
import type { UnifiedSpawnOptions } from './adapter-factory';
import type { AdapterInputOptions, AdapterRuntimeCapabilities, CliResponse, CliSpawnMode, InterruptResult, ResumeAttemptResult, TurnInterruptCompletion } from './base-cli-adapter';
import type { FileAttachment, OutputMessage } from '../../../shared/types/instance.types';
import { getPauseCoordinator } from '../../pause/pause-coordinator';
import { RemoteResponseUsageSettlement } from './remote-response-usage-settlement';
import { clearAdapterStopping, isAdapterStopping, markAdapterStopping } from '../../providers/adapter-stop-state';
import { OrchestratorPausedError } from '../../pause/orchestrator-paused-error';
import { RPC_ERROR_CODES } from '../../remote-node/worker-node-rpc';
import { InstanceSendRawParamsSchema, InputRequiredResolvedSchema, ProviderSessionSchema, ProviderTurnSchema, NativeHistoryReplaySchema, RemoteInputRequiredSchema, boundedRemoteCommands, inputNotPending, interactionPayload, remoteContextDetails, type RemoteNativeCommand } from '../../remote-node/instance-interaction-schemas';
import type { CopilotNumericUsage } from '../../../shared/utils/copilot-usage';
import { assertAdapterInputCurrent, createAdapterInputDispatch } from './adapter-input-dispatch';
import { JsonChunkAssembler } from '../../../shared/utils/json-chunks';
import type { AcpHistoryReplay } from './acp-session-replay';
import type { RemoteInstanceTelemetry } from '../../remote-node/instance-telemetry-rpc';
import { remoteClaudeSpawnPolicyFor } from './remote-claude-spawn-policy';
import { remoteCliSpawnParams } from './remote-cli-spawn-params';
import { hasRemoteRpcErrorCode, isRemoteModelChangeRejected, sendRemoteSpawnRpc } from './remote-model-change-rpc';
import { sampleRemoteStallProcessFacts } from './remote-stall-process-facts';
import type { StallProcessFacts } from '../../instance/stall-process-facts';
import { assertRemoteQueuePushGuardSupported } from './remote-queue-push-guard';
import { remoteCliCapabilities } from './remote-cli-capabilities';
import { observeRemoteCodexUsage } from './remote-codex-usage';
const logger = getLogger('RemoteCliAdapter');
/**
 * Max time to wait for a terminal remote event after an interrupt before the
 * completion settles to `unknown` (Phase 5 / A2 for remote). Bounds the await so
 * the interrupt state machine never hangs on a wedged/silent worker.
 */
const REMOTE_INTERRUPT_COMPLETION_MS = 15_000;
interface RemoteOutputEvent {
  nodeId: string;
  instanceId: string;
  message: OutputMessage;
}
interface RemoteStateChangeEvent {
  nodeId: string;
  instanceId: string;
  state: string;
  info?: unknown;
}
interface RemotePermissionRequestEvent {
  nodeId: string;
  instanceId: string;
  permission: unknown;
}
interface RemoteContextEvent {
  nodeId: string;
  instanceId: string;
  usage: unknown;
}
interface RemoteHeartbeatEvent {
  nodeId: string;
  instanceId: string;
}
interface RemoteCompleteEvent {
  nodeId: string;
  instanceId: string;
  response: CliResponse;
}
export class RemoteCliAdapter extends EventEmitter {
  private remoteInstanceId: string | null = null;
  /** Cleanup ownership only; an uncertain previous runtime must never receive input. */
  private previousAdapterPendingStop: RemoteCliAdapter | null = null;
  private copilotUsage: CopilotNumericUsage | undefined;
  private interactionId = randomUUID();
  private availableCommands: RemoteNativeCommand[] = [];
  private providerSessionId: string | null = null;
  private providerTurn: { active: boolean; activeToolCalls: boolean; at: number } | null = null;
  private readonly pendingInputs = new Set<string>();
  private readonly usageSettlement = new RemoteResponseUsageSettlement();
  private codexUsageCleanup?: () => void;
  private readonly nextPromptContexts: string[] = [];
  private contextDispatchPending: object | null = null;
  private readonly historyChunks = new JsonChunkAssembler({ maxCharacters: 40 * 1024 * 1024, maxTransfers: 1 });
  private pendingHistoryReplay: AcpHistoryReplay | null = null;
  private historyReplayFailure: Error | null = null;
  private spawnPending = false;
  /** Latest resume proof relayed from the worker adapter (P2.9). */
  private lastResumeAttemptResult: ResumeAttemptResult | null = null;
  /** Last remote activity; the idle monitor uses it to detect a stale worker. */
  private lastActivityAt: number | null = null;
  private readonly registry = getWorkerNodeRegistry();
  private registryListenersAttached = false;
  private readonly onRemoteOutputEvent = (event: RemoteOutputEvent): void => {
    if (!this.matchesRemoteInstance(event.nodeId, event.instanceId)) {
      return;
    }
    this.handleRemoteOutput(event.message);
  };
  private readonly onRemoteStateChangeEvent = (event: RemoteStateChangeEvent): void => {
    if (!this.matchesRemoteInstance(event.nodeId, event.instanceId)) {
      return;
    }
    // P2.9: the worker relays its adapter's resume proof as a `resume_proof`
    // pseudo-state whose `info` carries the ResumeAttemptResult. Capture it for
    // getResumeAttemptResult() and don't forward it as a lifecycle state.
    if (event.state === 'resume_proof') {
      if (event.info && typeof event.info === 'object') {
        this.lastResumeAttemptResult = event.info as ResumeAttemptResult;
      }
      return;
    }
    if (event.state === 'provider_turn') {
      const value = ProviderTurnSchema.safeParse(interactionPayload(event.info, this.interactionId));
      if (value.success) { this.providerTurn = { ...value.data, at: Date.now() }; this.markActivity(); }
      return;
    }
    if (event.state === 'stderr_activity') {
      if (event.info && typeof event.info === 'object'
        && (event.info as { interactionId?: unknown }).interactionId === this.interactionId) this.emit('stderr');
      return;
    }
    if (event.state === 'history_replay') {
      if (!this.spawnPending) return;
      const payload = interactionPayload(event.info, this.interactionId);
      if (payload === undefined) return;
      try {
        const complete = this.historyChunks.accept(payload);
        if (complete) {
          const history = NativeHistoryReplaySchema.parse(complete.value);
          if (history.sessionId !== this.providerSessionId) throw new Error('Remote history session identity changed.');
          this.pendingHistoryReplay = history;
        }
      } catch {
        this.historyChunks.clear();
        this.historyReplayFailure = new Error('Remote session history could not be restored completely.');
      }
      return;
    }
    if (event.state === 'provider_session') {
      const value = ProviderSessionSchema.safeParse(interactionPayload(event.info, this.interactionId)); if (value.success) this.providerSessionId = value.data.sessionId; return;
    }
    if (event.state === 'available_commands') {
      const payload = interactionPayload(event.info, this.interactionId); if (payload === undefined) return;
      this.availableCommands = boundedRemoteCommands(payload); this.emit('available_commands', this.getAvailableCommands()); return;
    }
    if (event.state === 'input_required_resolved') {
      const value = InputRequiredResolvedSchema.safeParse(interactionPayload(event.info, this.interactionId));
      if (value.success && this.pendingInputs.delete(value.data.id)) this.emit('input_required_resolved', value.data);
      return;
    }
    if (event.state === 'exited') {
      const info = event.info;
      const code = typeof info === 'number'
        ? info
        : typeof info === 'object' && info !== null && typeof (info as { code?: unknown }).code === 'number'
          ? (info as { code: number }).code
          : 0;
      const signal = typeof info === 'object' && info !== null && typeof (info as { signal?: unknown }).signal === 'string'
        ? (info as { signal: string }).signal
        : null;
      this.handleRemoteExit(code, signal);
      return;
    }
    this.handleRemoteStateChange(event.state);
  };
  private readonly onRemotePermissionRequestEvent = (event: RemotePermissionRequestEvent): void => {
    if (!this.matchesRemoteInstance(event.nodeId, event.instanceId)) {
      return;
    }
    this.handleRemotePermissionRequest(event.permission);
  };
  private readonly onRemoteContextEvent = (event: RemoteContextEvent): void => {
    if (!this.matchesRemoteInstance(event.nodeId, event.instanceId)) {
      return;
    }
    this.handleRemoteContext(event.usage);
  };
  private readonly onRemoteHeartbeatEvent = (event: RemoteHeartbeatEvent): void => {
    if (!this.matchesRemoteInstance(event.nodeId, event.instanceId)) {
      return;
    }
    this.handleRemoteHeartbeat();
  };
  private readonly onRemoteCompleteEvent = (event: RemoteCompleteEvent): void => {
    if (!this.matchesRemoteInstance(event.nodeId, event.instanceId)) {
      return;
    }
    this.handleRemoteComplete(event.response);
  };
  private readonly onRemoteTelemetryEvent = (event: RemoteInstanceTelemetry): void => {
    if (!this.matchesRemoteInstance(event.nodeId, event.instanceId)) return;
    if (event.telemetry.event === 'codex_ephemeral_usage') return; // Consumed by the ownership-validated numeric store only.
    this.emit(event.telemetry.event, event.telemetry.payload);
  };
  constructor(
    private readonly nodeConnection: WorkerNodeConnectionServer,
    private readonly targetNodeId: string,
    private readonly requestedCliType: CliType,
    private readonly spawnOptions: UnifiedSpawnOptions,
  ) {
    super();
  }
  // ---------------------------------------------------------------------------
  // Core operations — all proxy to RPC
  // ---------------------------------------------------------------------------
  /**
   * Spawn a remote instance via RPC.
   * Returns -1 as PID since the process runs on a remote machine.
   */
  async spawn(): Promise<number> {
    return this.spawnRemote();
  }
  /** Check before the reconciler detaches or mutates the current runtime. */
  assertModelChangeSupported(): void {
    this.assertNotStopping();
    if (!this.remoteInstanceId) throw new Error('The worker session is no longer running.');
    if (this.registry.getNode?.(this.targetNodeId)?.capabilities.instanceModelChange !== 1) {
      throw new Error('This worker cannot switch models safely yet. Update the worker, or use local execution for this session.');
    }
  }
  /** Keep the reconciler's continuity plan; replace its worker runtime in one guarded operation. */
  async changeModel(replacement: RemoteCliAdapter): Promise<number> {
    this.assertModelChangeSupported();
    if (replacement === this) throw new Error('A model change requires a separate replacement adapter.');
    if (replacement.targetNodeId !== this.targetNodeId || replacement.requestedCliType !== this.requestedCliType) {
      throw new Error('A model change must keep the same worker and provider.');
    }
    return replacement.spawnRemote(this);
  }
  private async spawnRemote(previous?: RemoteCliAdapter): Promise<number> {
    if (this.remoteInstanceId || this.previousAdapterPendingStop) this.assertNotStopping();
    else clearAdapterStopping(this);
    this.copilotUsage = undefined;
    if (!this.spawnOptions.sessionId) {
      throw new Error('RemoteCliAdapter requires spawnOptions.sessionId for remote execution');
    }
    if (!this.spawnOptions.workingDirectory) {
      throw new Error('RemoteCliAdapter requires spawnOptions.workingDirectory for remote execution');
    }
    if (this.requestedCliType === 'opencode') {
      const requiresV2 = this.spawnOptions.forkSession || Boolean(this.spawnOptions.additionalDirectories?.length)
        || this.spawnOptions.nodePlacement?.requiresOpenCodeMajor === 2;
      if (requiresV2 && this.registry.getNode(this.targetNodeId)?.capabilities.openCodeMajor !== 2) {
        throw new Error('This OpenCode operation needs a worker running OpenCode 2.0.30 or newer. Update OpenCode on that worker or choose another worker.');
      }
    }
    const claudeSpawnPolicy = remoteClaudeSpawnPolicyFor(this.requestedCliType, this.spawnOptions, this.registry.getNode?.(this.targetNodeId)?.capabilities);
    assertRemoteQueuePushGuardSupported(this.spawnOptions, this.registry.getNode?.(this.targetNodeId)?.capabilities);
    if (this.requestedCliType === 'codex' && this.spawnOptions.ephemeral === false
      && this.registry.getNode?.(this.targetNodeId)?.capabilities.codexSpawnMetadata !== 1) {
      throw new Error('Persistent Codex requires an updated worker that preserves its session policy. Update the worker or use local execution.');
    }
    const interactionId = randomUUID();
    const spawnParams = remoteCliSpawnParams(this.requestedCliType, this.spawnOptions, interactionId, claudeSpawnPolicy,
      this.registry.getNode?.(this.targetNodeId)?.capabilities);
    this.previousAdapterPendingStop = previous ?? null;
    // Set the expected remote instance ID and attach registry listeners BEFORE
    // sending the spawn RPC. This eliminates the window where early output from
    // the remote instance could be missed because listeners weren't registered yet.
    this.remoteInstanceId = this.spawnOptions.sessionId;
    this.interactionId = interactionId;
    this.codexUsageCleanup?.();
    const codexUsageCleanup = this.requestedCliType === 'codex' && this.spawnOptions.ephemeral !== false
      ? observeRemoteCodexUsage(this.registry, this.targetNodeId, this.remoteInstanceId, interactionId, this.spawnOptions)
      : undefined;
    this.codexUsageCleanup = codexUsageCleanup;
    this.spawnPending = true;
    this.attachRegistryListeners();
    let acknowledged = false;
    try {
      const response = await sendRemoteSpawnRpc<{ instanceId: string }>(this.nodeConnection, this.targetNodeId, spawnParams,
        previous?.remoteInstanceId ?? undefined);
      // Success proves the old runtime was replaced even if this adapter was
      // stopped while its acknowledgement was in flight.
      previous?.forceCleanup();
      if (this.previousAdapterPendingStop === previous) this.previousAdapterPendingStop = null;
      // A stop or newer spawn invalidates this asynchronous acknowledgement.
      if (this.interactionId !== interactionId || !this.remoteInstanceId) throw new Error('Remote instance changed before spawn acknowledgement.');
      acknowledged = true;
      const expectsHistory = this.requestedCliType === 'opencode' && this.spawnOptions.resume
        && !this.spawnOptions.transcriptKnown && this.registry.getNode?.(this.targetNodeId)?.capabilities.openCodeMajor === 2;
      if (this.historyReplayFailure || expectsHistory && !this.pendingHistoryReplay) throw this.historyReplayFailure ?? new Error('The OpenCode 2 worker did not deliver the loaded session history.');
      // Update with the actual remote instance ID (should match sessionId)
      this.remoteInstanceId = response.instanceId;
      logger.info('Remote instance spawned', {
        nodeId: this.targetNodeId,
        instanceId: this.remoteInstanceId,
      });
      this.markActivity();
    } catch (err) {
      if (previous && !acknowledged && !isRemoteModelChangeRejected(err)) {
        if (hasRemoteRpcErrorCode(err, RPC_ERROR_CODES.MODEL_CHANGE_FAILED_AFTER_TEARDOWN)) {
          previous.forceCleanup();
          if (this.previousAdapterPendingStop === previous) this.previousAdapterPendingStop = null;
        } else markAdapterStopping(previous); // Keep its final usage observation until a stop is confirmed.
      }
      if (this.interactionId !== interactionId) throw err;
      if (acknowledged) { await this.terminate(false); throw err; }
      // An explicit refusal proves there is no replacement to stop. Its ID may
      // be the retained session's ID, so rollback must never terminate it.
      if (previous && isRemoteModelChangeRejected(err)) {
        this.previousAdapterPendingStop = null;
        this.forceCleanup(); throw err;
      }
      // A rejected spawn can leave a worker-owned child whose cleanup failed.
      // Keep its identity and observation until rollback or a later stop confirms absence.
      markAdapterStopping(this);
      throw err;
    } finally {
      if (this.interactionId === interactionId) this.spawnPending = false;
    }

    // Emit outside the catch: a throwing listener must retain the acknowledged
    // child identity so rollback termination can still reach the worker.
    const history = this.pendingHistoryReplay;
    this.pendingHistoryReplay = null;
    if (history) this.emit('history_replay', history);
    this.emit('spawned', -1);
    return -1; // No local PID for remote instances
  }

  /** Carry account-change context with the next user turn, never as a separate RPC. */
  queueNextPromptContext(text: string): void {
    if (text.trim()) this.nextPromptContexts.push(text);
  }

  /** Remote nodes receive the Harness envelope in the text; admission controls stay in-process. */
  async sendInput(message: string, attachments?: FileAttachment[], options?: AdapterInputOptions): Promise<void> {
    this.assertNotStopping();
    if (!this.remoteInstanceId) {
      throw new Error('RemoteCliAdapter: not spawned — call spawn() before sendInput()');
    }
    if (getPauseCoordinator().isPaused()) {
      throw new OrchestratorPausedError('Remote input refused while orchestrator is paused');
    }

    if (this.contextDispatchPending) {
      throw new Error('Cannot send message: the previous turn is still running.');
    }
    const commandName = /^\/([^\s]+)(?:\s|$)/.exec(message)?.[1];
    const nativeCommand = this.requestedCliType === 'opencode' && this.availableCommands.some((command) => command.name === commandName);
    const contextCount = nativeCommand ? 0 : this.nextPromptContexts.length;
    const prompt = contextCount > 0 ? [...this.nextPromptContexts, message].join('\n\n') : message;
    const owner = this.contextDispatchPending = {};
    const interactionId = this.interactionId;
    const instanceId = this.remoteInstanceId;
    const dispatch = createAdapterInputDispatch(options?.dispatch);
    const assertCurrent = (): void => {
      this.assertNotStopping();
      assertAdapterInputCurrent(dispatch);
      if (this.remoteInstanceId !== instanceId || this.interactionId !== interactionId || this.contextDispatchPending !== owner) throw new Error('Remote instance changed before provider dispatch.');
      if (getPauseCoordinator().isPaused()) throw new OrchestratorPausedError('Remote input refused while orchestrator is paused');
      if (nativeCommand && !this.availableCommands.some((command) => command.name === commandName)) throw new Error('The selected native command is no longer available in this session.');
    };
    try {
      assertCurrent();
      if (this.spawnOptions.beforeProviderPrompt) await this.spawnOptions.beforeProviderPrompt();
      assertCurrent();
      dispatch?.beforeProviderDispatch?.();
      assertCurrent();
      // Worker sends may span an unbounded turn; disconnects reject the RPC.
      await this.nodeConnection.sendRpc(
        this.targetNodeId,
        'instance.sendInput',
        {
          instanceId: this.remoteInstanceId,
          message: prompt,
          attachments,
          ...(nativeCommand ? { nativeCommandId: `acp:opencode:${commandName}` } : {}),
        },
        0,
      );
      if (this.contextDispatchPending === owner) this.nextPromptContexts.splice(0, contextCount);
    } finally {
      if (this.contextDispatchPending === owner) this.contextDispatchPending = null;
    }
  }

  /**
   * P2.9: Resume proof proxied from the worker adapter. Without this, remote
   * resume health defaults to "succeeded on any output" with no session-id
   * confirmation (the remote half of B1). `null` until the worker relays proof.
   */
  getResumeAttemptResult(): ResumeAttemptResult | null {
    return this.lastResumeAttemptResult;
  }
  getCopilotUsage(): CopilotNumericUsage | undefined {
    if (isAdapterStopping(this)) return undefined; // A stopping runtime must not trigger context recycling.
    return this.copilotUsage ? { ...this.copilotUsage } : undefined;
  }
  getAvailableCommands(): readonly RemoteNativeCommand[] { return this.availableCommands.map(command => ({ ...command })); }
  hasActiveTurn(): boolean {
    return Boolean(this.remoteInstanceId && this.providerTurn?.active && Date.now() - this.providerTurn.at < 15_000
      && this.nodeConnection.isNodeConnected(this.targetNodeId));
  }
  hasActiveToolCalls(): boolean { return this.hasActiveTurn() && this.providerTurn?.activeToolCalls === true; }

  async sendRaw(response: string, permissionKey?: string): Promise<void> {
    this.assertNotStopping();
    const params = InstanceSendRawParamsSchema.parse({ instanceId: this.remoteInstanceId, response, permissionKey });
    if (!this.pendingInputs.has(params.permissionKey)) throw inputNotPending();
    if (getPauseCoordinator().isPaused()) throw new OrchestratorPausedError('Permission response refused while orchestrator is paused');
    try { await this.nodeConnection.sendRpc(this.targetNodeId, 'instance.sendRaw', params); }
    catch (error) {
      if (error instanceof Error && (('code' in error && error.code === RPC_ERROR_CODES.INPUT_REQUIRED_NOT_PENDING)
        || error.message.startsWith(`RPC error ${RPC_ERROR_CODES.INPUT_REQUIRED_NOT_PENDING}:`))) { this.pendingInputs.delete(params.permissionKey); throw inputNotPending(); }
      throw error;
    }
    if (this.pendingInputs.delete(params.permissionKey)) this.emit('input_required_resolved', { id: params.permissionKey, reason: 'decided' });
  }

  /**
   * Interrupt the remote instance. Returns accepted if the RPC was initiated.
   * Logs errors and emits an 'error' event on failure so callers are aware.
   */
  interrupt(): InterruptResult {
    if (!this.remoteInstanceId) {
      return { status: 'already-idle', reason: 'No remote instance is attached' };
    }

    const instanceId = this.remoteInstanceId;

    // Check node connectivity first for fast failure
    if (!this.nodeConnection.isNodeConnected(this.targetNodeId)) {
      logger.warn('Cannot interrupt remote instance — node disconnected', {
        nodeId: this.targetNodeId,
        instanceId,
      });
      return { status: 'rejected', reason: 'Remote node is disconnected' };
    }

    this.nodeConnection.sendRpc(
      this.targetNodeId,
      'instance.interrupt',
      { instanceId },
    ).catch((err: Error) => {
      logger.warn('Failed to interrupt remote instance', {
        nodeId: this.targetNodeId,
        instanceId,
        error: err.message,
      });
      this.emit('error', new Error(`Remote interrupt failed: ${err.message}`));
    });

    // Completion waits for a terminal event, bounded for a silent worker.
    const completion = new Promise<TurnInterruptCompletion>((resolve) => {
      let settled = false;
      const finish = (result: TurnInterruptCompletion): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off('complete', onTerminal);
        this.off('exit', onTerminal);
        resolve(result);
      };
      const onTerminal = (): void => finish({ status: 'interrupted', turnId: undefined });
      const timer = setTimeout(
        () => finish({ status: 'unknown', reason: 'remote interrupt: no terminal event before deadline' }),
        REMOTE_INTERRUPT_COMPLETION_MS,
      );
      if (typeof timer.unref === 'function') timer.unref();
      this.once('complete', onTerminal);
      this.once('exit', onTerminal);
    });

    return { status: 'accepted', completion };
  }

  async terminate(graceful?: boolean): Promise<void> {
    const codexUsageCleanup = this.codexUsageCleanup;
    // Keep worker observation and its interaction/session identity until a stop
    // is acknowledged. The runtime fence prevents input and lifecycle recovery.
    markAdapterStopping(this);
    const interactionId = this.interactionId;
    const previous = this.previousAdapterPendingStop;
    if (previous) {
      const previousInstanceId = previous.remoteInstanceId;
      await previous.terminate(graceful);
      if (this.interactionId !== interactionId) return;
      if (this.previousAdapterPendingStop === previous) this.previousAdapterPendingStop = null;
      if (this.remoteInstanceId === previousInstanceId) this.remoteInstanceId = null;
    }
    if (!this.remoteInstanceId) {
      codexUsageCleanup?.();
      if (this.codexUsageCleanup === codexUsageCleanup) this.codexUsageCleanup = undefined;
      this.usageSettlement.settleAll();
      this.forceCleanup();
      return;
    }

    const instanceId = this.remoteInstanceId;
    try {
      await this.nodeConnection.sendRpc(
        this.targetNodeId,
        'instance.terminate',
        { instanceId },
      );
      if (this.interactionId === interactionId && this.remoteInstanceId === instanceId) this.remoteInstanceId = null;
      logger.info('Remote instance terminated', { nodeId: this.targetNodeId, instanceId });
    } catch (err) {
      logger.warn('Remote terminate RPC failed', {
        nodeId: this.targetNodeId,
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      if (!this.remoteInstanceId || this.codexUsageCleanup !== codexUsageCleanup) {
        codexUsageCleanup?.();
        if (this.codexUsageCleanup === codexUsageCleanup) this.codexUsageCleanup = undefined;
      }
      if (!this.remoteInstanceId) this.forceCleanup();
    }
  }

  /** Force cleanup after interrupted termination or error recovery. */
  forceCleanup(): void {
    this.previousAdapterPendingStop?.forceCleanup(); this.previousAdapterPendingStop = null;
    this.codexUsageCleanup?.(); this.codexUsageCleanup = undefined;
    this.usageSettlement.settleAll();
    this.remoteInstanceId = null;
    this.detachRegistryListeners();
  }

  // ---------------------------------------------------------------------------
  // Compatibility with CliAdapter interface (methods from BaseCliAdapter)
  // ---------------------------------------------------------------------------

  getName(): string {
    return `remote:${this.requestedCliType}`;
  }

  /** B9: this adapter delegates the real spawn to a worker node. */
  getSpawnMode(): CliSpawnMode {
    return 'remote';
  }

  async checkStatus(): Promise<{ available: boolean; error?: string }> {
    return { available: this.isRunning() };
  }

  getSessionId(): string | null {
    return this.providerSessionId ?? this.remoteInstanceId;
  }

  getPid(): number | null {
    return null; // No local process for remote instances
  }

  /** Ask the owning worker; its PID must never be inspected on the coordinator. */
  async sampleStallProcessFacts(silenceMs: number): Promise<StallProcessFacts | null> {
    return sampleRemoteStallProcessFacts(this.nodeConnection, this.registry, this.targetNodeId,
      () => ({ instanceId: this.remoteInstanceId, interactionId: this.interactionId }), silenceMs);
  }

  /** Worker adapter capabilities follow its CLI provider. */
  getRuntimeCapabilities(): AdapterRuntimeCapabilities {
    return remoteCliCapabilities(this.requestedCliType);
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  getRemoteInstanceId(): string | null {
    return this.remoteInstanceId;
  }

  getTargetNodeId(): string {
    return this.targetNodeId;
  }

  isRunning(): boolean {
    return this.remoteInstanceId !== null || this.previousAdapterPendingStop?.isRunning() === true;
  }

  // ---------------------------------------------------------------------------
  // Remote event handlers — called by connection server when output arrives
  // ---------------------------------------------------------------------------

  /** Record any sign of life from the remote turn (Phase 5 / D4). */
  private markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  /** Milliseconds since remote activity, or null before the first observation. */
  getMillisSinceLastActivity(): number | null {
    return this.lastActivityAt === null ? null : Date.now() - this.lastActivityAt;
  }

  handleRemoteOutput(message: OutputMessage): void {
    this.markActivity();
    this.emit('output', message);
  }

  handleRemoteExit(code: number | null, signal: string | null): void {
    this.codexUsageCleanup?.(); this.codexUsageCleanup = undefined;
    this.usageSettlement.settleAll();
    this.remoteInstanceId = null;
    this.detachRegistryListeners();
    if (this.previousAdapterPendingStop?.isRunning()) {
      markAdapterStopping(this);
      return; // Another potentially surviving runtime still needs an acknowledged stop.
    }
    this.emit('exit', code, signal);
  }

  handleRemoteStateChange(status: string): void {
    if (status === 'idle' || status === 'ready') this.providerTurn = null;
    this.markActivity();
    this.emit('stateChange', status);
    this.emit('status', status);
  }

  handleRemoteError(error: string): void {
    this.emit('error', new Error(error));
  }

  handleRemotePermissionRequest(payload: unknown): void {
    this.markActivity();
    const request = RemoteInputRequiredSchema.safeParse(payload);
    if (request.success && request.data.metadata?.['remoteInteractionId'] !== undefined && request.data.metadata['remoteInteractionId'] !== this.interactionId) return;
    if (request.success && this.pendingInputs.size < 64) this.pendingInputs.add(request.data.id);
    this.emit('input_required', payload);
  }

  handleRemoteContext(usage: unknown): void {
    if (!this.remoteInstanceId || !this.registryListenersAttached) return;
    this.markActivity();
    this.copilotUsage = this.requestedCliType === 'copilot' ? remoteContextDetails(usage).copilotUsage : undefined;
    this.emit('context', usage);
  }

  handleRemoteHeartbeat(): void {
    this.markActivity();
    this.emit('heartbeat');
  }

  handleRemoteComplete(response: CliResponse): void {
    this.markActivity();
    const semantic = this.usageSettlement.accept(response);
    if (semantic) { this.providerTurn = null; this.emit('complete', semantic); }
  }

  private matchesRemoteInstance(nodeId: string, instanceId: string): boolean {
    return (
      nodeId === this.targetNodeId &&
      this.remoteInstanceId !== null &&
      instanceId === this.remoteInstanceId
    );
  }

  private assertNotStopping(): void {
    if (isAdapterStopping(this)) throw new Error('The remote session is still stopping. Finish stopping it before starting more work.');
  }

  private attachRegistryListeners(): void {
    if (this.registryListenersAttached) {
      return;
    }

    this.registry.on('remote:instance-output', this.onRemoteOutputEvent);
    this.registry.on('remote:instance-state-change', this.onRemoteStateChangeEvent);
    this.registry.on('remote:instance-permission-request', this.onRemotePermissionRequestEvent);
    this.registry.on('remote:instance-context', this.onRemoteContextEvent);
    this.registry.on('remote:instance-heartbeat', this.onRemoteHeartbeatEvent);
    this.registry.on('remote:instance-complete', this.onRemoteCompleteEvent);
    this.registry.on('remote:instance-telemetry', this.onRemoteTelemetryEvent);
    this.registryListenersAttached = true;
  }

  private detachRegistryListeners(): void {
    this.copilotUsage = undefined;
    this.interactionId = randomUUID();
    this.spawnPending = false;
    this.contextDispatchPending = null;
    this.historyChunks.clear(); this.pendingHistoryReplay = null; this.historyReplayFailure = null;
    this.availableCommands = []; this.pendingInputs.clear(); this.providerSessionId = null; this.providerTurn = null;
    if (!this.registryListenersAttached) {
      return;
    }

    this.registry.off('remote:instance-output', this.onRemoteOutputEvent);
    this.registry.off('remote:instance-state-change', this.onRemoteStateChangeEvent);
    this.registry.off('remote:instance-permission-request', this.onRemotePermissionRequestEvent);
    this.registry.off('remote:instance-context', this.onRemoteContextEvent);
    this.registry.off('remote:instance-heartbeat', this.onRemoteHeartbeatEvent);
    this.registry.off('remote:instance-complete', this.onRemoteCompleteEvent);
    this.registry.off('remote:instance-telemetry', this.onRemoteTelemetryEvent);
    this.registryListenersAttached = false;
  }
}
