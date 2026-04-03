import { EventEmitter } from 'events';
import * as path from 'path';

export interface SpawnParams {
  instanceId: string;
  cliType: string;
  workingDirectory: string;
  systemPrompt?: string;
  model?: string;
  yoloMode?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface ManagedInstance {
  instanceId: string;
  cliType: string;
  workingDirectory: string;
  adapter: unknown; // CliAdapter — typed loosely to avoid Electron imports at compile time
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
    const adapter = createCliAdapter(params.cliType as Parameters<typeof createCliAdapter>[0], {
      sessionId: params.instanceId,
      workingDirectory: params.workingDirectory,
      systemPrompt: params.systemPrompt,
      model: params.model,
      yoloMode: params.yoloMode ?? true,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
    });

    // Wire adapter events to emit them on this manager
    const ad = adapter as EventEmitter;
    ad.on('output', (msg: unknown) => this.emit('instance:output', params.instanceId, msg));
    ad.on('exit', (info: unknown) => {
      this.instances.delete(params.instanceId);
      this.emit('instance:exit', params.instanceId, info);
    });
    ad.on('stateChange', (state: unknown) => this.emit('instance:stateChange', params.instanceId, state));

    // Spawn the process
    await (adapter as unknown as { spawn?: () => Promise<void> }).spawn?.();

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
    const adapter = inst.adapter as { sendInput?: (msg: string) => Promise<void>; sendMessage?: (msg: string) => Promise<void> };
    await (adapter.sendInput ?? adapter.sendMessage)?.call(adapter, message);
  }

  async terminate(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    const adapter = inst.adapter as { terminate?: () => Promise<void> };
    await adapter.terminate?.();
    this.instances.delete(instanceId);
  }

  async interrupt(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`Instance not found: ${instanceId}`);
    const adapter = inst.adapter as { interrupt?: () => Promise<void> };
    await adapter.interrupt?.();
  }

  async terminateAll(): Promise<void> {
    const ids = [...this.instances.keys()];
    await Promise.allSettled(ids.map((id) => this.terminate(id)));
  }
}
