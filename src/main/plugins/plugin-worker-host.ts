import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkerPluginModule } from './plugin-worker-module';
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from 'node:worker_threads';
import type {
  PluginProviderAdapterDescriptor,
  PluginProviderAdapterBridge,
  PluginProviderId,
  ProviderAdapterPluginApi,
  RegisteredPluginProviderAdapter,
} from '@sdk/provider-adapter-registry';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type {
  WorkerPluginProviderAdapterEventMessage,
  WorkerPluginProviderAdapterOperation,
  WorkerPluginProviderAdapterResponse,
  WorkerPluginProviderAdapterRuntime,
} from '@sdk/provider-adapter-worker-bridge';
import type {
  NotifierPlugin,
  PluginHookEvent,
  PluginSlot,
  PluginTelemetryRecord,
  PluginTrackerEvent,
  TelemetryExporterPlugin,
  TrackerPlugin,
  TypedOrchestratorHooks,
} from '../../shared/types/plugin.types';

const DEFAULT_WORKER_RPC_TIMEOUT_MS = 5_000;

export interface PluginWorkerContext {
  appPath: string;
  homeDir: string | null;
}

export interface PluginWorkerHostOptions {
  filePath: string;
  context: PluginWorkerContext;
  requestedSlot?: PluginSlot;
  providerAdapterApi?: ProviderAdapterPluginApi;
  workerFactory?: (workerData: PluginWorkerData) => Worker;
  rpcTimeoutMs?: number;
}

export interface PluginWorkerRuntime {
  slot: PluginSlot;
  detected: boolean;
  ready: boolean;
  providerAdapters: readonly RegisteredPluginProviderAdapter[];
  hooks: TypedOrchestratorHooks;
  notifier?: NotifierPlugin;
  tracker?: TrackerPlugin;
  telemetryExporter?: TelemetryExporterPlugin;
}

interface PluginWorkerData {
  filePath: string;
  context: PluginWorkerContext;
  requestedSlot?: PluginSlot;
  providerBridgeEntrypoint: string;
  /** Resolved main-side (workers have no `__dirname` under the tsx ESM hook). */
  workerHelperEntrypoint: string;
}

type PluginWorkerOperation =
  | { kind: 'hook'; event: PluginHookEvent; payload: unknown }
  | { kind: 'notifier'; payload: unknown }
  | { kind: 'tracker'; payload: unknown }
  | { kind: 'telemetry_exporter'; payload: unknown }
  | { kind: 'provider_adapter'; operation: WorkerPluginProviderAdapterOperation };

type PluginWorkerInboundMessage =
  | { type: 'invoke'; id: number; operation: PluginWorkerOperation }
  | { type: 'shutdown'; id: number };

type PluginWorkerOutboundMessage =
  | {
      type: 'ready';
      slot: PluginSlot;
      detected: boolean;
      ready: boolean;
      hookKeys: PluginHookEvent[];
      providerAdapters?: readonly RegisteredPluginProviderAdapter[];
    }
  | { type: 'startup-error'; error: string }
  | { type: 'rpc-response'; id: number; result?: unknown; error?: string }
  | {
      type: 'provider-event';
      adapterId: string;
      envelope: ProviderRuntimeEventEnvelope;
    };

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

type HostProviderAdapterApi = ProviderAdapterPluginApi & {
  registerPluginProviderAdapter?: (descriptor: PluginProviderAdapterDescriptor, factoryRef: string, bridge: PluginProviderAdapterBridge) => void;
  unregisterPluginProviderAdapter?: (provider: PluginProviderId) => void;
};

/**
 * Task 17: decide the worker's `execArgv`. tsx must be registered when EITHER the
 * worker-host entrypoint is TypeScript (dev build) OR the plugin loaded inside
 * the worker is a `.ts`/`.mts`/`.cts` file — TS plugins are worker-only precisely
 * because the packaged `.js` host would otherwise `import()` the plugin with no
 * TypeScript loader and fail. Pure + exported for testing.
 */
export function resolveWorkerExecArgv(hostEntrypoint: string, pluginFilePath: string): string[] {
  const isTs = (p: string): boolean => {
    const lower = p.toLowerCase();
    return lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts');
  };
  return isTs(hostEntrypoint) || isTs(pluginFilePath) ? ['--import', 'tsx'] : [];
}

