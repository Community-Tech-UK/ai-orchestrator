import { EventEmitter } from 'events';
import * as path from 'path';
import type { CliType } from '../main/cli/cli-detection';
import type { InterruptResult } from '../main/cli/adapters/base-cli-adapter';
import type { FileAttachment } from '../shared/types/instance.types';
import { observeAdapterRuntimeEvents } from '../main/providers/adapter-runtime-event-bridge';
import { toOutputMessageFromProviderOutputEvent } from '../main/providers/provider-output-event';

const ACTIVITY_WATCHDOG_INTERVAL_MS = 5_000;

export interface SpawnParams {
  instanceId: string;
  cliType: CliType;
  workingDirectory: string;
  systemPrompt?: string;
  model?: string;
  yoloMode?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  resume?: boolean;
  forkSession?: boolean;
  mcpConfig?: string[];
}

type WorkerManagedAdapter = EventEmitter & {
  spawn: () => Promise<number | void>;
  sendInput: (message: string, attachments?: FileAttachment[]) => Promise<void>;
  terminate: (graceful?: boolean) => Promise<void>;
  interrupt: () => InterruptResult | Promise<void>;
};

export interface ManagedInstance {
  instanceId: string;
  cliType: CliType;
  workingDirectory: string;
  spawnParams: SpawnParams;
  adapter: WorkerManagedAdapter;
  runtimeObserverCleanup: () => void;
  createdAt: number;
  watchdogTimer: ReturnType<typeof setInterval> | null;
  /** Last known adapter status — used to suppress stale watchdog/stream:idle events */
  lastStatus: string;
}

/**
 * Manages CLI adapter instances on the worker machine.
 * Enforces working directory sandboxing and capacity limits.
 */
export class LocalInstanceManager extends EventEmitter {
  private readonly instances = new Map<string, ManagedInstance>();
  private readonly hibernatedInstances = new Map<string, SpawnParams>();
  private readonly allowedDirs: string[];
  private readonly maxInstances: number;

  constructor(allowedDirs: string[], maxInstances = 10) {
    super();
    this.allowedDirs = allowedDirs.map((d) => path.resolve(d));
    this.maxInstances = maxInstances;
  }

  getInstanceCount(): number {
    return this.instances.size;
  }

  getAllInstanceIds(): string[] {
    return [...this.instances.keys()];
  }

  getInstance(instanceId: string): ManagedInstance | undefined {
    return this.instances.get(instanceId);
  }

  private startWatchdog(instanceId: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    this.resetWatchdog(instanceId);
  }

  private resetWatchdog(instanceId: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;

    if (inst.watchdogTimer) {
      clearInterval(inst.watchdogTimer);
    }

    inst.watchdogTimer = setInterval(() => {
      if (this.instances.has(instanceId)) {
        this.emit('instance:stateChange', instanceId, 'processing');
      }
    }, ACTIVITY_WATCHDOG_INTERVAL_MS);

    if (inst.watchdogTimer.unref) {
      inst.watchdogTimer.unref();
    }
  }

