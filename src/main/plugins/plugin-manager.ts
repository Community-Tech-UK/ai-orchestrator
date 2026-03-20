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
import { app } from 'electron';
import type { InstanceManager } from '../instance/instance-manager';
import { getMultiVerifyCoordinator } from '../orchestration/multi-verify-coordinator';
import { getLogger } from '../logging/logger';

const logger = getLogger('PluginManager');

export interface OrchestratorPluginContext {
  instanceManager: InstanceManager;
  appPath: string;
  homeDir: string | null;
}

export type OrchestratorHooks = Partial<Record<string, (payload: any) => void | Promise<void>>>;
export type OrchestratorPluginModule =
  | OrchestratorHooks
  | ((ctx: OrchestratorPluginContext) => OrchestratorHooks | Promise<OrchestratorHooks>);

interface LoadedPlugin {
  filePath: string;
  hooks: OrchestratorHooks;
}

interface CacheEntry {
  loadedAt: number;
  plugins: LoadedPlugin[];
  errors: Array<{ filePath: string; error: string }>;
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
      let entries: Array<import('fs').Dirent>;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch (e) {
        logger.debug('Failed to read plugin directory during walk', { dir: current, error: String(e) });
        continue;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
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

  private loadModule(filePath: string): OrchestratorPluginModule {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      delete require.cache[require.resolve(filePath)];
    } catch (error) {
      logger.warn('Failed to clear module cache for plugin file', { filePath, error: error instanceof Error ? error.message : String(error) });
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(filePath);
    return (mod && (mod.default || mod)) as OrchestratorPluginModule;
  }

  private async loadPluginsForWorkingDirectory(workingDirectory: string, ctx: OrchestratorPluginContext): Promise<LoadedPlugin[]> {
    const plugins: LoadedPlugin[] = [];
    const errors: Array<{ filePath: string; error: string }> = [];
    const dirs = this.getPluginDirs(workingDirectory);
    for (const dir of dirs) {
      const files = await this.walkJsFiles(dir);
      for (const filePath of files) {
        try {
          const mod = this.loadModule(filePath);
          const hooks: OrchestratorHooks =
            typeof mod === 'function' ? await mod(ctx) : (mod || {});
          plugins.push({ filePath, hooks });
        } catch (e) {
          errors.push({ filePath, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    // Store errors into cache entry via a side-channel; caller sets cache.
    (plugins as any).__errors = errors;
    return plugins;
  }

  private async getPlugins(workingDirectory: string, ctx: OrchestratorPluginContext): Promise<LoadedPlugin[]> {
    const cached = this.cacheByWorkingDir.get(workingDirectory);
    const now = Date.now();
    if (cached && now - cached.loadedAt < CACHE_TTL_MS) return cached.plugins;

    const plugins = await this.loadPluginsForWorkingDirectory(workingDirectory, ctx);
    const errors = ((plugins as any).__errors as Array<{ filePath: string; error: string }>) || [];
    this.cacheByWorkingDir.set(workingDirectory, { loadedAt: now, plugins, errors });
    return plugins;
  }

  async listPlugins(workingDirectory: string, instanceManager: InstanceManager): Promise<{
    plugins: Array<{ filePath: string; hookKeys: string[] }>;
    scanDirs: string[];
    errors: Array<{ filePath: string; error: string }>;
  }> {
    const ctx = this.buildContext(instanceManager);
    const plugins = await this.getPlugins(workingDirectory, ctx);
    const errors = this.cacheByWorkingDir.get(workingDirectory)?.errors || [];
    const list = plugins
      .map((p) => ({ filePath: p.filePath, hookKeys: Object.keys(p.hooks || {}).sort() }))
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

  private async emitToPlugins(workingDirectory: string, ctx: OrchestratorPluginContext, event: string, payload: any): Promise<void> {
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

    instanceManager.on('instance:created', (payload: any) => {
      const wd = payload?.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'instance.created', payload);
    });

    instanceManager.on('instance:removed', (instanceId: string) => {
      // We don't know WD reliably here; use process.cwd().
      void this.emitToPlugins(process.cwd(), ctx, 'instance.removed', { instanceId });
    });

    instanceManager.on('instance:output', (payload: any) => {
      const instance = instanceManager.getInstance(payload?.instanceId);
      const wd = instance?.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'instance.output', payload);
    });

    const verify = getMultiVerifyCoordinator();
    verify.on('verification:started', (payload: any) => {
      const instance = instanceManager.getInstance(payload?.instanceId);
      const wd = instance?.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'verification.started', payload);
    });
    verify.on('verification:completed', (payload: any) => {
      // `payload` includes `id` but not always instanceId; best-effort lookup.
      const wd = process.cwd();
      void this.emitToPlugins(wd, ctx, 'verification.completed', payload);
    });
    verify.on('verification:error', (payload: any) => {
      const wd = process.cwd();
      void this.emitToPlugins(wd, ctx, 'verification.error', payload);
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
