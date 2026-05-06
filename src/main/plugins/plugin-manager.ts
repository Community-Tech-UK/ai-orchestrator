/**
 * Orchestrator Plugin Manager
 *
 * Loads JS plugins from well-known directories and dispatches events to them.
 * The goal is a stable event surface (similar to how modern coding agents expose hooks),
 * without depending on any external repo runtime code.
 *
 * Plugin locations:
 * - `~/.orchestrator/plugins/**.js`
 * - `<project-scan-root>/.orchestrator/plugins/**.js`
 *
 * Project scan roots run from the repository root (when available) down to the
 * active working directory, so nested worktrees inherit plugin definitions from
 * their containing project.
 *
 * Plugin module contract (CommonJS recommended):
 * - Hook plugins: `module.exports = async (ctx) => ({ hooks... })`
 * - Slot plugins: `module.exports = { slot: 'notifier', create: async (ctx) => runtime }`
 *
 * Legacy hook-only modules remain supported. Non-hook slots must provide
 * `create(ctx)` so the manager can validate and register a real runtime.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { app } from 'electron';
import type { InstanceManager } from '../instance/instance-manager';
import { getMultiVerifyCoordinator } from '../orchestration/multi-verify-coordinator';
import { getConsensusCoordinator } from '../orchestration/consensus-coordinator';
import { getDebateCoordinator } from '../orchestration/debate-coordinator';
import { getSettingsManager } from '../core/config/settings-manager';
import { getLogger } from '../logging/logger';
import { getReactionEngine } from '../reactions';
import { getSessionContinuityManager } from '../session/session-continuity';
import type { OutputMessage } from '../../shared/types/instance.types';
import type {
  PluginLoadPhase,
  PluginLoadReport,
  PluginNotification,
  PluginPhaseResult,
  PluginHookEvent,
  PluginHookPayloads,
  PluginRuntimeForSlot,
  PluginSlot,
  PluginTelemetryRecord,
  PluginTrackerEvent,
  PluginRecord,
  NotifierPlugin,
  TelemetryExporterPlugin,
  TrackerPlugin,
  TypedOrchestratorHooks,
} from '../../shared/types/plugin.types';
import type { PluginManifest } from '@sdk/plugins';
import { PluginManifestSchema } from '@contracts/schemas/plugin';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { toOutputMessageFromProviderEnvelope } from '../providers/provider-output-event';
import { getPluginRegistry } from './plugin-registry';
import { resolveProjectScanRoots } from '../util/project-scan-roots';
import type { ReactionEvent } from '../reactions/reaction.types';

const logger = getLogger('PluginManager');

/**
 * Reject paths containing '..' segments to prevent directory escape.
 */
function isPathSafe(filePath: string, baseDir: string): boolean {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(baseDir);
  return resolved.startsWith(resolvedBase + path.sep) || resolved === resolvedBase;
}

function isRecord(value: unknown): value is PluginRecord {
  return typeof value === 'object' && value !== null;
}

