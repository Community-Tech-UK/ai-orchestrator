import { randomUUID } from 'node:crypto';
import { Subject, type Observable } from 'rxjs';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { ProviderAdapter } from '@sdk/provider-adapter';
import type {
  PluginProviderAdapterBridge,
  PluginProviderAdapterDescriptor,
  PluginProviderAdapterFactory,
  PluginProviderId,
  ProviderAdapterPluginApi,
  RegisteredPluginProviderAdapter,
} from '@sdk/provider-adapter-registry';
import type {
  ProviderAttachment,
  ProviderCapabilities,
  ProviderConfig,
  ProviderSessionOptions,
  ProviderStatus,
  ProviderUsage,
} from '@shared/types/provider.types';

export type WorkerPluginProviderAdapterMethod =
  | 'getCapabilities'
  | 'checkStatus'
  | 'initialize'
  | 'sendMessage'
  | 'terminate'
  | 'getUsage'
  | 'getPid'
  | 'isRunning'
  | 'getSessionId';

export interface WorkerPluginProviderAdapterOperation {
  provider: PluginProviderId;
  factoryRef: string;
  adapterId: string;
  config: ProviderConfig;
  method: WorkerPluginProviderAdapterMethod;
  args: unknown[];
}

export interface WorkerPluginProviderAdapterSnapshot {
  providerCapabilities: ProviderCapabilities;
  usage: ProviderUsage | null;
  pid: number | null;
  running: boolean;
  sessionId: string;
}

export interface WorkerPluginProviderAdapterResponse {
  result?: unknown;
  snapshot: WorkerPluginProviderAdapterSnapshot;
}

export interface WorkerPluginProviderAdapterEventMessage {
  type: 'provider-event';
  adapterId: string;
  envelope: ProviderRuntimeEventEnvelope;
}

export type WorkerPluginProviderAdapterInvoker = (
  operation: WorkerPluginProviderAdapterOperation,
) => Promise<WorkerPluginProviderAdapterResponse>;

export type WorkerPluginProviderAdapterEventRegistrar = (
  adapterId: string,
  listener: (envelope: ProviderRuntimeEventEnvelope) => void,
) => () => void;

export interface WorkerPluginProviderAdapterBridgeOptions {
  invoke: WorkerPluginProviderAdapterInvoker;
  subscribeToEvents: WorkerPluginProviderAdapterEventRegistrar;
}

const EMPTY_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  toolExecution: false,
  streaming: false,
  multiTurn: false,
  vision: false,
  fileAttachments: false,
  functionCalling: false,
  builtInCodeTools: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function initialProviderCapabilities(
  descriptor: PluginProviderAdapterDescriptor,
  config: ProviderConfig,
): ProviderCapabilities {
  const modelCapabilities =
    config.models?.[0]?.capabilities ?? descriptor.defaultConfig.models?.[0]?.capabilities ?? {};
  return {
    ...EMPTY_PROVIDER_CAPABILITIES,
    ...modelCapabilities,
    streaming: modelCapabilities.streaming ?? descriptor.capabilities.streamingOutput,
    multiTurn: modelCapabilities.multiTurn ?? descriptor.capabilities.sessionResume,
    builtInCodeTools: modelCapabilities.builtInCodeTools ?? descriptor.capabilities.subAgents,
  };
}

class WorkerPluginProviderAdapterProxy implements ProviderAdapter {
  readonly provider: PluginProviderId;
  readonly capabilities;
  private readonly eventsSubject = new Subject<ProviderRuntimeEventEnvelope>();
  readonly events$: Observable<ProviderRuntimeEventEnvelope> = this.eventsSubject.asObservable();

  private providerCapabilities: ProviderCapabilities;
  private usage: ProviderUsage | null = null;
  private pid: number | null = null;
  private running = false;
  private sessionId = '';
  private readonly adapterId = randomUUID();
  private readonly unsubscribeEvents: () => void;
  private readonly descriptor: PluginProviderAdapterDescriptor;
  private readonly factoryRef: string;
  private readonly config: ProviderConfig;
  private readonly invoke: WorkerPluginProviderAdapterInvoker;

