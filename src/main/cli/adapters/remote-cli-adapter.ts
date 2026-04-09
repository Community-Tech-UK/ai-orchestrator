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
import type { FileAttachment, OutputMessage } from '../../../shared/types/instance.types';

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

    this.remoteInstanceId = response.instanceId;
    this.attachRegistryListeners();
    logger.info('Remote instance spawned', {
      nodeId: this.targetNodeId,
      instanceId: this.remoteInstanceId,
    });
    this.emit('spawned', -1);
    return -1; // No local PID for remote instances
  }

  async sendInput(message: string, attachments?: FileAttachment[]): Promise<void> {
    if (!this.remoteInstanceId) {
      throw new Error('RemoteCliAdapter: not spawned — call spawn() before sendInput()');
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
   * Interrupt the remote instance. Returns true if RPC was sent.
   * Synchronous return for compatibility with BaseCliAdapter.interrupt().
   */
  interrupt(): boolean {
    if (!this.remoteInstanceId) return false;

    // Fire-and-forget: send interrupt RPC without awaiting
    this.nodeConnection.sendRpc(
      this.targetNodeId,
      'instance.interrupt',
      { instanceId: this.remoteInstanceId },
    ).catch((err: Error) => {
      logger.warn('Failed to interrupt remote instance', { error: err.message });
    });

    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async terminate(graceful?: boolean): Promise<void> {
    if (!this.remoteInstanceId) return;

    const instanceId = this.remoteInstanceId;
    await this.nodeConnection.sendRpc(
      this.targetNodeId,
      'instance.terminate',
      { instanceId },
    );

    this.remoteInstanceId = null;
    this.detachRegistryListeners();
    logger.info('Remote instance terminated', { nodeId: this.targetNodeId, instanceId });
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
