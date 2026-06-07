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
  PluginLifecycleState,
  PluginLoadPhase,
  PluginLoadReport,
  PluginNotification,
  PluginPhaseResult,
  PluginRuntimeHealth,
  PluginHookEvent,
  PluginHookPayloads,
  PluginRuntimeForSlot,
  PluginSlot,
  PluginTelemetryRecord,
  PluginTrackerEvent,
  NotifierPlugin,
  TelemetryExporterPlugin,
  TrackerPlugin,
  TypedOrchestratorHooks,
} from '../../shared/types/plugin.types';
import type { PluginManifest } from '@sdk/plugins';
import { PluginManifestSchema } from '@contracts/schemas/plugin';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { getPluginRegistry } from './plugin-registry';
import { PluginWorkerHost, type PluginWorkerContext, type PluginWorkerRuntime } from './plugin-worker-host';
import { resolveProjectScanRoots } from '../util/project-scan-roots';
import type { ReactionEvent } from '../reactions/reaction.types';
import {
  isRecord,
  isStringRecord,
  toInstanceCreatedPayload,
  toInstanceOutputPayloadFromEnvelope,
  toInstanceStateChangedPayload,
  toNotificationPayload,
  toPermissionAskPayload,
  toSessionCompactingPayload,
  toSessionResumedPayload,
  toTelemetryRecord,
  toTrackerEvent,
  toVerificationCompletedPayload,
  toVerificationErrorPayload,
  toVerificationStartedPayload,
} from './plugin-manager-payloads';

const logger = getLogger('PluginManager');

/**
 * Reject paths containing '..' segments to prevent directory escape.
 */