  private clearWatchdog(instanceId: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst?.watchdogTimer) return;
    clearInterval(inst.watchdogTimer);
    inst.watchdogTimer = null;
  }

  async spawn(params: SpawnParams): Promise<void> {
    // Enforce working directory sandboxing
    const resolved = path.resolve(params.workingDirectory);
    const isAllowed = this.allowedDirs.some(
      (allowed) => resolved === allowed || resolved.startsWith(allowed + path.sep),
    );
    if (!isAllowed) {
      throw new Error(
        `Working directory "${params.workingDirectory}" is not in allowed working directories: ${this.allowedDirs.join(', ')}`,
      );
    }

    // Enforce capacity limit
    if (this.instances.size >= this.maxInstances) {
      throw new Error(`Worker at capacity (${this.maxInstances} instances)`);
    }

    // Dynamic import to avoid pulling in Electron at module load time.
    // In the bundled worker agent, the adapter factory is tree-shaken to
    // only include the CLI adapters that are used.
    const { createCliAdapter } = await import('../main/cli/adapters/adapter-factory');
    const adapter: WorkerManagedAdapter = createCliAdapter(params.cliType, {
      sessionId: params.instanceId,
      workingDirectory: params.workingDirectory,
      systemPrompt: params.systemPrompt,
      model: params.model,
      yoloMode: params.yoloMode ?? true,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      resume: params.resume,
      forkSession: params.forkSession,
      mcpConfig: params.mcpConfig,
    });

    let runtimeObserverCleanup: () => void = () => undefined;
    runtimeObserverCleanup = observeAdapterRuntimeEvents(adapter, ({ event, eventId, timestamp }) => {
      switch (event.kind) {
        case 'output': {
          const inst = this.instances.get(params.instanceId);
          // Only reset watchdog if instance is busy — output can arrive after
          // the idle event due to buffering, and resetting the watchdog would
          // restart the 5s processing timer that overrides idle.
          if (inst && inst.lastStatus !== 'idle' && inst.lastStatus !== 'ready' && inst.lastStatus !== 'waiting_for_input') {
            this.resetWatchdog(params.instanceId);
          }
          this.emit(
            'instance:output',
            params.instanceId,
            toOutputMessageFromProviderOutputEvent(event, { eventId, timestamp }),
          );
          break;
        }
        case 'exit':
          runtimeObserverCleanup();
          this.clearWatchdog(params.instanceId);
          this.instances.delete(params.instanceId);
          this.emit('instance:exit', params.instanceId, { code: event.code, signal: event.signal });
          break;
        case 'status': {
          const inst = this.instances.get(params.instanceId);
          if (inst) {
            inst.lastStatus = event.status;
          }
          if (event.status === 'idle' || event.status === 'ready' || event.status === 'waiting_for_input') {
            this.clearWatchdog(params.instanceId);
          } else {
            this.resetWatchdog(params.instanceId);
          }
          this.emit('instance:stateChange', params.instanceId, event.status);
          break;
        }
        case 'context':
          this.emit('instance:context', params.instanceId, {
            used: event.used,
            total: event.total,
            percentage: event.percentage,
          });
          break;
        default:
          break;
      }
    });

    adapter.on('input_required', (permission: unknown) => {
      this.emit('instance:permissionRequest', params.instanceId, permission);
    });
    adapter.on('stream:idle', () => {
      const inst = this.instances.get(params.instanceId);
      // Only emit thinking_deeply if the instance is actually busy.
      // After a response completes, the stream goes quiet but that's normal
      // idle behavior, not deep thinking.
      if (inst && inst.lastStatus !== 'idle' && inst.lastStatus !== 'ready' && inst.lastStatus !== 'waiting_for_input') {
        this.clearWatchdog(params.instanceId);
        this.emit('instance:stateChange', params.instanceId, 'thinking_deeply');
      }
    });

    // Spawn the process
    try {
      await adapter.spawn();
    } catch (error) {
      runtimeObserverCleanup();
      throw error;
    }

    this.instances.set(params.instanceId, {
      instanceId: params.instanceId,
      cliType: params.cliType,
      workingDirectory: params.workingDirectory,
      spawnParams: { ...params },
      adapter,
      runtimeObserverCleanup,
      createdAt: Date.now(),
      watchdogTimer: null,
      lastStatus: 'busy',
    });

    this.startWatchdog(params.instanceId);
  }

  async sendInput(instanceId: string, message: string, attachments?: FileAttachment[]): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`Instance not found: ${instanceId}`);
    console.log('[LocalInstanceManager] sendInput', {
      instanceId,
      messageLength: message?.length,
      attachmentsCount: attachments?.length ?? 0,
      attachmentTypes: attachments?.map(a => a.type),
      attachmentDataLengths: attachments?.map(a => a.data?.length ?? 0),
    });
    await inst.adapter.sendInput(message, attachments);
  }

  async terminate(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    this.clearWatchdog(instanceId);
    inst.runtimeObserverCleanup();
    await inst.adapter.terminate();
    this.instances.delete(instanceId);
  }

  async interrupt(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`Instance not found: ${instanceId}`);
    await inst.adapter.interrupt();
  }

  async hibernate(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`Instance not found: ${instanceId}`);
    this.hibernatedInstances.set(instanceId, {
      ...inst.spawnParams,
      resume: true,
    });
    await this.terminate(instanceId);
  }

  async wake(instanceId: string): Promise<void> {
    if (this.instances.has(instanceId)) {
      return;
    }
    const spawnParams = this.hibernatedInstances.get(instanceId);
    if (!spawnParams) {
      throw new Error(`Hibernated instance not found: ${instanceId}`);
    }
    this.hibernatedInstances.delete(instanceId);
    await this.spawn({
      ...spawnParams,
      resume: true,
    });
  }

  async terminateAll(): Promise<void> {
    const ids = [...this.instances.keys()];
    for (const id of ids) {
      this.clearWatchdog(id);
    }
    this.hibernatedInstances.clear();
    await Promise.allSettled(ids.map((id) => this.terminate(id)));
  }
}