function createDefaultWorker(workerDataValue: PluginWorkerData): Worker {
  const entrypoint = resolveWorkerEntrypoint();
  return new Worker(entrypoint, {
    workerData: workerDataValue,
    execArgv: resolveWorkerExecArgv(entrypoint, workerDataValue.filePath),
  });
}

function resolveWorkerEntrypoint(): string {
  const jsEntrypoint = path.join(__dirname, 'plugin-worker-host.js');
  if (existsSync(jsEntrypoint)) {
    return jsEntrypoint;
  }
  const tsEntrypoint = path.join(__dirname, 'plugin-worker-host.ts');
  if (existsSync(tsEntrypoint)) {
    return tsEntrypoint;
  }
  return __filename;
}

type ProviderAdapterBridgeModule = typeof import('@sdk/provider-adapter-worker-bridge');

let providerAdapterBridgeModulePromise: Promise<ProviderAdapterBridgeModule> | null = null;

function resolveProviderAdapterBridgeEntrypoint(): string {
  const relativeParts = ['..', '..', '..', 'packages', 'sdk', 'src', 'provider-adapter-worker-bridge'];
  const jsEntrypoint = path.join(__dirname, ...relativeParts) + '.js';
  if (existsSync(jsEntrypoint)) {
    return jsEntrypoint;
  }
  return path.join(__dirname, ...relativeParts) + '.ts';
}

function loadProviderAdapterBridgeModule(entrypoint = resolveProviderAdapterBridgeEntrypoint()): Promise<ProviderAdapterBridgeModule> {
  providerAdapterBridgeModulePromise ??= import(
    pathToFileURL(entrypoint).href
  ) as Promise<ProviderAdapterBridgeModule>;
  return providerAdapterBridgeModulePromise;
}

// The worker-thread entrypoint cannot use static relative runtime imports:
// the tsx hook registered via `--import tsx` in worker execArgv does not
// resolve them for the entrypoint's own module graph. Mirror the bridge
// loader above: resolve an explicit .js/.ts path main-side (workers have no
// `__dirname`), pass it through workerData, and dynamic-import it.
type WorkerHelperModule = typeof import('./plugin-worker-module');

let workerHelperModulePromise: Promise<WorkerHelperModule> | null = null;

function resolveWorkerHelperEntrypoint(): string {
  const base = path.join(__dirname, 'plugin-worker-module');
  return existsSync(`${base}.js`) ? `${base}.js` : `${base}.ts`;
}

function loadWorkerHelperModule(entrypoint: string): Promise<WorkerHelperModule> {
  workerHelperModulePromise ??= import(
    pathToFileURL(entrypoint).href
  ) as Promise<WorkerHelperModule>;
  return workerHelperModulePromise;
}

export class PluginWorkerHost {
  private worker: Worker | null = null;
  private nextRpcId = 0;
  private readonly pending = new Map<number, PendingRpc>();
  private readonly providerEventSinks = new Map<
    string,
    Set<(envelope: ProviderRuntimeEventEnvelope) => void>
  >();
  private readonly registeredProviderAdapterIds = new Set<PluginProviderId>();
  private runtime: PluginWorkerRuntime | null = null;
  private readonly rpcTimeoutMs: number;
  private readonly workerFactory: (workerData: PluginWorkerData) => Worker;
  private readonly options: PluginWorkerHostOptions;

  constructor(options: PluginWorkerHostOptions) {
    this.options = options;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_WORKER_RPC_TIMEOUT_MS;
    this.workerFactory = options.workerFactory ?? createDefaultWorker;
  }

