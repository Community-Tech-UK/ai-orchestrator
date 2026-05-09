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
import type { AdapterRuntimeCapabilities, InterruptResult } from './base-cli-adapter';
import type { FileAttachment, OutputMessage } from '../../../shared/types/instance.types';
import { getPauseCoordinator } from '../../pause/pause-coordinator';
import { OrchestratorPausedError } from '../../pause/orchestrator-paused-error';

const logger = getLogger('RemoteCliAdapter');

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

export class RemoteCliAdapter extends EventEmitter {
  private remoteInstanceId: string | null = null;
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
        },
      );

      // Update with the actual remote instance ID (should match sessionId)
      this.remoteInstanceId = response.instanceId;
      logger.info('Remote instance spawned', {
        nodeId: this.targetNodeId,
        instanceId: this.remoteInstanceId,
      });
      this.emit('spawned', -1);
      return -1; // No local PID for remote instances
    } catch (err) {
      // Spawn failed — clean up listeners to prevent memory leak
      this.remoteInstanceId = null;
      this.detachRegistryListeners();
      throw err;
    }
  }

  async sendInput(message: string, attachments?: FileAttachment[]): Promise<void> {
    if (!this.remoteInstanceId) {
      throw new Error('RemoteCliAdapter: not spawned — call spawn() before sendInput()');
    }
    if (getPauseCoordinator().isPaused()) {
      throw new OrchestratorPausedError('Remote input refused while orchestrator is paused');
    }

    await this.nodeConnection.sendRpc(
      this.targetNodeId,
      'instance.sendInput',
      {
        instanceId: this.remoteInstanceId,
        message,
        attachments,
      },
    );
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

    return { status: 'accepted' };
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

  handleRemoteOutput(message: OutputMessage): void {
    this.emit('output', message);
  }

  handleRemoteExit(code: number | null, signal: string | null): void {
    this.remoteInstanceId = null;
    this.detachRegistryListeners();
    this.emit('exit', code, signal);
  }

  handleRemoteStateChange(status: string): void {
    this.emit('stateChange', status);
    this.emit('status', status);
  }

  handleRemoteError(error: string): void {
    this.emit('error', new Error(error));
  }

  handleRemotePermissionRequest(payload: unknown): void {
    this.emit('input_required', payload);
  }

  handleRemoteContext(usage: unknown): void {
    this.emit('context', usage);
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
    this.registryListenersAttached = false;
  }
}
