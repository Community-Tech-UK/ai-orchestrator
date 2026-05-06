import type { ValidatedPluginManifest } from '@contracts/schemas/plugin';

export interface InstalledPluginSummary {
  id: string;
  name: string;
  version?: string;
}

export interface PluginDependencyCheck {
  errors: string[];
  warnings: string[];
}

export class PluginDependencyResolver {
  constructor(
    private readonly listInstalled: () => Promise<InstalledPluginSummary[]>,
  ) {}

  async check(manifest: ValidatedPluginManifest): Promise<PluginDependencyCheck> {
    const dependencies = manifest.dependencies ?? [];
    if (dependencies.length === 0) {
      return { errors: [], warnings: [] };
    }

    const installed = await this.listInstalled();
    const installedNames = new Set(installed.flatMap((plugin) => [plugin.id, plugin.name]));
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const dependency of dependencies) {
      if (installedNames.has(dependency.name)) {
        continue;
      }
      const message = `Missing plugin dependency: ${dependency.name}`;
      if (dependency.optional) {
        warnings.push(`${message} (optional)`);
      } else {
        errors.push(message);
      }
    }

    return { errors, warnings };
  }
}