  async start(): Promise<PluginWorkerRuntime> {
    if (this.runtime) {
      return this.runtime;
    }
    if (this.worker) {
      throw new Error('Plugin worker is already starting');
    }

    const workerDataValue: PluginWorkerData = {
      filePath: this.options.filePath,
      context: this.options.context,
      providerBridgeEntrypoint: resolveProviderAdapterBridgeEntrypoint(),
      workerHelperEntrypoint: resolveWorkerHelperEntrypoint(),
      ...(this.options.requestedSlot ? { requestedSlot: this.options.requestedSlot } : {}),
    };
    const worker = this.workerFactory(workerDataValue);
    this.worker = worker;

    const runtime = await new Promise<PluginWorkerRuntime>(
      (resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          clearTimeout(startupTimeout);
          worker.off('message', onReadyMessage);
          worker.off('error', onStartupError);
          worker.off('exit', onStartupExit);
        };
        const succeed = async (msg: Extract<PluginWorkerOutboundMessage, { type: 'ready' }>) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          const filePath = this.options.filePath;
          const onRuntimeMessage = (message: PluginWorkerOutboundMessage) => this.handleMessage(message);
          function cleanupRuntime() {
            worker.off('message', onRuntimeMessage);
            worker.off('error', onRuntimeError);
            worker.off('exit', onRuntimeExit);
          }
          const failRuntime = (error: Error) => {
            cleanupRuntime();
            if (this.worker === worker) {
              this.worker = null;
            }
            this.runtime = null;
            this.unregisterProviderAdapters();
            this.rejectAllPending(error);
          };
          function onRuntimeError(error: Error) {
            failRuntime(error);
          }
          function onRuntimeExit(code: number) {
            failRuntime(new Error(`Plugin worker exited with code ${code}: ${filePath}`));
          }
          worker.on('message', onRuntimeMessage);
          worker.once('error', onRuntimeError);
          worker.once('exit', onRuntimeExit);
          let runtime: PluginWorkerRuntime;
          try {
            const builtRuntime = this.buildRuntime(msg);
            runtime = builtRuntime instanceof Promise ? await builtRuntime : builtRuntime;
          } catch (error) {
            cleanupRuntime();
            this.worker = null;
            this.unregisterProviderAdapters();
            void worker.terminate().catch(() => undefined);
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          this.runtime = this.worker === worker ? runtime : null;
          resolve(runtime);
        };
        const fail = (error: Error, terminate = false) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          this.worker = null;
          if (terminate) {
            void worker.terminate().catch(() => undefined);
          }
          reject(error);
        };
        const onReadyMessage = (msg: PluginWorkerOutboundMessage) => {
          if (msg.type === 'ready') {
            void succeed(msg);
            return;
          }
          if (msg.type === 'startup-error') {
            fail(new Error(msg.error), true);
          }
        };
        const onStartupError = (error: Error) => {
          fail(error);
        };
        const onStartupExit = (code: number) => {
          fail(new Error(`Plugin worker exited during startup with code ${code}`));
        };
        const startupTimeout = setTimeout(() => {
          fail(
            new Error(`Plugin worker startup timeout after ${this.rpcTimeoutMs}ms: ${this.options.filePath}`),
            true,
          );
        }, this.rpcTimeoutMs);
        worker.on('message', onReadyMessage);
        worker.once('error', onStartupError);
        worker.once('exit', onStartupExit);
      },
    );

    return runtime;
  }

  async stop(): Promise<void> {
    this.rejectAllPending(new Error('Plugin worker stopped'));
    const worker = this.worker;
    this.worker = null;
    this.runtime = null;
    this.unregisterProviderAdapters();
    if (!worker) {
      return;
    }
    await worker.terminate().catch(() => undefined);
  }

  private buildRuntime(
    ready: Extract<PluginWorkerOutboundMessage, { type: 'ready' }>,
  ): PluginWorkerRuntime | Promise<PluginWorkerRuntime> {
    const providerAdapters = ready.providerAdapters ?? [];
    if (providerAdapters.length > 0 && !this.options.providerAdapterApi) {
      throw new Error('Plugin registered provider adapters but no provider adapter API is available');
    }
    if (providerAdapters.length === 0) {
      return this.buildRuntimeWithBridge(ready, null);
    }
    return this.createProviderAdapterBridge()
      .then((bridge) => this.buildRuntimeWithBridge(ready, bridge));
  }

  private buildRuntimeWithBridge(
    ready: Extract<PluginWorkerOutboundMessage, { type: 'ready' }>,
    bridge: PluginProviderAdapterBridge | null,
  ): PluginWorkerRuntime {
    const providerAdapters = ready.providerAdapters ?? [];
    for (const registration of providerAdapters) {
      if (!bridge) {
        throw new Error('Provider adapter bridge is not available');
      }
      this.registerProviderAdapterWithHostBridge(
        registration.descriptor,
        registration.factoryRef,
        bridge,
      );
    }

    const hooks: TypedOrchestratorHooks = {};
    const hookProxies = hooks as Record<PluginHookEvent, (payload: unknown) => Promise<void>>;
    for (const event of ready.hookKeys) {
      hookProxies[event] = (payload: unknown) => this.postOperation({
        kind: 'hook',
        event,
        payload,
      });
    }

    return {
      slot: ready.slot,
      detected: ready.detected,
      ready: ready.ready,
      providerAdapters,
      hooks,
      ...(ready.slot === 'notifier'
        ? { notifier: { notify: (notification) => this.postOperation({ kind: 'notifier', payload: notification }) } }
        : {}),
      ...(ready.slot === 'tracker'
        ? { tracker: { track: (event) => this.postOperation({ kind: 'tracker', payload: event }) } }
        : {}),
      ...(ready.slot === 'telemetry_exporter'
        ? {
            telemetryExporter: {
              export: (record) => this.postOperation({ kind: 'telemetry_exporter', payload: record }),
            },
          }
        : {}),
    };
  }

  private registerProviderAdapterWithHostBridge(
    descriptor: PluginProviderAdapterDescriptor,
    factoryRef: string,
    bridge: PluginProviderAdapterBridge,
  ): void {
    const api = this.options.providerAdapterApi;
    if (!api) {
      return;
    }
    const hostApi = api as HostProviderAdapterApi;
    if (typeof hostApi.registerPluginProviderAdapter === 'function') {
      hostApi.registerPluginProviderAdapter(descriptor, factoryRef, bridge);
    } else {
      api.registerProviderAdapter(descriptor, factoryRef);
    }
    this.registeredProviderAdapterIds.add(descriptor.provider);
  }

  private unregisterProviderAdapters(): void {
    const api = this.options.providerAdapterApi as HostProviderAdapterApi | undefined;
    if (!api || typeof api.unregisterPluginProviderAdapter !== 'function') {
      this.registeredProviderAdapterIds.clear();
      return;
    }
    for (const provider of this.registeredProviderAdapterIds) {
      api.unregisterPluginProviderAdapter(provider);
    }
    this.registeredProviderAdapterIds.clear();
  }

  private async createProviderAdapterBridge(): Promise<PluginProviderAdapterBridge> {
    const providerAdapterBridgeModule = await loadProviderAdapterBridgeModule();
    return {
      createProviderAdapter: providerAdapterBridgeModule.createWorkerPluginProviderAdapterBridge({
        invoke: (operation) => this.postOperation<WorkerPluginProviderAdapterResponse>({
          kind: 'provider_adapter',
          operation,
        }),
        subscribeToEvents: (adapterId, listener) => this.registerProviderEventSink(adapterId, listener),
      }).createProviderAdapter,
    };
  }

  private registerProviderEventSink(
    adapterId: string,
    listener: (envelope: ProviderRuntimeEventEnvelope) => void,
  ): () => void {
    const sinks = this.providerEventSinks.get(adapterId) ?? new Set();
    sinks.add(listener);
    this.providerEventSinks.set(adapterId, sinks);
    return () => {
      sinks.delete(listener);
      if (sinks.size === 0) {
        this.providerEventSinks.delete(adapterId);
      }
    };
  }

  private postOperation<T = void>(operation: PluginWorkerOperation, timeoutMs = this.rpcTimeoutMs): Promise<T> {
    if (!this.worker) {
      return Promise.reject(new Error('Plugin worker is not running'));
    }

    const id = ++this.nextRpcId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Plugin worker operation timeout: ${this.options.filePath}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.worker!.postMessage({ type: 'invoke', id, operation } satisfies PluginWorkerInboundMessage);
    });
  }

  private handleMessage(message: PluginWorkerOutboundMessage): void {
    if (message.type === 'provider-event') {
      const sinks = this.providerEventSinks.get(message.adapterId);
      if (!sinks) {
        return;
      }
      for (const sink of sinks) {
        sink(message.envelope);
      }
      return;
    }
    if (message.type !== 'rpc-response') {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) {
      pending.reject(new Error(message.error));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

let workerHooks: TypedOrchestratorHooks = {};
let workerRuntime: unknown;
let workerSlot: PluginSlot = 'hook';
let workerProviderAdapterRuntime: WorkerPluginProviderAdapterRuntime | null = null;

type WorkerRuntimeContext = PluginWorkerContext & {
  providerAdapters: ProviderAdapterPluginApi;
};

function buildWorkerRuntimeContext(context: PluginWorkerContext): WorkerRuntimeContext {
  if (!workerProviderAdapterRuntime) {
    throw new Error('Provider adapter runtime is not initialized');
  }
  return {
    ...context,
    providerAdapters: workerProviderAdapterRuntime.api,
  };
}

async function loadModule(filePath: string): Promise<WorkerPluginModule> {
  const moduleUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}`;
  const mod = await import(moduleUrl);
  return (mod && (mod.default || mod)) as WorkerPluginModule;
}

async function startWorkerRuntime(data: PluginWorkerData): Promise<void> {
  const bridgeModule = await loadProviderAdapterBridgeModule(data.providerBridgeEntrypoint);
  const helpers = await loadWorkerHelperModule(data.workerHelperEntrypoint);
  workerProviderAdapterRuntime = new bridgeModule.WorkerPluginProviderAdapterRuntime(
    (message: WorkerPluginProviderAdapterEventMessage) => {
      parentPort!.postMessage(message satisfies PluginWorkerOutboundMessage);
    },
  );
  const loaded = await loadModule(data.filePath);
  const runtimeContext = buildWorkerRuntimeContext(data.context);
  const resolved =
    typeof loaded === 'function'
      ? await loaded(runtimeContext)
      : loaded;
  const moduleDef = helpers.normalizePluginModule(resolved || {});
  workerHooks = moduleDef.hooks ?? {};
  workerSlot = data.requestedSlot ?? moduleDef.slot ?? 'hook';

  let detected = true;
  if (moduleDef.detect) {
    detected = await moduleDef.detect(runtimeContext);
  }

  if (!detected) {
    parentPort!.postMessage({
      type: 'ready',
      slot: workerSlot,
      detected,
      ready: false,
      hookKeys: [],
      providerAdapters: [],
    } satisfies PluginWorkerOutboundMessage);
    return;
  }

  if (workerSlot === 'hook') {
    workerRuntime = workerHooks;
  } else if (moduleDef.create) {
    workerRuntime = await moduleDef.create(runtimeContext);
  }

  const validationError = workerSlot === 'hook' ? null : helpers.validateWorkerRuntime(workerSlot, workerRuntime);
  if (validationError) {
    throw new Error(validationError);
  }
  workerProviderAdapterRuntime.assertFactoriesAvailable();

  parentPort!.postMessage({
    type: 'ready',
    slot: workerSlot,
    detected,
    ready: workerRuntime !== undefined,
    hookKeys: Object.keys(workerHooks) as PluginHookEvent[],
    providerAdapters: workerProviderAdapterRuntime.listRegistrations(),
  } satisfies PluginWorkerOutboundMessage);
}

async function handleWorkerOperation(operation: PluginWorkerOperation): Promise<unknown> {
  switch (operation.kind) {
    case 'hook': {
      const hook = workerHooks[operation.event];
      if (hook) {
        await hook(operation.payload as never);
      }
      break;
    }
    case 'notifier': {
      await (workerRuntime as NotifierPlugin).notify(operation.payload as never);
      break;
    }
    case 'tracker': {
      await (workerRuntime as TrackerPlugin).track(operation.payload as PluginTrackerEvent);
      break;
    }
    case 'telemetry_exporter': {
      await (workerRuntime as TelemetryExporterPlugin).export(operation.payload as PluginTelemetryRecord);
      break;
    }
    case 'provider_adapter':
      if (!workerProviderAdapterRuntime) {
        throw new Error('Provider adapter runtime is not initialized');
      }
      return workerProviderAdapterRuntime.invoke(operation.operation);
  }
  return undefined;
}

function runWorkerThread(): void {
  void startWorkerRuntime(workerData as PluginWorkerData).catch((error: unknown) => {
    parentPort!.postMessage({
      type: 'startup-error',
      error: error instanceof Error ? error.message : String(error),
    } satisfies PluginWorkerOutboundMessage);
  });

  parentPort!.on('message', (message: PluginWorkerInboundMessage) => {
    if (message.type === 'shutdown') {
      void loadWorkerHelperModule((workerData as PluginWorkerData).workerHelperEntrypoint)
        .then((helpers) => helpers.disposeProviderAdaptersBounded(workerProviderAdapterRuntime))
        .catch(() => undefined)
        .finally(() => {
          parentPort!.postMessage({ type: 'rpc-response', id: message.id } satisfies PluginWorkerOutboundMessage);
          process.exit(0);
        });
      return;
    }

    void handleWorkerOperation(message.operation)
      .then((result) => {
        parentPort!.postMessage({
          type: 'rpc-response',
          id: message.id,
          result,
        } satisfies PluginWorkerOutboundMessage);
      })
      .catch((error: unknown) => {
        parentPort!.postMessage({
          type: 'rpc-response',
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        } satisfies PluginWorkerOutboundMessage);
      });
  });
}

if (!isMainThread) {
  runWorkerThread();
}
