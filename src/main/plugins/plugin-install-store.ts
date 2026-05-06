import * as fs from 'fs/promises';
import * as path from 'path';
import type { PluginPackageSource } from './plugin-source-resolver';
import type { PluginValidationResult } from './plugin-validator';

export type RuntimePluginPackageStatus = 'installed' | 'missing' | 'disabled' | 'broken';

export interface RuntimePluginPackage {
  id: string;
  name: string;
  version: string;
  status: RuntimePluginPackageStatus;
  source: PluginPackageSource;
  installPath: string;
  cachePath: string;
  lastValidationResult: PluginValidationResult;
  lastUpdatedAt: number;
}

interface PluginInstallStoreFile {
  packages: RuntimePluginPackage[];
}

export class PluginInstallStore {
  constructor(private readonly storePath: string) {}

  async list(): Promise<RuntimePluginPackage[]> {
    const file = await this.read();
    return file.packages.map((plugin) => ({ ...plugin }));
  }

  async get(pluginId: string): Promise<RuntimePluginPackage | null> {
    const plugins = await this.list();
    return plugins.find((plugin) => plugin.id === pluginId) ?? null;
  }

  async upsert(plugin: RuntimePluginPackage): Promise<void> {
    const file = await this.read();
    const next = file.packages.filter((entry) => entry.id !== plugin.id);
    next.push(plugin);
    next.sort((a, b) => a.id.localeCompare(b.id));
    await this.write({ packages: next });
  }

  async delete(pluginId: string): Promise<void> {
    const file = await this.read();
    await this.write({
      packages: file.packages.filter((entry) => entry.id !== pluginId),
    });
  }

  private async read(): Promise<PluginInstallStoreFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.storePath, 'utf-8')) as unknown;
      if (!isStoreFile(parsed)) {
        return { packages: [] };
      }
      return { packages: parsed.packages };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { packages: [] };
      }
      throw error;
    }
  }

  private async write(file: PluginInstallStoreFile): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    const tempPath = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(file, null, 2), 'utf-8');
    await fs.rename(tempPath, this.storePath);
  }
}

function isStoreFile(value: unknown): value is PluginInstallStoreFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as { packages?: unknown };
  return Array.isArray(record.packages);
}