  constructor(
    descriptor: PluginProviderAdapterDescriptor,
    factoryRef: string,
    config: ProviderConfig,
    invoke: WorkerPluginProviderAdapterInvoker,
    subscribeToEvents: WorkerPluginProviderAdapterEventRegistrar,
  ) {
    this.descriptor = descriptor;
    this.factoryRef = factoryRef;
    this.config = config;
    this.invoke = invoke;
    this.provider = descriptor.provider;
    this.capabilities = descriptor.capabilities;
    this.providerCapabilities = initialProviderCapabilities(descriptor, config);
    this.unsubscribeEvents = subscribeToEvents(this.adapterId, (envelope) => {
      this.eventsSubject.next(envelope);
    });
  }

  getCapabilities(): ProviderCapabilities {
    return this.providerCapabilities;
  }

  async checkStatus(): Promise<ProviderStatus> {
    return this.callRemote<ProviderStatus>('checkStatus', []);
  }

  async initialize(options: ProviderSessionOptions): Promise<void> {
    await this.callRemote('initialize', [options]);
  }

  async sendMessage(message: string, attachments?: ProviderAttachment[]): Promise<void> {
    await this.callRemote('sendMessage', [message, attachments]);
  }

  async terminate(graceful?: boolean): Promise<void> {
    await this.callRemote('terminate', [graceful]);
    this.unsubscribeEvents();
    this.eventsSubject.complete();
  }

  getUsage(): ProviderUsage | null {
    return this.usage;
  }

  getPid(): number | null {
    return this.pid;
  }

  isRunning(): boolean {
    return this.running;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  private async callRemote<T = void>(
    method: WorkerPluginProviderAdapterMethod,
    args: unknown[],
  ): Promise<T> {
    const response = await this.invoke({
      provider: this.descriptor.provider,
      factoryRef: this.factoryRef,
      adapterId: this.adapterId,
      config: this.config,
      method,
      args,
    });
    this.applySnapshot(response.snapshot);
    return response.result as T;
  }

  private applySnapshot(snapshot: WorkerPluginProviderAdapterSnapshot): void {
    this.providerCapabilities = snapshot.providerCapabilities;
    this.usage = snapshot.usage;
    this.pid = snapshot.pid;
    this.running = snapshot.running;
    this.sessionId = snapshot.sessionId;
  }
}

export function createWorkerPluginProviderAdapterBridge(
  options: WorkerPluginProviderAdapterBridgeOptions,
): PluginProviderAdapterBridge {
  return {
    createProviderAdapter: (descriptor, factoryRef, config) =>
      new WorkerPluginProviderAdapterProxy(
        descriptor,
        factoryRef,
        config,
        options.invoke,
        options.subscribeToEvents,
      ),
  };
}

function validateWorkerProviderAdapter(
  expectedProvider: string,
  adapter: unknown,
): asserts adapter is ProviderAdapter {
  if (!isRecord(adapter)) {
    throw new Error('Provider adapter factory must return an object');
  }
  const methods = [
    'getCapabilities',
    'checkStatus',
    'initialize',
    'sendMessage',
    'terminate',
    'getUsage',
    'getPid',
    'isRunning',
    'getSessionId',
  ];
  for (const method of methods) {
    if (typeof adapter[method] !== 'function') {
      throw new Error(`Provider adapter is missing ${method}()`);
    }
  }
  if (adapter['provider'] !== expectedProvider) {
    throw new Error(`Provider adapter returned provider ${String(adapter['provider'])}, expected ${expectedProvider}`);
  }
  if (!isRecord(adapter['capabilities'])) {
    throw new Error('Provider adapter is missing adapter capabilities');
  }
  const events = adapter['events$'];
  if (!isRecord(events) || typeof events['subscribe'] !== 'function') {
    throw new Error('Provider adapter is missing events$ observable');
  }
}

function buildWorkerProviderSnapshot(adapter: ProviderAdapter): WorkerPluginProviderAdapterSnapshot {
  return {
    providerCapabilities: adapter.getCapabilities(),
    usage: adapter.getUsage(),
    pid: adapter.getPid(),
    running: adapter.isRunning(),
    sessionId: adapter.getSessionId(),
  };
}

export class WorkerPluginProviderAdapterRuntime {
  private readonly providerAdapters: RegisteredPluginProviderAdapter[] = [];
  private readonly factories = new Map<string, PluginProviderAdapterFactory>();
  private readonly instances = new Map<
    string,
    {
      adapter: ProviderAdapter;
      unsubscribe?: () => void;
    }
  >();
  private readonly postEvent: (message: WorkerPluginProviderAdapterEventMessage) => void;

  constructor(postEvent: (message: WorkerPluginProviderAdapterEventMessage) => void) {
    this.postEvent = postEvent;
  }

