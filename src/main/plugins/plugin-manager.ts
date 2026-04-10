/**
 * Orchestrator Plugin Manager
 *
 * Loads JS plugins from well-known directories and dispatches events to them.
 * The goal is a stable event surface (similar to how modern coding agents expose hooks),
 * without depending on any external repo runtime code.
 *
 * Plugin locations:
 * - `~/.orchestrator/plugins/**.js`
 * - `<cwd>/.orchestrator/plugins/**.js`
 *
 * Plugin module contract (CommonJS recommended):
 * - `module.exports = async (ctx) => ({ hooks... })` OR `module.exports = { hooks... }`
 *
 * Hooks are plain functions keyed by event name:
 * - `instance.created`
 * - `instance.removed`
 * - `instance.output`
 * - `verification.started`
 * - `verification.completed`
 * - `verification.error`
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { app } from 'electron';
import type { InstanceManager } from '../instance/instance-manager';
import { getMultiVerifyCoordinator } from '../orchestration/multi-verify-coordinator';
import { getLogger } from '../logging/logger';
import type { OutputMessage } from '../../shared/types/instance.types';
import type {
  PluginHookEvent,
  PluginHookPayloads,
  PluginRecord,
  TypedOrchestratorHooks,
} from '../../shared/types/plugin.types';

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

export interface OrchestratorPluginContext {
  instanceManager: InstanceManager;
  appPath: string;
  homeDir: string | null;
}

export type OrchestratorHooks = TypedOrchestratorHooks;
export type OrchestratorPluginModule =
  | OrchestratorHooks
  | ((ctx: OrchestratorPluginContext) => OrchestratorHooks | Promise<OrchestratorHooks>);

interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  hooks?: string[];
}

interface LoadedPlugin {
  filePath: string;
  hooks: TypedOrchestratorHooks;
  manifest?: PluginManifest;
}

interface CacheEntry {
  loadedAt: number;
  plugins: LoadedPlugin[];
  errors: { filePath: string; error: string }[];
}

const CACHE_TTL_MS = 10_000;

export class OrchestratorPluginManager {
  private static instance: OrchestratorPluginManager | null = null;

  private cacheByWorkingDir = new Map<string, CacheEntry>();
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

  private getHomeDir(): string | null {
    try {
      return app.getPath('home');
    } catch {
      return process.env['HOME'] || process.env['USERPROFILE'] || null;
    }
  }

  private getPluginDirs(workingDirectory: string): string[] {
    const dirs: string[] = [];
    const home = this.getHomeDir();
    if (home) dirs.push(path.join(home, '.orchestrator', 'plugins'));
    dirs.push(path.join(workingDirectory, '.orchestrator', 'plugins'));
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
        try {
          const mod = await this.loadModule(filePath);
          const hooks: OrchestratorHooks =
            typeof mod === 'function' ? await mod(ctx) : (mod || {});
          let manifest: PluginManifest | undefined;
          const manifestPath = path.join(path.dirname(filePath), 'plugin.json');
          try {
            const manifestRaw = await fs.readFile(manifestPath, 'utf-8');
            const parsed = JSON.parse(manifestRaw);
            if (typeof parsed.name === 'string' && typeof parsed.version === 'string') {
              manifest = {
                name: parsed.name,
                version: parsed.version,
                description: typeof parsed.description === 'string' ? parsed.description : undefined,
                author: typeof parsed.author === 'string' ? parsed.author : undefined,
                hooks: Array.isArray(parsed.hooks) ? parsed.hooks.filter((h: unknown) => typeof h === 'string') : undefined,
              };
            }
          } catch {
            // No manifest or invalid — that's fine, it's optional
          }
          plugins.push({ filePath, hooks, manifest });
        } catch (e) {
          errors.push({ filePath, error: e instanceof Error ? e.message : String(e) });
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
    this.cacheByWorkingDir.set(workingDirectory, { loadedAt: now, plugins, errors });
    return plugins;
  }

  async listPlugins(workingDirectory: string, instanceManager: InstanceManager): Promise<{
    plugins: { filePath: string; hookKeys: string[]; manifest?: PluginManifest }[];
    scanDirs: string[];
    errors: { filePath: string; error: string }[];
  }> {
    const ctx = this.buildContext(instanceManager);
    const plugins = await this.getPlugins(workingDirectory, ctx);
    const errors = this.cacheByWorkingDir.get(workingDirectory)?.errors || [];
    const list = plugins
      .map((p) => ({ filePath: p.filePath, hookKeys: Object.keys(p.hooks || {}).sort(), manifest: p.manifest }))
      .sort((a, b) => a.filePath.localeCompare(b.filePath));
    return { plugins: list, scanDirs: this.getPluginDirs(workingDirectory), errors: errors.slice() };
  }

  clearCache(workingDirectory?: string): void {
    if (!workingDirectory) {
      this.cacheByWorkingDir.clear();
      return;
    }
    this.cacheByWorkingDir.delete(workingDirectory);
  }

  private static readonly HOOK_TIMEOUT_MS = 5_000;

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
        const hook = plugin.hooks[event];
        if (!hook) continue;
        try {
          const result = hook(payload);
          if (result instanceof Promise) {
            await Promise.race([
              result,
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error(`Plugin hook timeout: ${plugin.filePath}:${String(event)}`)),
                  OrchestratorPluginManager.HOOK_TIMEOUT_MS,
                ),
              ),
            ]);
          }
        } catch (err) {
          logger.warn(`Plugin hook error [${plugin.filePath}:${String(event)}]: ${err instanceof Error ? err.message : String(err)}`);
        }
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
    for (const plugin of plugins) {
      const hook = plugin.hooks[event];
      if (!hook) continue;
      try {
        await hook(payload);
      } catch {
        // Never let plugins crash the host.
      }
    }
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
    });

    instanceManager.on('instance:removed', (instanceId: string) => {
      void this.emitToPlugins(process.cwd(), ctx, 'instance.removed', { instanceId });
    });

    instanceManager.on('instance:output', (payload: unknown) => {
      const pluginPayload = toInstanceOutputPayload(payload);
      if (!pluginPayload) return;
      const instance = instanceManager.getInstance(pluginPayload.instanceId);
      const wd = instance?.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'instance.output', pluginPayload);
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
