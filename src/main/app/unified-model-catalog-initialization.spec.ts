import { describe, expect, it, vi } from 'vitest';
import { initializeUnifiedModelCatalogRuntime } from './unified-model-catalog-initialization';
import type { CatalogOverrideEntry } from '../providers/catalog-override-source';

describe('initializeUnifiedModelCatalogRuntime', () => {
  it('loads override sources before attaching them to the catalog', async () => {
    const events: string[] = [];
    const localEntry = overrideEntry('claude', 'claude-local-opus', 'local');
    const remoteEntry = overrideEntry('gemini', 'gemini-remote-pro', 'remote');
    const source = {
      entries: [] as CatalogOverrideEntry[],
      async startLocal(): Promise<void> {
        events.push('startLocal');
        this.entries = [localEntry];
      },
      async attachSettingsManager(): Promise<void> {
        events.push('attachSettingsManager');
        this.entries = [...this.entries, remoteEntry];
      },
      getEntries(): CatalogOverrideEntry[] {
        return this.entries;
      },
      on: vi.fn(),
    };
    let attachedEntries: CatalogOverrideEntry[] = [];
    const catalog = {
      attachSettingsManager: vi.fn(() => {
        events.push('catalogSettings');
      }),
      attachCatalogOverrideSource: vi.fn((attachedSource: { getEntries: () => CatalogOverrideEntry[] }) => {
        events.push('catalogOverride');
        attachedEntries = attachedSource.getEntries();
      }),
    };
    const modelsDev = {
      loadOfflineSnapshot: vi.fn(() => {
        events.push('offlineSnapshot');
      }),
      refresh: vi.fn(async () => false),
    };
    const codexDiscovery = {
      start: vi.fn(() => {
        events.push('codexDiscovery');
      }),
    };

    await initializeUnifiedModelCatalogRuntime({
      userDataPath: '/tmp/aio-user-data',
      settingsManager: { get: vi.fn(), on: vi.fn() },
      catalog,
      catalogOverrideSource: source,
      modelsDevService: modelsDev,
      codexDiscoveryService: codexDiscovery,
      logger: { warn: vi.fn() },
    });

    expect(events.slice(0, 5)).toEqual([
      'offlineSnapshot',
      'catalogSettings',
      'startLocal',
      'attachSettingsManager',
      'catalogOverride',
    ]);
    expect(attachedEntries.map((entry) => `${entry.provider}:${entry.id}`)).toEqual([
      'claude:claude-local-opus',
      'gemini:gemini-remote-pro',
    ]);
  });
});

function overrideEntry(
  provider: string,
  id: string,
  origin: 'local' | 'remote',
): CatalogOverrideEntry {
  return {
    provider,
    id,
    origin,
    source: 'catalog-override',
    discoveredAt: 123,
  };
}
