import { EventEmitter } from 'events';
import { getLogger } from '../../logging/logger';
import type { WorkerNodeConnectionServer } from '../../remote-node/worker-node-connection';
import { getWorkerNodeRegistry } from '../../remote-node/worker-node-registry';
import { COORDINATOR_TO_NODE } from '../../remote-node/worker-node-rpc';
import { getPauseCoordinator } from '../../pause/pause-coordinator';
import { OrchestratorPausedError } from '../../pause/orchestrator-paused-error';
import type {
  AdapterRuntimeCapabilities,
  CliCapabilities,
  CliResponse,
  CliSpawnMode,
  InterruptResult,
  TurnInterruptCompletion,
} from './base-cli-adapter';
import type { FileAttachment, OutputMessage } from '../../../shared/types/instance.types';
import type {
  LocalModelEndpointProvider,
  ModelRuntimeTarget,
} from '../../../shared/types/local-model-runtime.types';
import type { UnifiedSpawnOptions } from './adapter-factory.types';

const logger = getLogger('RemoteLocalModelAdapter');
const REMOTE_LOCAL_MODEL_INTERRUPT_COMPLETION_MS = 15_000;

export type RemoteLocalModelRuntimeTarget = ModelRuntimeTarget & {
  kind: 'local-model';
  source: 'worker-node';
  nodeId: string;
};

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

export class RemoteLocalModelAdapter extends EventEmitter {
  private remoteSessionId: string | null = null;
  private registryListenersAttached = false;
  private lastActivityAt: number | null = null;
  private readonly registry = getWorkerNodeRegistry();
  private readonly nodeConnection: WorkerNodeConnectionServer;
  private readonly target: RemoteLocalModelRuntimeTarget;
  private readonly spawnOptions: UnifiedSpawnOptions;

  private readonly onRemoteOutputEvent = (event: RemoteOutputEvent): void => {
    if (this.matchesRemoteSession(event.nodeId, event.instanceId)) {
      this.handleRemoteOutput(event.message);
    }
  };

