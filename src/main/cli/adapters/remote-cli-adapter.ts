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
import type { CliType } from '../cli-detection';
import type { UnifiedSpawnOptions } from './adapter-factory';
import type { FileAttachment } from '../../../shared/types/instance.types';

const logger = getLogger('RemoteCliAdapter');

interface SpawnResponse {
  instanceId: string;
}

interface RemoteOutputMessage {
  type: string;
  content: string;
  timestamp: number;
}

export class RemoteCliAdapter extends EventEmitter {
  private remoteInstanceId: string | null = null;

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
    const response = await this.nodeConnection.sendRpc<SpawnResponse>(
      this.targetNodeId,
      'instance.spawn',
      {
        requestedCliType: this.requestedCliType,
        options: this.spawnOptions,
      },
    );

    this.remoteInstanceId = response.instanceId;
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

  handleRemoteOutput(message: RemoteOutputMessage): void {
    this.emit('output', message);
  }

  handleRemoteExit(code: number): void {
    this.remoteInstanceId = null;
    this.emit('exit', { code });
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
}