function isOutputMessage(value: unknown): value is OutputMessage {
  if (!isRecord(value)) {
    return false;
  }

  const type = value['type'];
  return (
    typeof value['id'] === 'string' &&
    typeof value['timestamp'] === 'number' &&
    typeof value['content'] === 'string' &&
    (type === 'assistant' ||
      type === 'user' ||
      type === 'system' ||
      type === 'tool_use' ||
      type === 'tool_result' ||
      type === 'error')
  );
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNotifierPlugin(value: unknown): value is NotifierPlugin {
  return isRecord(value) && typeof value['notify'] === 'function';
}

function isTrackerPlugin(value: unknown): value is TrackerPlugin {
  return isRecord(value) && typeof value['track'] === 'function';
}

function isTelemetryExporterPlugin(value: unknown): value is TelemetryExporterPlugin {
  return isRecord(value) && typeof value['export'] === 'function';
}

function validateSlotRuntime(slot: PluginSlot, runtime: unknown): string | null {
  if (runtime === null || runtime === undefined) {
    return `${slot} plugins must return a runtime from create()`;
  }

  switch (slot) {
    case 'notifier':
      return isNotifierPlugin(runtime)
        ? null
        : 'notifier plugins must return an object with notify(notification)';
    case 'tracker':
      return isTrackerPlugin(runtime)
        ? null
        : 'tracker plugins must return an object with track(event)';
    case 'telemetry_exporter':
      return isTelemetryExporterPlugin(runtime)
        ? null
        : 'telemetry_exporter plugins must return an object with export(record)';
    default:
      return null;
  }
}

function toTrackerEvent(event: ReactionEvent): PluginTrackerEvent {
  return {
    event: `reaction.${event.type}`,
    timestamp: event.timestamp,
    instanceId: event.instanceId,
    data: {
      priority: event.priority,
      ...(event.message ? { message: event.message } : {}),
      ...event.data,
    },
  };
}

function toNotificationPayload(
  event: ReactionEvent,
  priority: string | undefined,
  channels: string[],
): PluginNotification {
  return {
    event: `reaction.${event.type}`,
    title: event.type,
    message: event.message ?? `Reaction event: ${event.type}`,
    timestamp: event.timestamp,
    priority,
    instanceId: event.instanceId,
    channels,
    data: {
      reactionType: event.type,
      ...event.data,
    },
  };
}

function toTelemetryRecord(envelope: ProviderRuntimeEventEnvelope): PluginTelemetryRecord {
  return {
    event: `provider.${envelope.event.kind}`,
    timestamp: envelope.timestamp,
    attributes: {
      provider: envelope.provider,
      instanceId: envelope.instanceId,
      ...(envelope.sessionId ? { sessionId: envelope.sessionId } : {}),
      seq: envelope.seq,
    },
    data: envelope.event as unknown as PluginRecord,
  };
}

function toInstanceCreatedPayload(payload: unknown): PluginHookPayloads['instance.created'] | null {
  if (!isRecord(payload)) return null;
  const rawId = payload['id'];
  const rawWorkingDirectory = payload['workingDirectory'];
  if (typeof rawId !== 'string' || typeof rawWorkingDirectory !== 'string') {
    return null;
  }

  const provider = typeof payload['provider'] === 'string' ? payload['provider'] : undefined;
  return {
    ...payload,
    id: rawId,
    instanceId: rawId,
    workingDirectory: rawWorkingDirectory,
    ...(provider ? { provider } : {}),
  };
}

function toInstanceOutputPayload(payload: unknown): PluginHookPayloads['instance.output'] | null {
  if (!isRecord(payload)) return null;
  if (typeof payload['instanceId'] !== 'string' || !isOutputMessage(payload['message'])) {
    return null;
  }

  return {
    instanceId: payload['instanceId'],
    message: payload['message'],
  };
}

function toInstanceOutputPayloadFromEnvelope(
  envelope: ProviderRuntimeEventEnvelope,
): PluginHookPayloads['instance.output'] | null {
  const message = toOutputMessageFromProviderEnvelope(envelope);
  if (!message) {
    return null;
  }

  return {
    instanceId: envelope.instanceId,
    message,
  };
}

function toInstanceStateChangedPayload(
  payload: unknown,
): PluginHookPayloads['instance.stateChanged'] | null {
  if (!isRecord(payload)) return null;
  if (
    typeof payload['instanceId'] !== 'string'
    || typeof payload['status'] !== 'string'
    || typeof payload['previousStatus'] !== 'string'
  ) {
    return null;
  }

  return {
    instanceId: payload['instanceId'],
    previousState: payload['previousStatus'],
    newState: payload['status'],
    timestamp: typeof payload['timestamp'] === 'number' ? payload['timestamp'] : Date.now(),
  };
}

function toPermissionAskPayload(
  payload: unknown,
): PluginHookPayloads['permission.ask'] | null {
  if (!isRecord(payload) || typeof payload['instanceId'] !== 'string') {
    return null;
  }

  const metadata = isRecord(payload['metadata']) ? payload['metadata'] : {};
  const type = typeof metadata['type'] === 'string' ? metadata['type'] : '';
  if (type !== 'deferred_permission' && type !== 'permission_denial') {
    return null;
  }

  const toolName =
    typeof metadata['tool_name'] === 'string'
      ? metadata['tool_name']
      : typeof metadata['action'] === 'string'
        ? metadata['action']
        : 'unknown';
  const toolInput = isRecord(metadata['tool_input']) ? metadata['tool_input'] : {};
  const command =
    typeof toolInput['command'] === 'string'
      ? toolInput['command']
      : typeof metadata['path'] === 'string'
        ? metadata['path']
        : undefined;

  return {
    instanceId: payload['instanceId'],
    toolName,
    ...(command ? { command } : {}),
  };
}

function toSessionResumedPayload(payload: unknown): PluginHookPayloads['session.resumed'] | null {
  if (!isRecord(payload) || !isRecord(payload['state'])) {
    return null;
  }

  const state = payload['state'];
  if (typeof state['instanceId'] !== 'string' || typeof state['sessionId'] !== 'string') {
    return null;
  }

  return {
    instanceId: state['instanceId'],
    sessionId: state['sessionId'],
  };
}

function toSessionCompactingPayload(
  payload: unknown,
): PluginHookPayloads['session.compacting'] | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (
    typeof payload['instanceId'] !== 'string'
    || typeof payload['messageCount'] !== 'number'
    || typeof payload['tokenCount'] !== 'number'
  ) {
    return null;
  }

  return {
    instanceId: payload['instanceId'],
    messageCount: payload['messageCount'],
    tokenCount: payload['tokenCount'],
  };
}

function toVerificationStartedPayload(
  payload: unknown,
): PluginHookPayloads['verification.started'] | null {
  if (!isRecord(payload)) return null;
  if (typeof payload['id'] !== 'string' || typeof payload['instanceId'] !== 'string') {
    return null;
  }

  return {
    ...payload,
    id: payload['id'],
    verificationId: payload['id'],
    instanceId: payload['instanceId'],
  };
}