  get api(): ProviderAdapterPluginApi {
    return {
      registerProviderAdapterFactory: (factoryRef, factory) => {
        if (this.factories.has(factoryRef)) {
          throw new Error(`Provider adapter factory ${factoryRef} already registered`);
        }
        this.factories.set(factoryRef, factory);
      },
      registerProviderAdapter: (descriptor, factoryRef) => {
        this.providerAdapters.push({ descriptor, factoryRef });
      },
    };
  }

  listRegistrations(): readonly RegisteredPluginProviderAdapter[] {
    return this.providerAdapters.slice();
  }

  assertFactoriesAvailable(): void {
    for (const registration of this.providerAdapters) {
      if (!this.factories.has(registration.factoryRef)) {
        throw new Error(
          `Provider adapter ${registration.descriptor.provider} references missing factory ${registration.factoryRef}`,
        );
      }
    }
  }

  async invoke(operation: WorkerPluginProviderAdapterOperation): Promise<WorkerPluginProviderAdapterResponse> {
    const adapter = await this.getOrCreateAdapter(operation);
    let result: unknown;
    switch (operation.method) {
      case 'getCapabilities':
        result = adapter.getCapabilities();
        break;
      case 'checkStatus':
        result = await adapter.checkStatus();
        break;
      case 'initialize':
        await adapter.initialize(operation.args[0] as ProviderSessionOptions);
        break;
      case 'sendMessage':
        await adapter.sendMessage(operation.args[0] as string, operation.args[1] as ProviderAttachment[] | undefined);
        break;
      case 'terminate': {
        await adapter.terminate(operation.args[0] as boolean | undefined);
        const record = this.instances.get(operation.adapterId);
        record?.unsubscribe?.();
        this.instances.delete(operation.adapterId);
        break;
      }
      case 'getUsage':
        result = adapter.getUsage();
        break;
      case 'getPid':
        result = adapter.getPid();
        break;
      case 'isRunning':
        result = adapter.isRunning();
        break;
      case 'getSessionId':
        result = adapter.getSessionId();
        break;
    }

    return {
      result,
      snapshot: buildWorkerProviderSnapshot(adapter),
    };
  }

  private async getOrCreateAdapter(
    operation: WorkerPluginProviderAdapterOperation,
  ): Promise<ProviderAdapter> {
    const existing = this.instances.get(operation.adapterId);
    if (existing) {
      return existing.adapter;
    }

    const factory = this.factories.get(operation.factoryRef);
    if (!factory) {
      throw new Error(`Provider adapter factory ${operation.factoryRef} is not registered`);
    }
    const adapter = await factory(operation.config);
    try {
      validateWorkerProviderAdapter(operation.provider, adapter);
    } catch (error) {
      // The factory may already have spawned a live child process; make sure a
      // non-conforming adapter is torn down instead of leaking per attempt.
      await terminateAdapterQuietly(adapter);
      throw error;
    }
    const subscription = adapter.events$.subscribe({
      next: (envelope) => {
        this.postEvent({
          type: 'provider-event',
          adapterId: operation.adapterId,
          envelope,
        });
      },
    });
    this.instances.set(operation.adapterId, {
      adapter,
      unsubscribe: () => subscription.unsubscribe(),
    });
    return adapter;
  }

  /**
   * Unsubscribe and terminate every live adapter. Used by the worker's
   * graceful shutdown path as defense-in-depth so teardown does not rely
   * solely on `worker.terminate()`. Idempotent with per-adapter `terminate`:
   * entries are removed from the map before their adapters are torn down, and
   * failures in one adapter's cleanup never block the others.
   */
  async disposeAll(): Promise<void> {
    const records = Array.from(this.instances.values());
    this.instances.clear();
    await Promise.all(
      records.map(async (record) => {
        try {
          record.unsubscribe?.();
        } catch {
          /* intentionally ignored: unsubscribe failure must not block teardown */
        }
        await terminateAdapterQuietly(record.adapter);
      }),
    );
  }
}

/**
 * Best-effort terminate for an adapter that may not conform to the contract
 * (e.g. it just failed validation). Never throws.
 */
async function terminateAdapterQuietly(adapter: unknown): Promise<void> {
  if (!isRecord(adapter) || typeof adapter['terminate'] !== 'function') {
    return;
  }
  try {
    await (adapter as { terminate(graceful?: boolean): Promise<void> | void }).terminate(true);
  } catch {
    /* intentionally ignored: teardown of a failing adapter is best-effort */
  }
}
