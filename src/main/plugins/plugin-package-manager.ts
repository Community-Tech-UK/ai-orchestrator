import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PluginManifestSchema } from '@contracts/schemas/plugin';
import { PluginDependencyResolver } from './plugin-dependency-resolver';
import { PluginInstallStore, type RuntimePluginPackage, type RuntimePluginPackageStatus } from './plugin-install-store';
import { PluginSourceResolver, type PluginPackageSource } from './plugin-source-resolver';
import { PluginValidator, type PluginValidationResult } from './plugin-validator';

export interface PluginPackageManagerOptions {
  pluginRoot?: string;
  storePath?: string;
  sourceResolver?: PluginSourceResolver;
  validator?: PluginValidator;
  installStore?: PluginInstallStore;
  clearPluginCache?: () => void | Promise<void>;
}

export interface RuntimePluginPruneOptions {
  dryRun?: boolean;
}

export interface RuntimePluginPruneResult {
  removed: string[];
}

export class PluginPackageManager {
  private readonly pluginRoot: string;
  private readonly store: PluginInstallStore;
  private readonly sourceResolver: PluginSourceResolver;
  private readonly validator: PluginValidator;
  private readonly clearPluginCache?: () => void | Promise<void>;

  constructor(options: PluginPackageManagerOptions = {}) {
    this.pluginRoot = options.pluginRoot ?? path.join(os.homedir(), '.orchestrator', 'plugins');
    this.store = options.installStore ?? new PluginInstallStore(
      options.storePath ?? path.join(this.pluginRoot, '.runtime-plugin-installs.json'),
    );
    this.sourceResolver = options.sourceResolver ?? new PluginSourceResolver();
    this.validator = options.validator ?? new PluginValidator(new PluginDependencyResolver(
      async () => (await this.list()).filter((plugin) => plugin.status === 'installed'),
    ));
    this.clearPluginCache = options.clearPluginCache;
  }

  async list(): Promise<RuntimePluginPackage[]> {
    const plugins = await this.store.list();
    return Promise.all(plugins.map(async (plugin) => ({
      ...plugin,
      status: await this.resolveRuntimePluginStatus(plugin),
    })));
  }

  async validate(source: PluginPackageSource): Promise<PluginValidationResult> {
    const resolved = await this.sourceResolver.resolve(source);
    try {
      return await this.validator.validate(resolved.stagedPath, {
        expectedChecksum: source.checksum,
        checksumPath: resolved.checksumPath,
      });
    } finally {
      await resolved.cleanup();
    }
  }

  async install(source: PluginPackageSource): Promise<RuntimePluginPackage> {
    return this.installValidatedSource(source);
  }

  async update(pluginId: string, source?: PluginPackageSource): Promise<RuntimePluginPackage> {
    const current = await this.store.get(pluginId);
    if (!current) {
      throw new Error(`Runtime plugin is not installed: ${pluginId}`);
    }

    return this.installValidatedSource(source ?? current.source, pluginId);
  }

  async prune(options: RuntimePluginPruneOptions = {}): Promise<RuntimePluginPruneResult> {
    const plugins = await this.list();
    const removed: string[] = [];
    for (const plugin of plugins) {
      if (plugin.status === 'installed') {
        continue;
      }
      if (!options.dryRun) {
        if (plugin.status !== 'missing') {
          await fs.rm(this.resolveManagedPluginPath(plugin.installPath), { recursive: true, force: true });
        }
        await this.store.delete(plugin.id);
      }
      removed.push(plugin.id);
    }
    if (removed.length > 0 && !options.dryRun) {
      await this.clearRuntimePluginCache();
    }
    return { removed };
  }

  async uninstall(pluginId: string): Promise<void> {
    const current = await this.store.get(pluginId);
    const installPath = current?.installPath
      ? this.resolveManagedPluginPath(current.installPath)
      : this.pluginInstallPath(pluginId);
    await fs.rm(installPath, { recursive: true, force: true });
    await this.store.delete(pluginId);
    await this.clearRuntimePluginCache();
  }