  private readonly onRemoteStateChangeEvent = (event: RemoteStateChangeEvent): void => {
    if (!this.matchesRemoteSession(event.nodeId, event.instanceId)) {
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

  private readonly onRemoteContextEvent = (event: RemoteContextEvent): void => {
    if (this.matchesRemoteSession(event.nodeId, event.instanceId)) {
      this.markActivity();
      this.emit('context', event.usage);
    }
  };

  private readonly onRemoteHeartbeatEvent = (event: RemoteHeartbeatEvent): void => {
    if (this.matchesRemoteSession(event.nodeId, event.instanceId)) {
      this.markActivity();
      this.emit('heartbeat');
    }
  };

  private readonly onRemoteCompleteEvent = (event: RemoteCompleteEvent): void => {
    if (this.matchesRemoteSession(event.nodeId, event.instanceId)) {
      this.markActivity();
      this.emit('complete', event.response);
    }
  };

  constructor(
    nodeConnection: WorkerNodeConnectionServer,
    target: RemoteLocalModelRuntimeTarget,
    spawnOptions: UnifiedSpawnOptions,
  );
  constructor(
    nodeConnection: WorkerNodeConnectionServer,
    targetNodeId: string,
    target: RemoteLocalModelRuntimeTarget,
    spawnOptions: UnifiedSpawnOptions,
  );
  constructor(
    nodeConnection: WorkerNodeConnectionServer,
    targetOrNodeId: RemoteLocalModelRuntimeTarget | string,
    targetOrSpawnOptions: RemoteLocalModelRuntimeTarget | UnifiedSpawnOptions,
    maybeSpawnOptions?: UnifiedSpawnOptions,
  ) {
    super();
    this.nodeConnection = nodeConnection;
    if (typeof targetOrNodeId === 'string') {
      this.target = {
        ...(targetOrSpawnOptions as RemoteLocalModelRuntimeTarget),
        nodeId: targetOrNodeId,
      };
      this.spawnOptions = maybeSpawnOptions ?? {};
      return;
    }
    this.target = targetOrNodeId;
    this.spawnOptions = targetOrSpawnOptions as UnifiedSpawnOptions;
  }

  async spawn(): Promise<number> {
    if (!this.spawnOptions.sessionId) {
      throw new Error('RemoteLocalModelAdapter requires spawnOptions.sessionId for remote execution');
    }

    this.remoteSessionId = this.spawnOptions.sessionId;
    this.attachRegistryListeners();

    try {
      const response = await this.nodeConnection.sendRpc<{ sessionId: string }>(
        this.target.nodeId,
        COORDINATOR_TO_NODE.LOCAL_MODEL_SESSION_START,
        {
          sessionId: this.spawnOptions.sessionId,
          endpointProvider: this.target.endpointProvider,
          endpointId: this.target.endpointId,
          modelId: this.target.modelId,
          workingDirectory: this.spawnOptions.workingDirectory,
          systemPrompt: this.spawnOptions.systemPrompt,
        },
      );
      this.remoteSessionId = response.sessionId;
      this.markActivity();
      this.emit('spawned', -1);
      return -1;
    } catch (error) {
      this.remoteSessionId = null;
      this.detachRegistryListeners();
      throw error;
    }
  }

  async sendInput(message: string, attachments?: FileAttachment[]): Promise<void> {
    if (!this.remoteSessionId) {
      throw new Error('RemoteLocalModelAdapter: not spawned - call spawn() before sendInput()');
    }
    if (getPauseCoordinator().isPaused()) {
      throw new OrchestratorPausedError('Remote local model input refused while orchestrator is paused');
    }
    if (attachments && attachments.length > 0) {
      throw new Error('Remote local model does not currently support attachments in orchestrator mode.');
    }

    await this.nodeConnection.sendRpc(
      this.target.nodeId,
      COORDINATOR_TO_NODE.LOCAL_MODEL_SESSION_SEND_INPUT,
      {
        sessionId: this.remoteSessionId,
        message,
        attachments,
      },
      0,
    );
  }

  interrupt(): InterruptResult {
    if (!this.remoteSessionId) {
      return { status: 'already-idle', reason: 'No remote local-model session is attached' };
    }
    if (!this.nodeConnection.isNodeConnected(this.target.nodeId)) {
      return { status: 'rejected', reason: 'Remote node is disconnected' };
    }

    const sessionId = this.remoteSessionId;
    this.nodeConnection.sendRpc(
      this.target.nodeId,
      COORDINATOR_TO_NODE.LOCAL_MODEL_SESSION_INTERRUPT,
      { sessionId },
    ).catch((error: Error) => {
      logger.warn('Failed to interrupt remote local-model session', {
        nodeId: this.target.nodeId,
        sessionId,
        error: error.message,
      });
      this.emit('error', new Error(`Remote local-model interrupt failed: ${error.message}`));
    });

    return { status: 'accepted', completion: this.waitForInterruptCompletion() };
  }

  async terminate(): Promise<void> {
    this.detachRegistryListeners();
    if (!this.remoteSessionId) {
      return;
    }

    const sessionId = this.remoteSessionId;
    this.remoteSessionId = null;
    try {
      await this.nodeConnection.sendRpc(
        this.target.nodeId,
        COORDINATOR_TO_NODE.LOCAL_MODEL_SESSION_TERMINATE,
        { sessionId },
      );
    } catch (error) {
      logger.warn('Remote local-model terminate RPC failed', {
        nodeId: this.target.nodeId,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  forceCleanup(): void {
    this.remoteSessionId = null;
    this.detachRegistryListeners();
  }

  getName(): string {
    return `remote-local-model:${this.target.endpointProvider}`;
  }

  getCapabilities(): CliCapabilities {
    return {
      streaming: true,
      toolUse: false,
      fileAccess: false,
      shellExecution: false,
      multiTurn: true,
      vision: false,
      codeExecution: false,
      contextWindow: 32_768,
      outputFormats: ['text', 'markdown'],
    };
  }

  getSpawnMode(): CliSpawnMode {
    return 'remote';
  }

  async checkStatus(): Promise<{ available: boolean; authenticated?: boolean; error?: string }> {
    return {
      available: this.remoteSessionId !== null && this.nodeConnection.isNodeConnected(this.target.nodeId),
      authenticated: true,
    };
  }

  getRuntimeCapabilities(): AdapterRuntimeCapabilities {
    return {
      supportsResume: false,
      supportsForkSession: false,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
      selfManagedAutoCompaction: false,
    };
  }

  getEndpointProvider(): LocalModelEndpointProvider {
    return this.target.endpointProvider;
  }

  getModelId(): string {
    return this.target.modelId;
  }

  getSessionId(): string | null {
    return this.remoteSessionId;
  }

  getRemoteSessionId(): string | null {
    return this.remoteSessionId;
  }

  getPid(): number | null {
    return null;
  }

  getTargetNodeId(): string {
    return this.target.nodeId;
  }

  isRunning(): boolean {
    return this.remoteSessionId !== null;
  }

  getMillisSinceLastActivity(): number | null {
    return this.lastActivityAt === null ? null : Date.now() - this.lastActivityAt;
  }

  handleRemoteOutput(message: OutputMessage): void {
    this.markActivity();
    this.emit('output', message);
  }

  handleRemoteStateChange(status: string): void {
    this.markActivity();
    this.emit('stateChange', status);
    this.emit('status', status);
  }

  handleRemoteExit(code: number | null, signal: string | null): void {
    this.remoteSessionId = null;
    this.detachRegistryListeners();
    this.emit('exit', code, signal);
  }

  private waitForInterruptCompletion(): Promise<TurnInterruptCompletion> {
    return new Promise<TurnInterruptCompletion>((resolve) => {
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
        () => finish({ status: 'unknown', reason: 'remote local-model interrupt: no terminal event before deadline' }),
        REMOTE_LOCAL_MODEL_INTERRUPT_COMPLETION_MS,
      );
      if (typeof timer.unref === 'function') timer.unref();
      this.once('complete', onTerminal);
      this.once('exit', onTerminal);
    });
  }

  private matchesRemoteSession(nodeId: string, instanceId: string): boolean {
    return nodeId === this.target.nodeId &&
      this.remoteSessionId !== null &&
      instanceId === this.remoteSessionId;
  }

  private markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  private attachRegistryListeners(): void {
    if (this.registryListenersAttached) {
      return;
    }
    this.registry.on('remote:instance-output', this.onRemoteOutputEvent);
    this.registry.on('remote:instance-state-change', this.onRemoteStateChangeEvent);
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
    this.registry.off('remote:instance-context', this.onRemoteContextEvent);
    this.registry.off('remote:instance-heartbeat', this.onRemoteHeartbeatEvent);
    this.registry.off('remote:instance-complete', this.onRemoteCompleteEvent);
    this.registryListenersAttached = false;
  }
}
