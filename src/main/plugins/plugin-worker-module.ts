/**
 * Worker-plugin module shape helpers: what a plugin entrypoint may export
 * (bare hooks, a module definition, or a factory) and how the worker host
 * normalizes/validates it per slot. Extracted from `plugin-worker-host.ts`
 * to keep the host under the file-size ceiling.
 */
import type { PluginSlot, TypedOrchestratorHooks } from '../../shared/types/plugin.types';
import type { PluginWorkerContext } from './plugin-worker-host';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isPluginModuleDefinition(value: unknown): value is WorkerPluginModuleDefinition {
  return isRecord(value) && (
    'hooks' in value ||
    'detect' in value ||
    'slot' in value ||
    'create' in value
  );
}

export interface WorkerPluginModuleDefinition<T = unknown> {
  hooks?: TypedOrchestratorHooks;
  detect?: (ctx: PluginWorkerContext) => boolean | Promise<boolean>;
  slot?: PluginSlot;
  create?: (ctx: PluginWorkerContext) => T | Promise<T>;
}

export type WorkerPluginModule =
  | TypedOrchestratorHooks
  | WorkerPluginModuleDefinition
  | ((ctx: PluginWorkerContext) =>
      | TypedOrchestratorHooks
      | WorkerPluginModuleDefinition
      | Promise<TypedOrchestratorHooks | WorkerPluginModuleDefinition>);

export function normalizePluginModule(
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

/**
 * Worker-side graceful-shutdown helper (audit fix 4): dispose live plugin
 * provider adapters before acking a shutdown message, bounded so a hung
 * plugin `terminate()` can never stall shutdown — teardown must not rely
 * solely on `worker.terminate()` killing the thread.
 */
export async function disposeProviderAdaptersBounded(
  runtime: { disposeAll(): Promise<void> } | null,
  timeoutMs = 2_000,
): Promise<void> {
  if (!runtime) return;
  const dispose = runtime.disposeAll().catch(() => undefined);
  await Promise.race([
    dispose,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    }),
  ]);
}

export function validateWorkerRuntime(slot: PluginSlot, runtime: unknown): string | null {
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