function toVerificationCompletedPayload(
  payload: unknown,
): PluginHookPayloads['verification.completed'] | null {
  if (!isRecord(payload) || typeof payload['id'] !== 'string') {
    return null;
  }

  const request = isRecord(payload['request']) ? payload['request'] : null;
  const instanceId =
    typeof payload['instanceId'] === 'string'
      ? payload['instanceId']
      : typeof request?.['instanceId'] === 'string'
        ? request['instanceId']
        : '';

  return {
    ...payload,
    id: payload['id'],
    verificationId: payload['id'],
    instanceId,
  };
}

function toVerificationErrorPayload(
  payload: unknown,
): PluginHookPayloads['verification.error'] | null {
  if (!isRecord(payload) || !isRecord(payload['request'])) {
    return null;
  }

  const request = payload['request'];
  const verificationId = typeof request['id'] === 'string' ? request['id'] : '';
  const instanceId = typeof request['instanceId'] === 'string' ? request['instanceId'] : '';

  return {
    request,
    error: payload['error'],
    verificationId,
    instanceId,
  };
}

/**
 * Validate a plugin manifest using the contracts-backed Zod schema.
 * Replaces hand-rolled field checks with {@link PluginManifestSchema}.
 */
export function validateManifest(
  manifest: unknown,
): { valid: true; manifest: PluginManifest } | { valid: false; errors: string[] } {
  const result = PluginManifestSchema.safeParse(manifest);
  if (result.success) {
    // ValidatedPluginManifest is structurally assignable to PluginManifest
    return { valid: true, manifest: result.data as unknown as PluginManifest };
  }

  const errors = result.error.issues.map(
    (issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message}`;
    },
  );
  return { valid: false, errors };
}

export interface OrchestratorPluginContext {
  instanceManager: InstanceManager;
  appPath: string;
  homeDir: string | null;
}

export type OrchestratorHooks = TypedOrchestratorHooks;
export interface PluginModuleDefinition<T = unknown> {
  hooks?: TypedOrchestratorHooks;
  detect?: (
    ctx: OrchestratorPluginContext,
  ) => boolean | Promise<boolean>;
  slot?: PluginSlot;
  create?: (
    ctx: OrchestratorPluginContext,
  ) => T | Promise<T>;
}

export type OrchestratorPluginModule =
  | OrchestratorHooks
  | PluginModuleDefinition
  | ((ctx: OrchestratorPluginContext) => OrchestratorHooks | PluginModuleDefinition | Promise<OrchestratorHooks | PluginModuleDefinition>);

interface LoadedPlugin {
  filePath: string;
  hooks: TypedOrchestratorHooks;
  slot: PluginSlot;
  runtime?: PluginRuntimeForSlot<PluginSlot>;
  loadReport: PluginLoadReport;
  manifest?: PluginManifest;
}

interface CacheEntry {
  loadedAt: number;
  plugins: LoadedPlugin[];
  errors: { filePath: string; error: string }[];
  scanDirs: string[];
}

const CACHE_TTL_MS = 10_000;

function buildPhase(
  phase: PluginLoadPhase,
  status: PluginPhaseResult['status'],
  message?: string,
): PluginPhaseResult {
  return {
    phase,
    status,
    timestamp: Date.now(),
    ...(message ? { message } : {}),
  };
}

function isPluginModuleDefinition(value: unknown): value is PluginModuleDefinition {
  return isRecord(value) && (
    'hooks' in value ||
    'detect' in value ||
    'slot' in value ||
    'create' in value
  );
}

function normalizePluginModule(
  value: OrchestratorHooks | PluginModuleDefinition,
): PluginModuleDefinition {
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

export class OrchestratorPluginManager {
  private static instance: OrchestratorPluginManager | null = null;

  private cacheByWorkingDir = new Map<string, CacheEntry>();
  private configLoadedByWorkingDir = new Set<string>();
  private activeToolExecutions = new Map<string, {
    toolName: string;
    args: Record<string, unknown>;
    startedAt: number;
  }>();
  private initialized = false;

  static getInstance(): OrchestratorPluginManager {
    if (!OrchestratorPluginManager.instance) {
      OrchestratorPluginManager.instance = new OrchestratorPluginManager();
    }
    return OrchestratorPluginManager.instance;
  }

  static _resetForTesting(): void {
    OrchestratorPluginManager.instance = null;
  }

  static _injectPluginForTesting(
    instance: OrchestratorPluginManager,
    workingDirectory: string,
    hooks: TypedOrchestratorHooks,
    options?: {
      filePath?: string;
      slot?: PluginSlot;
      runtime?: PluginRuntimeForSlot<PluginSlot>;
    },
  ): void {
    const entry = instance.cacheByWorkingDir.get(workingDirectory) ?? {
      loadedAt: Date.now(),
      plugins: [],
      errors: [],
      scanDirs: [],
    };
    const slot = options?.slot ?? 'hook';
    entry.plugins.push({
      filePath: options?.filePath ?? 'test-plugin.js',
      hooks,
      slot,
      runtime: options?.runtime,
      loadReport: {
        slot,
        detected: true,
        ready: true,
        phases: [],
      },
    });
    instance.cacheByWorkingDir.set(workingDirectory, entry);
  }

  private getHomeDir(): string | null {
    try {
      return app.getPath('home');
    } catch {
      return process.env['HOME'] || process.env['USERPROFILE'] || null;
    }
  }

  private getPluginDirs(workingDirectory: string): string[] {
    const home = this.getHomeDir();
    const dirs: string[] = [];
    if (home) {
      dirs.push(path.join(home, '.orchestrator', 'plugins'));
    }
    for (const root of resolveProjectScanRoots(workingDirectory, home)) {
      dirs.push(path.join(root, '.orchestrator', 'plugins'));
    }
    return dirs;
  }

  private buildContext(instanceManager: InstanceManager): OrchestratorPluginContext {
    return {
      instanceManager,
      appPath: app.getAppPath(),
      homeDir: this.getHomeDir(),
    };
  }

  private async walkJsFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    const stack: string[] = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch (e) {
        logger.debug('Failed to read plugin directory during walk', { dir: current, error: String(e) });
        continue;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (!isPathSafe(full, dir)) {
          logger.warn('Blocked path traversal attempt in plugin directory', { path: full, baseDir: dir });
          continue;
        }
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          stack.push(full);
          continue;
        }
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.js')) out.push(full);
      }
    }
    return out;
  }

  private async loadModule(filePath: string): Promise<OrchestratorPluginModule> {
    const moduleUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}`;
    const mod = await import(moduleUrl);
    return (mod && (mod.default || mod)) as OrchestratorPluginModule;
  }

  private async loadPluginsForWorkingDirectory(
    workingDirectory: string,
    ctx: OrchestratorPluginContext,
  ): Promise<{ plugins: LoadedPlugin[]; errors: { filePath: string; error: string }[] }> {
    const plugins: LoadedPlugin[] = [];
    const errors: { filePath: string; error: string }[] = [];
    const dirs = this.getPluginDirs(workingDirectory);
    for (const dir of dirs) {
      const files = await this.walkJsFiles(dir);
      for (const filePath of files) {
        const phases: PluginPhaseResult[] = [];
        let manifest: PluginManifest | undefined;
        let detected = true;
        try {
          const manifestPaths = [
            path.join(path.dirname(filePath), 'plugin.json'),
            path.join(path.dirname(filePath), '.codex-plugin', 'plugin.json'),
          ];
          let manifestLoadAttempted = false;
          for (const manifestPath of manifestPaths) {
            try {
              const manifestRaw = await fs.readFile(manifestPath, 'utf-8');
              manifestLoadAttempted = true;
              phases.push(buildPhase('manifest_load', 'succeeded'));
              const parsed: unknown = JSON.parse(manifestRaw);
              const result = validateManifest(parsed);
              if (result.valid) {
                manifest = result.manifest;
                phases.push(buildPhase('manifest_validation', 'succeeded'));
              } else {
                phases.push(buildPhase('manifest_validation', 'failed', result.errors.join(', ')));
                logger.warn(`Invalid plugin manifest at ${manifestPath}: ${result.errors.join(', ')}`);
                errors.push({ filePath: manifestPath, error: `Invalid manifest: ${result.errors.join(', ')}` });
              }
              break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                continue;
              }
              manifestLoadAttempted = true;
              phases.push(buildPhase('manifest_load', 'failed', error instanceof Error ? error.message : String(error)));
              phases.push(buildPhase('manifest_validation', 'skipped', 'manifest load failed'));
              break;
            }
          }
          if (!manifestLoadAttempted) {
            phases.push(buildPhase('manifest_load', 'skipped', 'plugin.json not present'));
            phases.push(buildPhase('manifest_validation', 'skipped', 'plugin.json not present'));
          }

          const loaded = await this.loadModule(filePath);
          phases.push(buildPhase('instantiation', 'succeeded'));
          const resolved =
            typeof loaded === 'function'
              ? await loaded(ctx)
              : loaded;
          const moduleDef = normalizePluginModule(resolved || {});
          const hooks = moduleDef.hooks ?? {};
          const slot = manifest?.slot ?? moduleDef.slot ?? 'hook';
          let runtime: PluginRuntimeForSlot<PluginSlot> | undefined;

          if (moduleDef.detect) {
            try {
              detected = await moduleDef.detect(ctx);
              phases.push(buildPhase('detect', detected ? 'succeeded' : 'skipped', detected ? undefined : 'detect() returned false'));
            } catch (error) {
              detected = false;
              const message = error instanceof Error ? error.message : String(error);
              phases.push(buildPhase('detect', 'failed', message));
              errors.push({ filePath, error: `detect() failed: ${message}` });
            }
          } else {
            phases.push(buildPhase('detect', 'skipped', 'No detect() hook declared'));
          }

          if (!detected) {
            phases.push(buildPhase('slot_registration', 'skipped', 'Plugin not detected in current environment'));
          } else if (slot === 'hook') {
            runtime = hooks;
            phases.push(buildPhase('slot_registration', 'succeeded'));
          } else if (!moduleDef.create) {
            const message = `${slot} plugins must export create(ctx)`;
            phases.push(buildPhase('slot_registration', 'failed', message));
            errors.push({ filePath, error: message });
          } else {
            try {
              const candidate = await moduleDef.create(ctx);
              const validationError = validateSlotRuntime(slot, candidate);
              if (validationError) {
                phases.push(buildPhase('slot_registration', 'failed', validationError));
                errors.push({ filePath, error: validationError });
              } else {
                runtime = candidate as PluginRuntimeForSlot<PluginSlot>;
                phases.push(buildPhase('slot_registration', 'succeeded'));
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              phases.push(buildPhase('slot_registration', 'failed', message));
              errors.push({ filePath, error: message });
            }
          }

          const ready = detected && runtime !== undefined;
          const loadReport: PluginLoadReport = {
            slot,
            detected,
            ready,
            phases: [
              ...phases,
              buildPhase(
                'ready',
                ready ? 'succeeded' : detected ? 'failed' : 'skipped',
                ready ? undefined : detected ? 'Plugin slot registration failed' : 'Plugin not detected in current environment',
              ),
            ],
          };

          plugins.push({ filePath, hooks, manifest, slot, runtime, loadReport });
        } catch (e) {
          phases.push(buildPhase('instantiation', 'failed', e instanceof Error ? e.message : String(e)));
          phases.push(buildPhase('ready', 'failed', e instanceof Error ? e.message : String(e)));
          errors.push({ filePath, error: e instanceof Error ? e.message : String(e) });
          plugins.push({
            filePath,
            hooks: {},
            slot: manifest?.slot ?? 'hook',
            manifest,
            loadReport: {
              slot: manifest?.slot ?? 'hook',
              detected,
              ready: false,
              phases,
              error: e instanceof Error ? e.message : String(e),
            },
          });
        }
      }
    }
    return { plugins, errors };
  }

  private async getPlugins(workingDirectory: string, ctx: OrchestratorPluginContext): Promise<LoadedPlugin[]> {
    const cached = this.cacheByWorkingDir.get(workingDirectory);
    const now = Date.now();
    if (cached && now - cached.loadedAt < CACHE_TTL_MS) return cached.plugins;

    const { plugins, errors } = await this.loadPluginsForWorkingDirectory(workingDirectory, ctx);
    this.cacheByWorkingDir.set(workingDirectory, {
      loadedAt: now,
      plugins,
      errors,
      scanDirs: this.getPluginDirs(workingDirectory),
    });
    getPluginRegistry().replacePlugins(workingDirectory, plugins.map((plugin) => ({
      workingDirectory,
      filePath: plugin.filePath,
      slot: plugin.slot,
      hooks: plugin.hooks,
      runtime: plugin.runtime,
      manifest: plugin.manifest,
      loadReport: plugin.loadReport,
    })));
    return plugins;
  }

  async listPlugins(workingDirectory: string, instanceManager: InstanceManager): Promise<{
    plugins: { filePath: string; hookKeys: string[]; manifest?: PluginManifest; slot: PluginSlot; loadReport: PluginLoadReport }[];
    scanDirs: string[];
    errors: { filePath: string; error: string }[];
  }> {
    const ctx = this.buildContext(instanceManager);
    const plugins = await this.getPlugins(workingDirectory, ctx);
    const errors = this.cacheByWorkingDir.get(workingDirectory)?.errors || [];
    const list = plugins
      .map((p) => ({
        filePath: p.filePath,
        hookKeys: Object.keys(p.hooks || {}).sort(),
        manifest: p.manifest,
        slot: p.slot,
        loadReport: p.loadReport,
      }))
      .sort((a, b) => a.filePath.localeCompare(b.filePath));
    return {
      plugins: list,
      scanDirs: this.cacheByWorkingDir.get(workingDirectory)?.scanDirs.slice() || [],
      errors: errors.slice(),
    };
  }

  clearCache(workingDirectory?: string): void {
    if (!workingDirectory) {
      this.cacheByWorkingDir.clear();
      this.configLoadedByWorkingDir.clear();
      getPluginRegistry().clear();
      return;
    }
    this.cacheByWorkingDir.delete(workingDirectory);
    this.configLoadedByWorkingDir.delete(workingDirectory);
    getPluginRegistry().clear(workingDirectory);
  }

  private static readonly PLUGIN_TIMEOUT_MS = 5_000;

  private async runPluginOperation(
    plugin: LoadedPlugin,
    label: string,
    operation: () => void | Promise<void>,
  ): Promise<void> {
    try {
      const result = operation();
      if (result instanceof Promise) {
        let timeoutId: ReturnType<typeof setTimeout>;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`Plugin ${label} timeout: ${plugin.filePath}`)),
            OrchestratorPluginManager.PLUGIN_TIMEOUT_MS,
          );
        });
        try {
          await Promise.race([result, timeoutPromise]);
        } finally {
          clearTimeout(timeoutId!);
        }
      }
    } catch (err) {
      logger.warn(`Plugin ${label} error [${plugin.filePath}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async invokeHook<K extends PluginHookEvent>(
    plugin: LoadedPlugin,
    event: K,
    payload: PluginHookPayloads[K],
  ): Promise<void> {
    const hook = plugin.hooks[event];
    if (!hook) return;
    await this.runPluginOperation(plugin, `hook ${String(event)}`, () => hook(payload));
  }

  private async notifyWithPlugins(
    workingDirectory: string,
    ctx: OrchestratorPluginContext,
    notification: PluginNotification,
  ): Promise<void> {
    const plugins = await this.getPlugins(workingDirectory, ctx);
    for (const plugin of plugins) {
      const runtime = plugin.runtime;
      if (plugin.slot !== 'notifier' || !plugin.loadReport.ready || !isNotifierPlugin(runtime)) {
        continue;
      }
      await this.runPluginOperation(plugin, 'notifier', () => runtime.notify(notification));
    }
  }

  private async trackWithPlugins(
    workingDirectory: string,
    ctx: OrchestratorPluginContext,
    event: PluginTrackerEvent,
  ): Promise<void> {
    const plugins = await this.getPlugins(workingDirectory, ctx);
    for (const plugin of plugins) {
      const runtime = plugin.runtime;
      if (plugin.slot !== 'tracker' || !plugin.loadReport.ready || !isTrackerPlugin(runtime)) {
        continue;
      }
      await this.runPluginOperation(plugin, 'tracker', () => runtime.track(event));
    }
  }

  private async exportTelemetryWithPlugins(
    workingDirectory: string,
    ctx: OrchestratorPluginContext,
    record: PluginTelemetryRecord,
  ): Promise<void> {
    const plugins = await this.getPlugins(workingDirectory, ctx);
    for (const plugin of plugins) {
      const runtime = plugin.runtime;
      if (
        plugin.slot !== 'telemetry_exporter'
        || !plugin.loadReport.ready
        || !isTelemetryExporterPlugin(runtime)
      ) {
        continue;
      }
      await this.runPluginOperation(plugin, 'telemetry_exporter', () => runtime.export(record));
    }
  }

  private async emitConfigLoadedIfNeeded(
    workingDirectory: string,
    plugins: LoadedPlugin[],
  ): Promise<void> {
    if (this.configLoadedByWorkingDir.has(workingDirectory)) {
      return;
    }

    this.configLoadedByWorkingDir.add(workingDirectory);
    const config = getSettingsManager().getAll() as unknown as Record<string, unknown>;
    for (const plugin of plugins) {
      if (plugin.slot !== 'hook' || !plugin.loadReport.ready) {
        continue;
      }
      await this.invokeHook(plugin, 'config.loaded', { config });
    }
  }

  /**
   * Public method for core subsystems to emit plugin hook events.
   * Unlike the private `emitToPlugins`, this doesn't require a working directory
   * or context — it broadcasts to ALL cached plugin instances.
   *
   * Each hook call is wrapped with try/catch and a timeout to prevent
   * misbehaving plugins from crashing or blocking the host.
   */
  async emitHook<K extends PluginHookEvent>(
    event: K,
    payload: PluginHookPayloads[K],
  ): Promise<void> {
    // Broadcast to all cached working directories
    for (const [, entry] of this.cacheByWorkingDir) {
      for (const plugin of entry.plugins) {
        if (plugin.slot !== 'hook' || !plugin.loadReport.ready) {
          continue;
        }
        await this.invokeHook(plugin, event, payload);
      }
    }
  }

  private async emitToPlugins<K extends PluginHookEvent>(
    workingDirectory: string,
    ctx: OrchestratorPluginContext,
    event: K,
    payload: PluginHookPayloads[K],
  ): Promise<void> {
    const plugins = await this.getPlugins(workingDirectory, ctx);
    await this.emitConfigLoadedIfNeeded(workingDirectory, plugins);
    for (const plugin of plugins) {
      if (plugin.slot !== 'hook' || !plugin.loadReport.ready) {
        continue;
      }
      await this.invokeHook(plugin, event, payload);
    }
  }

  private getToolExecutionKey(instanceId: string, toolUseId: string): string {
    return `${instanceId}:${toolUseId}`;
  }

  private rememberToolExecution(instanceId: string, message: OutputMessage): void {
    if (message.type !== 'tool_use' || !isStringRecord(message.metadata)) {
      return;
    }

    const toolUseId = typeof message.metadata['id'] === 'string' ? message.metadata['id'] : null;
    const toolName = typeof message.metadata['name'] === 'string' ? message.metadata['name'] : null;
    const input = isStringRecord(message.metadata['input']) ? message.metadata['input'] : {};
    if (!toolUseId || !toolName) {
      return;
    }

    this.activeToolExecutions.set(this.getToolExecutionKey(instanceId, toolUseId), {
      toolName,
      args: input,
      startedAt: message.timestamp,
    });
  }

  private consumeToolExecution(
    instanceId: string,
    message: OutputMessage,
  ): { toolName: string; args: Record<string, unknown>; durationMs: number } | null {
    if (message.type !== 'tool_result' || !isStringRecord(message.metadata)) {
      return null;
    }

    const toolUseId =
      typeof message.metadata['tool_use_id'] === 'string' ? message.metadata['tool_use_id'] : null;
    if (!toolUseId) {
      return null;
    }

    const key = this.getToolExecutionKey(instanceId, toolUseId);
    const execution = this.activeToolExecutions.get(key);
    if (!execution) {
      return null;
    }

    this.activeToolExecutions.delete(key);
    return {
      toolName: execution.toolName,
      args: execution.args,
      durationMs: Math.max(0, message.timestamp - execution.startedAt),
    };
  }

  initialize(instanceManager: InstanceManager): void {
    if (this.initialized) return;
    this.initialized = true;

    const ctx = this.buildContext(instanceManager);

    instanceManager.on('instance:created', (payload: unknown) => {
      const pluginPayload = toInstanceCreatedPayload(payload);
      if (!pluginPayload) return;
      const wd = pluginPayload.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'instance.created', pluginPayload);

      const sessionId = typeof pluginPayload['sessionId'] === 'string'
        ? pluginPayload['sessionId']
        : typeof pluginPayload['historyThreadId'] === 'string'
          ? pluginPayload['historyThreadId']
          : undefined;
      if (sessionId) {
        void this.emitToPlugins(wd, ctx, 'session.created', {
          instanceId: pluginPayload.instanceId,
          sessionId,
        });
      }
    });

    instanceManager.on('instance:removed', (instanceId: string) => {
      void this.emitToPlugins(process.cwd(), ctx, 'instance.removed', { instanceId });
    });

    instanceManager.on('provider:normalized-event', (envelope: ProviderRuntimeEventEnvelope) => {
      const instance = instanceManager.getInstance(envelope.instanceId);
      const wd = instance?.workingDirectory || process.cwd();
      void this.exportTelemetryWithPlugins(wd, ctx, toTelemetryRecord(envelope));

      const pluginPayload = toInstanceOutputPayloadFromEnvelope(envelope);
      if (!pluginPayload) return;
      void this.emitToPlugins(wd, ctx, 'instance.output', pluginPayload);

      if (pluginPayload.message.type === 'tool_use') {
        this.rememberToolExecution(pluginPayload.instanceId, pluginPayload.message);
        if (isStringRecord(pluginPayload.message.metadata)) {
          const toolName = typeof pluginPayload.message.metadata['name'] === 'string'
            ? pluginPayload.message.metadata['name']
            : null;
          const args = isStringRecord(pluginPayload.message.metadata['input'])
            ? pluginPayload.message.metadata['input']
            : {};
          if (toolName) {
            void this.emitToPlugins(wd, ctx, 'tool.execute.before', {
              instanceId: pluginPayload.instanceId,
              toolName,
              args,
            });
          }
        }
        return;
      }

      if (pluginPayload.message.type === 'tool_result') {
        const execution = this.consumeToolExecution(pluginPayload.instanceId, pluginPayload.message);
        if (execution) {
          void this.emitToPlugins(wd, ctx, 'tool.execute.after', {
            instanceId: pluginPayload.instanceId,
            toolName: execution.toolName,
            args: execution.args,
            result: pluginPayload.message.content,
            durationMs: execution.durationMs,
          });
        }
      }
    });

    instanceManager.on('instance:state-update', (payload: unknown) => {
      const pluginPayload = toInstanceStateChangedPayload(payload);
      if (!pluginPayload) return;
      const instance = instanceManager.getInstance(pluginPayload.instanceId);
      const wd = instance?.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'instance.stateChanged', pluginPayload);
    });

    instanceManager.on('instance:input-required', (payload: unknown) => {
      const pluginPayload = toPermissionAskPayload(payload);
      if (!pluginPayload) return;
      const instance = instanceManager.getInstance(pluginPayload.instanceId);
      const wd = instance?.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'permission.ask', pluginPayload);
    });

    const verify = getMultiVerifyCoordinator();
    verify.on('verification:started', (payload: unknown) => {
      const pluginPayload = toVerificationStartedPayload(payload);
      if (!pluginPayload) return;
      const instance = instanceManager.getInstance(pluginPayload.instanceId);
      const wd = instance?.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'verification.started', pluginPayload);
    });
    verify.on('verification:completed', (payload: unknown) => {
      const pluginPayload = toVerificationCompletedPayload(payload);
      if (!pluginPayload) return;
      const instance = pluginPayload.instanceId
        ? instanceManager.getInstance(pluginPayload.instanceId)
        : undefined;
      const wd = instance?.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'verification.completed', pluginPayload);
    });
    verify.on('verification:error', (payload: unknown) => {
      const pluginPayload = toVerificationErrorPayload(payload);
      if (!pluginPayload) return;
      const instance = pluginPayload.instanceId
        ? instanceManager.getInstance(pluginPayload.instanceId)
        : undefined;
      const wd = instance?.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'verification.error', pluginPayload);
    });

    const sessionContinuity = getSessionContinuityManager();
    sessionContinuity.on('session:resumed', (payload: unknown) => {
      const pluginPayload = toSessionResumedPayload(payload);
      if (!pluginPayload) return;
      const instance = instanceManager.getInstance(pluginPayload.instanceId);
      const wd = instance?.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'session.resumed', pluginPayload);
    });
    sessionContinuity.on('session:compacting', (payload: unknown) => {
      const pluginPayload = toSessionCompactingPayload(payload);
      if (!pluginPayload) return;
      const instance = instanceManager.getInstance(pluginPayload.instanceId);
      const wd = instance?.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'session.compacting', pluginPayload);
    });

    const debate = getDebateCoordinator();
    debate.on('debate:round-complete', (payload: unknown) => {
      if (!isRecord(payload) || !isRecord(payload['round'])) {
        return;
      }

      const round = payload['round'];
      const instanceId = typeof payload['instanceId'] === 'string' ? payload['instanceId'] : undefined;
      const wd = instanceId
        ? instanceManager.getInstance(instanceId)?.workingDirectory || process.cwd()
        : process.cwd();
      const debateId = typeof payload['debateId'] === 'string' ? payload['debateId'] : null;
      const totalRounds = typeof payload['totalRounds'] === 'number' ? payload['totalRounds'] : 0;
      const roundNumber = typeof round['roundNumber'] === 'number' ? round['roundNumber'] : 0;
      const contributions = Array.isArray(round['contributions']) ? round['contributions'] : [];
      if (!debateId) {
        return;
      }

      for (const contribution of contributions) {
        if (!isRecord(contribution)) {
          continue;
        }
        const participantId = typeof contribution['agentId'] === 'string'
          ? contribution['agentId']
          : 'unknown';
        const response = typeof contribution['content'] === 'string'
          ? contribution['content']
          : '';
        void this.emitToPlugins(wd, ctx, 'orchestration.debate.round', {
          debateId,
          round: roundNumber,
          totalRounds,
          participantId,
          response,
        });
      }
    });

    const consensus = getConsensusCoordinator();
    consensus.on('consensus:vote', (payload: unknown) => {
      if (!isRecord(payload)) {
        return;
      }
      if (
        typeof payload['queryId'] !== 'string'
        || typeof payload['workingDirectory'] !== 'string'
        || typeof payload['provider'] !== 'string'
        || typeof payload['content'] !== 'string'
        || typeof payload['confidence'] !== 'number'
      ) {
        return;
      }

      void this.emitToPlugins(payload['workingDirectory'], ctx, 'orchestration.consensus.vote', {
        consensusId: payload['queryId'],
        voterId: payload['provider'],
        vote: payload['content'],
        confidence: payload['confidence'],
      });
    });

    const reactions = getReactionEngine();
    reactions.on('reaction:event', (event: ReactionEvent) => {
      const instance = instanceManager.getInstance(event.instanceId);
      const wd = instance?.workingDirectory || process.cwd();
      void this.trackWithPlugins(wd, ctx, toTrackerEvent(event));
    });
    reactions.on('reaction:notify-channels', (payload: unknown) => {
      if (!isRecord(payload) || !isRecord(payload['event'])) {
        return;
      }

      const event = payload['event'];
      if (
        typeof event['type'] !== 'string'
        || typeof event['timestamp'] !== 'number'
        || typeof event['instanceId'] !== 'string'
      ) {
        return;
      }

      const channels = Array.isArray(payload['channels'])
        ? payload['channels'].filter((value): value is string => typeof value === 'string')
        : [];
      const priority = typeof payload['priority'] === 'string' ? payload['priority'] : undefined;
      const reactionEvent: ReactionEvent = {
        id: typeof event['id'] === 'string' ? event['id'] : '',
        type: event['type'] as ReactionEvent['type'],
        priority: typeof event['priority'] === 'string' ? event['priority'] as ReactionEvent['priority'] : 'info',
        instanceId: event['instanceId'],
        timestamp: event['timestamp'],
        data: isRecord(event['data']) ? event['data'] : {},
        ...(typeof event['message'] === 'string' ? { message: event['message'] } : {}),
        ...(typeof event['sessionId'] === 'string' ? { sessionId: event['sessionId'] } : {}),
      };
      const instance = instanceManager.getInstance(reactionEvent.instanceId);
      const wd = instance?.workingDirectory || process.cwd();
      void this.notifyWithPlugins(wd, ctx, toNotificationPayload(reactionEvent, priority, channels));
    });
  }
}

let pluginManager: OrchestratorPluginManager | null = null;
export function getOrchestratorPluginManager(): OrchestratorPluginManager {
  if (!pluginManager) pluginManager = OrchestratorPluginManager.getInstance();
  return pluginManager;
}

export function _resetOrchestratorPluginManagerForTesting(): void {
  pluginManager = null;
  OrchestratorPluginManager._resetForTesting();
}
