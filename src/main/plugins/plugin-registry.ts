import type {
  OrchestratorHooks,
  PluginManifest,
  PluginLoadReport,
  PluginRuntimeForSlot,
  PluginSlot,
} from '@sdk/plugins';

export interface RegisteredPlugin {
  workingDirectory: string;
  filePath: string;
  slot: PluginSlot;
  hooks: OrchestratorHooks;
  runtime?: unknown;
  manifest?: PluginManifest;
  loadReport: PluginLoadReport;
}

export class PluginRegistry {
  private readonly byWorkingDirectory = new Map<string, Map<PluginSlot, RegisteredPlugin[]>>();

  replacePlugins(workingDirectory: string, plugins: RegisteredPlugin[]): void {
    const slots = new Map<PluginSlot, RegisteredPlugin[]>();
    for (const plugin of plugins) {
      const existing = slots.get(plugin.slot) ?? [];
      existing.push(plugin);
      slots.set(plugin.slot, existing);
    }
    this.byWorkingDirectory.set(workingDirectory, slots);
  }

  getPlugins(workingDirectory: string, slot?: PluginSlot): RegisteredPlugin[] {
    const slots = this.byWorkingDirectory.get(workingDirectory);
    if (!slots) {
      return [];
    }

    if (slot) {
      return [...(slots.get(slot) ?? [])];
    }

    return Array.from(slots.values()).flatMap((plugins) => plugins);
  }

  getRuntimes<S extends PluginSlot>(workingDirectory: string, slot: S): PluginRuntimeForSlot<S>[] {
    return this.getPlugins(workingDirectory, slot)
      .flatMap((plugin) => {
        if (!plugin.loadReport.ready || plugin.runtime === undefined) {
          return [];
        }
        return [plugin.runtime as PluginRuntimeForSlot<S>];
      });
  }

  getSlots(workingDirectory: string): PluginSlot[] {
    const slots = this.byWorkingDirectory.get(workingDirectory);
    if (!slots) {
      return [];
    }

    return Array.from(slots.keys()).sort();
  }

  clear(workingDirectory?: string): void {
    if (!workingDirectory) {
      this.byWorkingDirectory.clear();
      return;
    }
    this.byWorkingDirectory.delete(workingDirectory);
  }
}

let pluginRegistry: PluginRegistry | null = null;

export function getPluginRegistry(): PluginRegistry {
  if (!pluginRegistry) {
    pluginRegistry = new PluginRegistry();
  }
  return pluginRegistry;
}

export function _resetPluginRegistryForTesting(): void {
  pluginRegistry = null;
}