function isPathSafe(filePath: string, baseDir: string): boolean {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(baseDir);
  return resolved.startsWith(resolvedBase + path.sep) || resolved === resolvedBase;
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
  workerHost?: PluginWorkerHost;
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

/** Internal health record — public health plus the on-disk mtime that gates hot-reload recovery. */
interface InternalPluginHealth extends PluginRuntimeHealth {
  /** mtime (ms) of the plugin file at the load that produced this record. */
  loadedMtimeMs?: number;
}

function freshHealth(mtimeMs?: number): InternalPluginHealth {
  return {
    state: 'active',
    totalInvocations: 0,
    totalFailures: 0,
    consecutiveFailures: 0,
    quarantined: false,
    ...(mtimeMs !== undefined ? { loadedMtimeMs: mtimeMs } : {}),
  };
}

/**
 * Derive the surfaced lifecycle state from a plugin's load outcome + runtime health.
 * Load-time outcome decides `failed`/`inactive`; runtime health decides the rest.
 */
function computePluginLifecycle(
  loadReport: PluginLoadReport,
  health: InternalPluginHealth | undefined,
): PluginLifecycleState {
  if (health?.quarantined) return 'quarantined';
  if (!loadReport.ready) {
    return loadReport.detected ? 'failed' : 'inactive';
  }
  if (health && health.consecutiveFailures > 0) return 'degraded';
  return 'active';
}

/** Strip internal-only fields before surfacing health over IPC. */
function toPublicHealth(health: InternalPluginHealth): PluginRuntimeHealth {
  const { loadedMtimeMs: _loadedMtimeMs, ...pub } = health;
  return pub;
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

function shouldUseWorkerIsolation(manifest: PluginManifest | undefined): boolean {
  return manifest?.isolation === 'worker';
}

function getAdvisoryCapabilityWarnings(manifest: PluginManifest | undefined): string[] {
  const capabilities = manifest?.capabilities ?? [];
  return capabilities.filter((capability) => capability === 'network' || capability === 'spawn.process');
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

  /**
   * Per-plugin runtime health, keyed by absolute plugin file path. Survives the
   * 10s cache TTL (a passively-reloaded plugin keeps its quarantine) but is reset
   * when the source file's mtime changes (hot-reload recovery) or on a full
   * cache clear.
   */
  private runtimeHealth = new Map<string, InternalPluginHealth>();

  /** Consecutive runtime failures that trip quarantine (plugin then skipped in dispatch). */
  private static readonly QUARANTINE_THRESHOLD = 3;

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

  private buildContext(): OrchestratorPluginContext {
    return {
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

  private warnForManifestCapabilities(filePath: string, manifest: PluginManifest | undefined): void {
    for (const capability of getAdvisoryCapabilityWarnings(manifest)) {
      logger.warn('Plugin declares advisory capability that is not OS-enforced yet', {
        filePath,
        capability,
      });
    }
  }

  private warnForLegacyIsolation(filePath: string, manifest: PluginManifest | undefined): void {
    if (shouldUseWorkerIsolation(manifest)) {
      return;
    }
    logger.warn('Plugin loaded in legacy in-process isolation; add "isolation": "worker" to plugin.json to isolate dispatches', {
      filePath,
    });
  }

  private async loadWorkerPlugin(
    filePath: string,
    ctx: PluginWorkerContext,
    manifest: PluginManifest | undefined,
    phases: PluginPhaseResult[],
  ): Promise<LoadedPlugin> {
    const workerHost = new PluginWorkerHost({
      filePath,
      context: ctx,
      ...(manifest?.slot ? { requestedSlot: manifest.slot } : manifest?.hooks ? { requestedSlot: 'hook' } : {}),
    });
    const workerRuntime: PluginWorkerRuntime = await workerHost.start();
    phases.push(buildPhase('instantiation', 'succeeded', 'Plugin loaded in worker isolation'));
    phases.push(buildPhase(
      'detect',
      workerRuntime.detected ? 'succeeded' : 'skipped',
      workerRuntime.detected ? undefined : 'detect() returned false',
    ));
    phases.push(buildPhase(
      'slot_registration',
      workerRuntime.ready ? 'succeeded' : workerRuntime.detected ? 'failed' : 'skipped',
      workerRuntime.ready
        ? undefined
        : workerRuntime.detected
          ? 'Worker plugin did not expose a runtime'
          : 'Plugin not detected in current environment',
    ));

    const runtime =
      workerRuntime.slot === 'hook'
        ? workerRuntime.hooks
        : workerRuntime.slot === 'notifier'
          ? workerRuntime.notifier
          : workerRuntime.slot === 'tracker'
            ? workerRuntime.tracker
            : workerRuntime.slot === 'telemetry_exporter'
              ? workerRuntime.telemetryExporter
              : undefined;
    const ready = workerRuntime.detected && workerRuntime.ready && runtime !== undefined;
    const loadReport: PluginLoadReport = {
      slot: workerRuntime.slot,
      detected: workerRuntime.detected,
      ready,
      phases: [
        ...phases,
        buildPhase(
          'ready',
          ready ? 'succeeded' : workerRuntime.detected ? 'failed' : 'skipped',
          ready ? undefined : workerRuntime.detected ? 'Plugin slot registration failed' : 'Plugin not detected in current environment',
        ),
      ],
    };

    return {
      filePath,
      hooks: workerRuntime.hooks,
      manifest,
      slot: workerRuntime.slot,
      runtime: runtime as PluginRuntimeForSlot<PluginSlot> | undefined,
      workerHost,
      loadReport,
    };
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
        let mtimeMs: number | undefined;
        try {
          mtimeMs = (await fs.stat(filePath)).mtimeMs;
        } catch {
          mtimeMs = undefined;
        }
        // Reset health if the file changed on disk (hot-reload recovery), else
        // preserve an existing quarantine across the passive cache-TTL reload.
        this.reconcileHealthOnLoad(filePath, mtimeMs);
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

          this.warnForManifestCapabilities(filePath, manifest);

          if (shouldUseWorkerIsolation(manifest)) {
            plugins.push(await this.loadWorkerPlugin(filePath, ctx, manifest, phases));
            continue;
          }

          this.warnForLegacyIsolation(filePath, manifest);

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

    this.stopCacheWorkers(workingDirectory);
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

  private stopCacheWorkers(workingDirectory?: string): void {
    if (workingDirectory) {
      const cached = this.cacheByWorkingDir.get(workingDirectory);
      for (const plugin of cached?.plugins ?? []) {
        void plugin.workerHost?.stop();
      }
      return;
    }

    for (const entry of this.cacheByWorkingDir.values()) {
      for (const plugin of entry.plugins) {
        void plugin.workerHost?.stop();
      }
    }
  }

  async listPlugins(workingDirectory: string, instanceManager: InstanceManager): Promise<{
    plugins: {
      filePath: string;
      hookKeys: string[];
      manifest?: PluginManifest;
      slot: PluginSlot;
      loadReport: PluginLoadReport;
      lifecycle: PluginLifecycleState;
      health?: PluginRuntimeHealth;
    }[];
    scanDirs: string[];
    errors: { filePath: string; error: string }[];
  }> {
    const ctx = this.buildContext();
    const plugins = await this.getPlugins(workingDirectory, ctx);
    const errors = this.cacheByWorkingDir.get(workingDirectory)?.errors || [];
    const list = plugins
      .map((p) => {
        const health = this.runtimeHealth.get(p.filePath);
        return {
          filePath: p.filePath,
          hookKeys: Object.keys(p.hooks || {}).sort(),
          manifest: p.manifest,
          slot: p.slot,
          loadReport: p.loadReport,
          lifecycle: computePluginLifecycle(p.loadReport, health),
          ...(health ? { health: toPublicHealth(health) } : {}),
        };
      })
      .sort((a, b) => a.filePath.localeCompare(b.filePath));
    return {
      plugins: list,
      scanDirs: this.cacheByWorkingDir.get(workingDirectory)?.scanDirs.slice() || [],
      errors: errors.slice(),
    };
  }

  clearCache(workingDirectory?: string): void {
    if (!workingDirectory) {
      this.stopCacheWorkers();
      this.cacheByWorkingDir.clear();
      this.configLoadedByWorkingDir.clear();
      getPluginRegistry().clear();
      // A full clear is the explicit reset path (tests, post-install): plugins
      // start fresh. A scoped clear is the routine UI-refresh path and must NOT
      // wipe quarantine — that recovers only on a real file change (mtime).
      this.runtimeHealth.clear();
      return;
    }
    this.stopCacheWorkers(workingDirectory);
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
    // Single dispatch chokepoint: a quarantined plugin is skipped everywhere
    // (hooks + every slot runtime) so a pathological plugin can't keep burning
    // the per-call timeout budget or spamming the log on every event.
    if (this.isPluginQuarantined(plugin.filePath)) {
      return;
    }
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
      this.recordPluginSuccess(plugin.filePath);
    } catch (err) {
      this.recordPluginFailure(plugin.filePath, label, err);
      if (this.isPluginQuarantined(plugin.filePath)) {
        void plugin.workerHost?.stop();
      }
    }
  }

  /** True if the plugin at this path is quarantined (skipped in dispatch). */
  isPluginQuarantined(filePath: string): boolean {
    return this.runtimeHealth.get(filePath)?.quarantined === true;
  }

  /** Record a successful dispatch; a degraded (non-quarantined) plugin recovers to active. */
  private recordPluginSuccess(filePath: string): void {
    const health = this.runtimeHealth.get(filePath);
    if (!health) {
      const seeded = freshHealth();
      seeded.totalInvocations = 1;
      this.runtimeHealth.set(filePath, seeded);
      return;
    }
    health.totalInvocations += 1;
    health.consecutiveFailures = 0;
    if (!health.quarantined) {
      health.state = 'active';
    }
  }

  /**
   * Record a failed dispatch. Transitions the plugin to `degraded`, then
   * `quarantined` once the consecutive-failure threshold is crossed.
   */
  private recordPluginFailure(filePath: string, label: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const health = this.runtimeHealth.get(filePath) ?? freshHealth();
    health.totalInvocations += 1;
    health.totalFailures += 1;
    health.consecutiveFailures += 1;
    health.lastError = message;
    health.lastErrorAt = Date.now();
    if (
      !health.quarantined &&
      health.consecutiveFailures >= OrchestratorPluginManager.QUARANTINE_THRESHOLD
    ) {
      health.quarantined = true;
      health.state = 'quarantined';
      health.quarantinedAt = Date.now();
      logger.error(
        `Plugin quarantined after ${health.consecutiveFailures} consecutive failures — ` +
          `skipped in dispatch until its file changes [${filePath}] (last ${label}: ${message})`,
      );
    } else if (!health.quarantined) {
      health.state = 'degraded';
      logger.warn(`Plugin ${label} error [${filePath}]: ${message}`);
    }
    this.runtimeHealth.set(filePath, health);
  }

  /**
   * Reconcile runtime health against the plugin file on each load. A first load
   * seeds a baseline; a changed mtime resets health (hot-reload recovery for a
   * fixed plugin); an unchanged mtime preserves an existing quarantine across the
   * passive cache-TTL reload.
   */
  private reconcileHealthOnLoad(filePath: string, mtimeMs: number | undefined): void {
    const existing = this.runtimeHealth.get(filePath);
    if (!existing) {
      this.runtimeHealth.set(filePath, freshHealth(mtimeMs));
      return;
    }
    if (mtimeMs !== undefined && existing.loadedMtimeMs !== mtimeMs) {
      this.runtimeHealth.set(filePath, freshHealth(mtimeMs));
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

    const ctx = this.buildContext();

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
