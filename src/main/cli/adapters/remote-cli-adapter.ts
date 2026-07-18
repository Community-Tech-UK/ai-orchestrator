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
import { getLogger } from '../../logging/logger';
import type { WorkerNodeConnectionServer } from '../../remote-node/worker-node-connection';
import { getWorkerNodeRegistry } from '../../remote-node/worker-node-registry';
import type { CliType } from '../cli-detection';
import type { UnifiedSpawnOptions } from './adapter-factory';
import type { AdapterRuntimeCapabilities, CliResponse, CliSpawnMode, InterruptResult, ResumeAttemptResult, TurnInterruptCompletion } from './base-cli-adapter';
import type { FileAttachment, OutputMessage } from '../../../shared/types/instance.types';
import { getPauseCoordinator } from '../../pause/pause-coordinator';
import { OrchestratorPausedError } from '../../pause/orchestrator-paused-error';

const logger = getLogger('RemoteCliAdapter');

/**
 * Max time to wait for a terminal remote event after an interrupt before the
 * completion settles to `unknown` (Phase 5 / A2 for remote). Bounds the await so
 * the interrupt state machine never hangs on a wedged/silent worker.
 */
const REMOTE_INTERRUPT_COMPLETION_MS = 15_000;

interface SpawnResponse {
  instanceId: string;
}

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
  /** Latest resume proof relayed from the worker adapter (P2.9). */
  private lastResumeAttemptResult: ResumeAttemptResult | null = null;
  /**
   * Wall-clock of the last sign of life from the remote turn (Phase 5 / D4):
   * spawn, output, state-change, context, heartbeat, or complete. The idle
   * monitor reads `getMillisSinceLastActivity()` to detect a connected-but-wedged
   * worker whose turn-level heartbeat has gone stale.
   */
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
    if (!this.spawnOptions.sessionId) {
      throw new Error('RemoteCliAdapter requires spawnOptions.sessionId for remote execution');
    }
    if (!this.spawnOptions.workingDirectory) {
      throw new Error('RemoteCliAdapter requires spawnOptions.workingDirectory for remote execution');
    }

    // Set the expected remote instance ID and attach registry listeners BEFORE
    // sending the spawn RPC. This eliminates the window where early output from
    // the remote instance could be missed because listeners weren't registered yet.
    this.remoteInstanceId = this.spawnOptions.sessionId;
    this.attachRegistryListeners();

    try {
      const response = await this.nodeConnection.sendRpc<SpawnResponse>(
        this.targetNodeId,
        'instance.spawn',
        {
          instanceId: this.spawnOptions.sessionId,
          cliType: this.requestedCliType,
          workingDirectory: this.spawnOptions.workingDirectory,
          systemPrompt: this.spawnOptions.systemPrompt,
          model: this.spawnOptions.model,
          yoloMode: this.spawnOptions.yoloMode,
          allowedTools: this.spawnOptions.allowedTools,
          disallowedTools: this.spawnOptions.disallowedTools,
          resume: this.spawnOptions.resume,
          forkSession: this.spawnOptions.forkSession,
          mcpConfig: this.spawnOptions.mcpConfig,
          nodePlacement: this.spawnOptions.nodePlacement,
        },
      );

      // Update with the actual remote instance ID (should match sessionId)
      this.remoteInstanceId = response.instanceId;
      logger.info('Remote instance spawned', {
        nodeId: this.targetNodeId,
        instanceId: this.remoteInstanceId,
      });
      this.markActivity();
    } catch (err) {
      // The spawn RPC itself failed — the worker never acknowledged the child,
      // so reset the adapter and rethrow. A later rollback terminate() is then a
      // no-op (correct: there is no remote child to kill).
      this.remoteInstanceId = null;
      this.detachRegistryListeners();
      throw err;
    }

    // Fix C: emit OUTSIDE the try/catch. Once the worker has acknowledged the
    // spawn, `remoteInstanceId` must stay set until terminate() clears it — the
    // invariant that lets a rollback's adapter.terminate() reach the worker. A
    // throwing `spawned` listener (e.g. downstream strict schema validation on
    // the remote pid=-1 sentinel) previously landed in the catch above, nulled
    // `remoteInstanceId`, and orphaned the still-running remote child. Keeping
    // the emit here means a throwing listener no longer resets the adapter.
    this.emit('spawned', -1);
    return -1; // No local PID for remote instances
  }

  async sendInput(message: string, attachments?: FileAttachment[]): Promise<void> {
    if (!this.remoteInstanceId) {
      throw new Error('RemoteCliAdapter: not spawned — call spawn() before sendInput()');
    }
    if (getPauseCoordinator().isPaused()) {
      throw new OrchestratorPausedError('Remote input refused while orchestrator is paused');
    }

    // No RPC timeout: some worker-side adapters (notably the Codex app-server)
    // block inside sendInput() for the ENTIRE turn before responding, and turns
    // are unbounded in length. A fixed timeout would falsely fail healthy turns
    // that run longer than it — even though output streams back over separate
    // notifications meanwhile. Stuck turns are handled by the coordinator's own
    // stuck-process watchdog; a node disconnect rejects this RPC promptly.
    await this.nodeConnection.sendRpc(
      this.targetNodeId,
      'instance.sendInput',
      {
        instanceId: this.remoteInstanceId,
        message,
        attachments,
      },
      0,
    );
  }

  /**
   * P2.9: Resume proof proxied from the worker adapter. Without this, remote
   * resume health defaults to "succeeded on any output" with no session-id
   * confirmation (the remote half of B1). `null` until the worker relays proof.
   */
  getResumeAttemptResult(): ResumeAttemptResult | null {
    return this.lastResumeAttemptResult;
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

    // Phase 5 / A2-for-remote: return an ack PLUS a bounded completion that
    // settles when the remote turn reaches a terminal event (complete/exit), or
    // to `unknown` after a deadline — so the interrupt state machine never waits
    // forever on a wedged or silent worker.
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async terminate(graceful?: boolean): Promise<void> {
    // Always detach listeners, even if remoteInstanceId is null (defensive cleanup)
    this.detachRegistryListeners();

    if (!this.remoteInstanceId) return;

    const instanceId = this.remoteInstanceId;
    this.remoteInstanceId = null;

    try {
      await this.nodeConnection.sendRpc(
        this.targetNodeId,
        'instance.terminate',
        { instanceId },
      );
      logger.info('Remote instance terminated', { nodeId: this.targetNodeId, instanceId });
    } catch (err) {
      // Log but don't throw — caller needs cleanup to proceed regardless
      logger.warn('Remote terminate RPC failed', {
        nodeId: this.targetNodeId,
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Force cleanup of registry listeners. Call this if the adapter may not
   * be properly terminated (e.g., error recovery paths).
   */
  forceCleanup(): void {
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
    return { available: this.remoteInstanceId !== null };
  }

  getSessionId(): string | null {
    return this.remoteInstanceId;
  }

  getPid(): number | null {
    return null; // No local process for remote instances
  }

  /**
   * Report runtime capabilities based on the underlying CLI type.
   * Remote adapters proxy to a real CLI on the worker node — the capabilities
   * are determined by the CLI provider, not by the transport layer.
   */
  getRuntimeCapabilities(): AdapterRuntimeCapabilities {
    switch (this.requestedCliType) {
      case 'claude':
        return {
          supportsResume: true,
          supportsForkSession: true,
          // Remote proxies to a Claude CLI on the worker node, which runs in
          // headless `--input-format stream-json` mode. Slash commands are not
          // intercepted in that mode — there's no programmatic compaction hook
          // we can call. Mirror the local Claude adapter: no native hook, but
          // the remote Claude self-manages its own internal auto-compaction.
          supportsNativeCompaction: false,
          supportsPermissionPrompts: true,
          supportsDeferPermission: false, // Remote doesn't run local hooks
          selfManagedAutoCompaction: true,
        };
      case 'codex':
        return {
          supportsResume: true,
          supportsForkSession: false,
          supportsNativeCompaction: false,
          supportsPermissionPrompts: false,
          supportsDeferPermission: false,
          selfManagedAutoCompaction: false,
        };
      default:
        return {
          supportsResume: false,
          supportsForkSession: false,
          supportsNativeCompaction: false,
          supportsPermissionPrompts: false,
          supportsDeferPermission: false,
          selfManagedAutoCompaction: false,
        };
    }
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
    return this.remoteInstanceId !== null;
  }

  // ---------------------------------------------------------------------------
  // Remote event handlers — called by connection server when output arrives
  // ---------------------------------------------------------------------------

  /** Record any sign of life from the remote turn (Phase 5 / D4). */
  private markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  /**
   * Milliseconds since the last sign of life from the remote turn, or `null` if
   * no activity has been observed yet. Used by the idle monitor to detect a
   * connected-but-wedged worker (stale turn heartbeat).
   */
  getMillisSinceLastActivity(): number | null {
    return this.lastActivityAt === null ? null : Date.now() - this.lastActivityAt;
  }

  handleRemoteOutput(message: OutputMessage): void {
    this.markActivity();
    this.emit('output', message);
  }

  handleRemoteExit(code: number | null, signal: string | null): void {
    this.remoteInstanceId = null;
    this.detachRegistryListeners();
    this.emit('exit', code, signal);
  }

  handleRemoteStateChange(status: string): void {
    this.markActivity();
    this.emit('stateChange', status);
    this.emit('status', status);
  }

  handleRemoteError(error: string): void {
    this.emit('error', new Error(error));
  }

  handleRemotePermissionRequest(payload: unknown): void {
    this.markActivity();
    this.emit('input_required', payload);
  }

  handleRemoteContext(usage: unknown): void {
    this.markActivity();
    this.emit('context', usage);
  }

  handleRemoteHeartbeat(): void {
    this.markActivity();
    this.emit('heartbeat');
  }

  handleRemoteComplete(response: CliResponse): void {
    this.markActivity();
    this.emit('complete', response);
  }

  private matchesRemoteInstance(nodeId: string, instanceId: string): boolean {
    return (
      nodeId === this.targetNodeId &&
      this.remoteInstanceId !== null &&
      instanceId === this.remoteInstanceId
    );
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
    this.registryListenersAttached = true;
  }

  private detachRegistryListeners(): void {
    if (!this.registryListenersAttached) {
      return;
    }

    this.registry.off('remote:instance-output', this.onRemoteOutputEvent);
    this.registry.off('remote:instance-state-change', this.onRemoteStateChangeEvent);
    this.registry.off('remote:instance-permission-request', this.onRemotePermissionRequestEvent);
    this.registry.off('remote:instance-context', this.onRemoteContextEvent);
    this.registry.off('remote:instance-heartbeat', this.onRemoteHeartbeatEvent);
    this.registry.off('remote:instance-complete', this.onRemoteCompleteEvent);
    this.registryListenersAttached = false;
  }
}