  private async installValidatedSource(
    source: PluginPackageSource,
    expectedPluginId?: string,
  ): Promise<RuntimePluginPackage> {
    const resolved = await this.sourceResolver.resolve(source);
    try {
      const validation = await this.validator.validate(resolved.stagedPath, {
        expectedChecksum: source.checksum,
        checksumPath: resolved.checksumPath,
      });
      if (!validation.ok) {
        throw new Error(`Runtime plugin validation failed: ${validation.errors.join('; ')}`);
      }

      const id = sanitizePluginId(validation.manifest.name);
      if (expectedPluginId && id !== expectedPluginId) {
        throw new Error(`Runtime plugin update changed id from ${expectedPluginId} to ${id}`);
      }

      const installPath = this.pluginInstallPath(id);
      await this.replacePluginDirectory(resolved.stagedPath, installPath, id);
      const installed: RuntimePluginPackage = {
        id,
        name: validation.manifest.name,
        version: validation.manifest.version,
        status: 'installed',
        source,
        installPath,
        cachePath: installPath,
        lastValidationResult: validation,
        lastUpdatedAt: Date.now(),
      };
      await this.store.upsert(installed);
      await this.clearRuntimePluginCache();
      return installed;
    } finally {
      await resolved.cleanup();
    }
  }

  private async replacePluginDirectory(
    stagedPath: string,
    installPath: string,
    pluginId: string,
  ): Promise<void> {
    await fs.mkdir(this.pluginRoot, { recursive: true });
    const tempInstallPath = path.join(this.pluginRoot, `.installing-${pluginId}-${process.pid}-${Date.now()}`);
    const backupPath = path.join(this.pluginRoot, `.backup-${pluginId}-${process.pid}-${Date.now()}`);
    const hadExisting = await pathExists(installPath);

    await fs.rm(tempInstallPath, { recursive: true, force: true });
    await fs.cp(stagedPath, tempInstallPath, { recursive: true });

    try {
      if (hadExisting) {
        await fs.rm(backupPath, { recursive: true, force: true });
        await fs.rename(installPath, backupPath);
      }
      await fs.rename(tempInstallPath, installPath);
      await fs.rm(backupPath, { recursive: true, force: true });
    } catch (error) {
      await fs.rm(tempInstallPath, { recursive: true, force: true });
      await fs.rm(installPath, { recursive: true, force: true });
      if (hadExisting && await pathExists(backupPath)) {
        await fs.rename(backupPath, installPath);
      }
      throw error;
    }
  }

  private async clearRuntimePluginCache(): Promise<void> {
    if (this.clearPluginCache) {
      await this.clearPluginCache();
      return;
    }

    try {
      const { getOrchestratorPluginManager } = await import('./plugin-manager');
      getOrchestratorPluginManager().clearCache();
    } catch {
      // Tests and headless tooling may not have Electron's plugin manager loaded.
    }
  }

  private pluginInstallPath(pluginId: string): string {
    return this.resolveManagedPluginPath(path.join(this.pluginRoot, sanitizePluginId(pluginId)));
  }

  private async resolveRuntimePluginStatus(plugin: RuntimePluginPackage): Promise<RuntimePluginPackageStatus> {
    if (!await pathExists(plugin.installPath)) {
      return 'missing';
    }
    if (plugin.status === 'disabled') {
      return 'disabled';
    }
    return await hasValidRuntimePluginManifest(plugin.installPath) ? 'installed' : 'broken';
  }

  private resolveManagedPluginPath(candidatePath: string): string {
    const root = path.resolve(this.pluginRoot);
    const resolved = path.resolve(candidatePath);
    const relative = path.relative(root, resolved);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Runtime plugin path is outside managed plugin root: ${resolved}`);
    }
    return resolved;
  }
}

export function sanitizePluginId(name: string): string {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!id || id === '.' || id === '..') {
    throw new Error('Plugin name does not produce a safe id');
  }
  return id;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasValidRuntimePluginManifest(installPath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(installPath, '.codex-plugin', 'plugin.json'), 'utf-8');
    return PluginManifestSchema.safeParse(JSON.parse(raw) as unknown).success;
  } catch {
    return false;
  }
}
