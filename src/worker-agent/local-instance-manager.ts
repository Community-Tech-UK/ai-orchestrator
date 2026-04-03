import { EventEmitter } from 'events';
import * as path from 'path';
import type { CliType } from '../main/cli/cli-detection';

export interface SpawnParams {
  instanceId: string;
  cliType: CliType;
  workingDirectory: string;
  systemPrompt?: string;
  model?: string;
  yoloMode?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
}

type WorkerManagedAdapter = EventEmitter & {
  spawn: () => Promise<number | void>;
  sendInput: (message: string) => Promise<void>;
  terminate: (graceful?: boolean) => Promise<void>;
  interrupt: () => boolean | Promise<void>;
};

export interface ManagedInstance {
  instanceId: string;
  cliType: CliType;
  workingDirectory: string;
  adapter: WorkerManagedAdapter;
  createdAt: number;
}

/**
 * Manages CLI adapter instances on the worker machine.
 * Enforces working directory sandboxing and capacity limits.
 */
export class LocalInstanceManager extends EventEmitter {
  private readonly instances = new Map<string, ManagedInstance>();
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
    });

    // Wire adapter events to emit them on this manager
    adapter.on('output', (msg: unknown) => this.emit('instance:output', params.instanceId, msg));
    adapter.on('exit', (code: number | null, signal: string | null) => {
      this.instances.delete(params.instanceId);
      this.emit('instance:exit', params.instanceId, { code, signal });
    });
    adapter.on('status', (state: unknown) => this.emit('instance:stateChange', params.instanceId, state));
    adapter.on('input_required', (permission: unknown) => {
      this.emit('instance:permissionRequest', params.instanceId, permission);
    });

    // Spawn the process
    await adapter.spawn();

    this.instances.set(params.instanceId, {
      instanceId: params.instanceId,
      cliType: params.cliType,
      workingDirectory: params.workingDirectory,
      adapter,
      createdAt: Date.now(),
    });
  }

  async sendInput(instanceId: string, message: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`Instance not found: ${instanceId}`);
    await inst.adapter.sendInput(message);
  }

  async terminate(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    await inst.adapter.terminate();
    this.instances.delete(instanceId);
  }

  async interrupt(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`Instance not found: ${instanceId}`);
    await inst.adapter.interrupt();
  }

  async terminateAll(): Promise<void> {
    const ids = [...this.instances.keys()];
    await Promise.allSettled(ids.map((id) => this.terminate(id)));
  }
}
