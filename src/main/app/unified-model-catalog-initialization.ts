import { getSettingsManager } from '../core/config/settings-manager';
import { getLogger } from '../logging/logger';
import { getCatalogOverrideSource, type CatalogOverrideEntry } from '../providers/catalog-override-source';
import { getCodexCliDiscoveryService } from '../providers/codex-cli-discovery-service';
import { getCursorCopilotCliDiscoveryService } from '../providers/cursor-copilot-cli-discovery-service';
import { getModelsDevService } from '../providers/models-dev-service';
import { getUnifiedModelCatalog } from '../providers/unified-model-catalog-service';
import {
  getLocalModelInventoryService,
  LOCAL_MODEL_INVENTORY_UPDATED_EVENT,
  type LocalModelInventoryUpdatedPayload,
} from '../local-models/local-model-inventory-service';
import type { LocalModelInventoryEntry } from '../../shared/types/local-model-runtime.types';
import type { AppSettings } from '../../shared/types/settings.types';

interface CatalogSettingsManager {
  get<K extends keyof AppSettings>(key: K): AppSettings[K];
  on(event: 'setting-changed', listener: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void): unknown;
  off?(event: 'setting-changed', listener: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void): unknown;
  removeListener?(event: 'setting-changed', listener: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void): unknown;
}

interface ModelCatalogRuntime {
  attachSettingsManager(settingsManager: CatalogSettingsManager): void;
  attachCatalogOverrideSource(source: CatalogOverrideRuntimeSource): void;
  onLocalModelInventoryRefreshed?(
    entries: LocalModelInventoryEntry[],
    options?: { immediate?: boolean },
  ): void;
}

interface CatalogOverrideRuntimeSource {
  startLocal(userDataPath: string): Promise<void>;
  attachSettingsManager(settingsManager: CatalogSettingsManager): void | Promise<void>;
  getEntries(): CatalogOverrideEntry[];
  on(event: 'updated', listener: () => void): unknown;
  off?(event: 'updated', listener: () => void): unknown;
  removeListener?(event: 'updated', listener: () => void): unknown;
}

interface ModelsDevRuntimeService {
  loadOfflineSnapshot(): void;
  refresh(): Promise<unknown>;
}

interface CodexDiscoveryRuntimeService {
  start(): void;
}

interface CursorCopilotDiscoveryRuntimeService {
  start(): void;
}

interface LocalModelInventoryRuntimeService {
  list(): LocalModelInventoryEntry[];
  refresh?(): Promise<LocalModelInventoryEntry[]> | LocalModelInventoryEntry[];
  on(
    event: typeof LOCAL_MODEL_INVENTORY_UPDATED_EVENT,
    listener: (payload: LocalModelInventoryUpdatedPayload) => void,
  ): unknown;
}

interface RuntimeLogger {
  warn(message: string, metadata?: Record<string, unknown>): void;
}

export interface UnifiedModelCatalogRuntimeOptions {
  userDataPath: string;
  settingsManager?: CatalogSettingsManager;
  catalog?: ModelCatalogRuntime;
  catalogOverrideSource?: CatalogOverrideRuntimeSource;
  modelsDevService?: ModelsDevRuntimeService;
  codexDiscoveryService?: CodexDiscoveryRuntimeService;
  cursorCopilotDiscoveryService?: CursorCopilotDiscoveryRuntimeService;
  localModelInventoryService?: LocalModelInventoryRuntimeService;
  logger?: RuntimeLogger;
}

export async function initializeUnifiedModelCatalogRuntime(
  options: UnifiedModelCatalogRuntimeOptions,
): Promise<void> {
  const modelsDevService = options.modelsDevService ?? getModelsDevService();
  const settingsManager = options.settingsManager ?? getSettingsManager();
  const catalog = options.catalog ?? getUnifiedModelCatalog();
  const catalogOverrideSource = options.catalogOverrideSource ?? getCatalogOverrideSource();
  const codexDiscoveryService = options.codexDiscoveryService ?? getCodexCliDiscoveryService();
  const cursorCopilotDiscoveryService = options.cursorCopilotDiscoveryService
    ?? getCursorCopilotCliDiscoveryService();
  const localModelInventoryService = options.localModelInventoryService ?? getLocalModelInventoryService();
  const logger = options.logger ?? getLogger('AppInitialization');

  modelsDevService.loadOfflineSnapshot();
  catalog.attachSettingsManager(settingsManager);

  try {
    await catalogOverrideSource.startLocal(options.userDataPath);
  } catch (error) {
    logger.warn('Local model catalog override initialization failed; continuing without override file', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await catalogOverrideSource.attachSettingsManager(settingsManager);
  } catch (error) {
    logger.warn('Remote model catalog override initialization failed; continuing without remote override', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  catalog.attachCatalogOverrideSource(catalogOverrideSource);
  const localModelEntries = await refreshLocalModelInventory(
    localModelInventoryService,
    logger,
  );
  catalog.onLocalModelInventoryRefreshed?.(localModelEntries, { immediate: true });
  localModelInventoryService.on(LOCAL_MODEL_INVENTORY_UPDATED_EVENT, (payload) => {
    catalog.onLocalModelInventoryRefreshed?.(payload.models);
  });
  codexDiscoveryService.start();
  cursorCopilotDiscoveryService.start();

  modelsDevService.refresh().catch(() => {
    // Suppressed; failure is already logged inside ModelsDevService.
  });
}

async function refreshLocalModelInventory(
  localModelInventoryService: LocalModelInventoryRuntimeService,
  logger: RuntimeLogger,
): Promise<LocalModelInventoryEntry[]> {
  try {
    return localModelInventoryService.refresh
      ? await localModelInventoryService.refresh()
      : localModelInventoryService.list();
  } catch (error) {
    logger.warn('Local model inventory refresh failed; using cached inventory', {
      error: error instanceof Error ? error.message : String(error),
    });
    return localModelInventoryService.list();
  }
}
