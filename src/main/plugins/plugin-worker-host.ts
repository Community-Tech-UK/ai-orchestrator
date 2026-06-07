import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from 'node:worker_threads';
import type {
  NotifierPlugin,
  PluginHookEvent,
  PluginRuntimeForSlot,
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
  workerFactory?: (workerData: PluginWorkerData) => Worker;
  rpcTimeoutMs?: number;
}

export interface PluginWorkerRuntime {
  slot: PluginSlot;
  detected: boolean;
  ready: boolean;
  hooks: TypedOrchestratorHooks;
  notifier?: NotifierPlugin;
  tracker?: TrackerPlugin;
  telemetryExporter?: TelemetryExporterPlugin;
}

interface PluginWorkerData {
  filePath: string;
  context: PluginWorkerContext;
  requestedSlot?: PluginSlot;
}

type PluginWorkerOperation =
  | { kind: 'hook'; event: PluginHookEvent; payload: unknown }
  | { kind: 'notifier'; payload: unknown }
  | { kind: 'tracker'; payload: unknown }
  | { kind: 'telemetry_exporter'; payload: unknown };

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
    }
  | { type: 'startup-error'; error: string }
  | { type: 'rpc-response'; id: number; error?: string };

interface PendingRpc {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPluginModuleDefinition(value: unknown): value is WorkerPluginModuleDefinition {
  return isRecord(value) && (
    'hooks' in value ||
    'detect' in value ||
    'slot' in value ||
    'create' in value
  );
}

interface WorkerPluginModuleDefinition<T = unknown> {
  hooks?: TypedOrchestratorHooks;
  detect?: (ctx: PluginWorkerContext) => boolean | Promise<boolean>;
  slot?: PluginSlot;
  create?: (ctx: PluginWorkerContext) => T | Promise<T>;
}

type WorkerPluginModule =
  | TypedOrchestratorHooks
  | WorkerPluginModuleDefinition
  | ((ctx: PluginWorkerContext) =>
      | TypedOrchestratorHooks
      | WorkerPluginModuleDefinition
      | Promise<TypedOrchestratorHooks | WorkerPluginModuleDefinition>);

function normalizePluginModule(
  value: TypedOrchestratorHooks | WorkerPluginModuleDefinition,
): WorkerPluginModuleDefinition {
  if (isPluginModuleDefinition(value)) {
    return {
      hooks: value.hooks ?? {},
      detect: value.detect,
      slot: value.slot,
      create: value.create,
    };
  }

  return {
    hooks: value,
  };
}

function validateWorkerRuntime(slot: PluginSlot, runtime: unknown): string | null {
  if (runtime === null || runtime === undefined) {
    return `${slot} plugins must return a runtime from create()`;
  }

  if (slot === 'notifier') {
    return isRecord(runtime) && typeof runtime['notify'] === 'function'
      ? null
      : 'notifier plugins must return an object with notify(notification)';
  }
  if (slot === 'tracker') {
    return isRecord(runtime) && typeof runtime['track'] === 'function'
      ? null
      : 'tracker plugins must return an object with track(event)';
  }
  if (slot === 'telemetry_exporter') {
    return isRecord(runtime) && typeof runtime['export'] === 'function'
      ? null
      : 'telemetry_exporter plugins must return an object with export(record)';
  }

  return null;
}

function createDefaultWorker(workerDataValue: PluginWorkerData): Worker {
  const entrypoint = resolveWorkerEntrypoint();
  return new Worker(entrypoint, {
    workerData: workerDataValue,
    execArgv: entrypoint.endsWith('.ts') ? ['--import', 'tsx'] : [],
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

export class PluginWorkerHost {
  private worker: Worker | null = null;
  private nextRpcId = 0;
  private readonly pending = new Map<number, PendingRpc>();
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
      ...(this.options.requestedSlot ? { requestedSlot: this.options.requestedSlot } : {}),
    };
    const worker = this.workerFactory(workerDataValue);
    this.worker = worker;

    const runtime = await new Promise<PluginWorkerRuntime>(
      (resolve, reject) => {
        let settled = false;
        let startupTimeout: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          if (startupTimeout) {
            clearTimeout(startupTimeout);
          }
          worker.off('message', onReadyMessage);
          worker.off('error', onStartupError);
          worker.off('exit', onStartupExit);
        };
        const succeed = (msg: Extract<PluginWorkerOutboundMessage, { type: 'ready' }>) => {
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
          this.runtime = this.buildRuntime(msg);
          resolve(this.runtime);
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
            succeed(msg);
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
        startupTimeout = setTimeout(() => {
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
    if (!worker) {
      return;
    }
    await worker.terminate().catch(() => undefined);
  }

  private buildRuntime(
    ready: Extract<PluginWorkerOutboundMessage, { type: 'ready' }>,
  ): PluginWorkerRuntime {
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

  private postOperation(operation: PluginWorkerOperation, timeoutMs = this.rpcTimeoutMs): Promise<void> {
    if (!this.worker) {
      return Promise.reject(new Error('Plugin worker is not running'));
    }

    const id = ++this.nextRpcId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Plugin worker operation timeout: ${this.options.filePath}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.worker!.postMessage({ type: 'invoke', id, operation } satisfies PluginWorkerInboundMessage);
    });
  }

  private handleMessage(message: PluginWorkerOutboundMessage): void {
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
    pending.resolve();
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

async function loadModule(filePath: string): Promise<WorkerPluginModule> {
  const moduleUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}`;
  const mod = await import(moduleUrl);
  return (mod && (mod.default || mod)) as WorkerPluginModule;
}

async function startWorkerRuntime(data: PluginWorkerData): Promise<void> {
  const loaded = await loadModule(data.filePath);
  const resolved =
    typeof loaded === 'function'
      ? await loaded(data.context)
      : loaded;
  const moduleDef = normalizePluginModule(resolved || {});
  workerHooks = moduleDef.hooks ?? {};
  workerSlot = data.requestedSlot ?? moduleDef.slot ?? 'hook';

  let detected = true;
  if (moduleDef.detect) {
    detected = await moduleDef.detect(data.context);
  }

  if (!detected) {
    parentPort!.postMessage({
      type: 'ready',
      slot: workerSlot,
      detected,
      ready: false,
      hookKeys: [],
    } satisfies PluginWorkerOutboundMessage);
    return;
  }

  if (workerSlot === 'hook') {
    workerRuntime = workerHooks;
  } else if (moduleDef.create) {
    workerRuntime = await moduleDef.create(data.context);
  }

  const validationError = workerSlot === 'hook' ? null : validateWorkerRuntime(workerSlot, workerRuntime);
  if (validationError) {
    throw new Error(validationError);
  }

  parentPort!.postMessage({
    type: 'ready',
    slot: workerSlot,
    detected,
    ready: workerRuntime !== undefined,
    hookKeys: Object.keys(workerHooks) as PluginHookEvent[],
  } satisfies PluginWorkerOutboundMessage);
}

async function handleWorkerOperation(operation: PluginWorkerOperation): Promise<void> {
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
  }
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
      parentPort!.postMessage({ type: 'rpc-response', id: message.id } satisfies PluginWorkerOutboundMessage);
      process.exit(0);
      return;
    }

    void handleWorkerOperation(message.operation)
      .then(() => {
        parentPort!.postMessage({
          type: 'rpc-response',
          id: message.id,
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
