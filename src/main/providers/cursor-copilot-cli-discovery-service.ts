import { CopilotCliAdapter } from '../cli/adapters/copilot-cli-adapter';
import {
  copilotModelInfosToDisplayInfo,
} from '../cli/adapters/copilot-cli-adapter.models';
import { CursorCliAdapter } from '../cli/adapters/cursor-cli-adapter';
import { CURSOR_MODEL_DISCOVERY_CACHE_TTL_MS } from '../cli/adapters/cursor-cli-adapter.models';
import { getLogger } from '../logging/logger';
import type { ModelDisplayInfo } from '../../shared/types/provider.types';
import { getUnifiedModelCatalog } from './unified-model-catalog-service';

const logger = getLogger('CursorCopilotCliDiscovery');

export type CursorCopilotDiscoveryProvider = 'cursor' | 'copilot';

export interface CliDiscoveryCatalogSink {
  onCliDiscoveryRefreshed(provider: string, models: ModelDisplayInfo[]): void;
}

export interface CursorCopilotCliDiscoveryServiceOptions {
  catalog?: CliDiscoveryCatalogSink;
  intervalMs?: number;
  listers?: Partial<
    Record<CursorCopilotDiscoveryProvider, () => Promise<ModelDisplayInfo[]>>
  >;
}

const DEFAULT_LISTERS: Record<
  CursorCopilotDiscoveryProvider,
  () => Promise<ModelDisplayInfo[]>
> = {
  cursor: () => new CursorCliAdapter().listAvailableModels({ fallbackToStatic: false }),
  copilot: async () => copilotModelInfosToDisplayInfo(
    await new CopilotCliAdapter().listAvailableModels(),
  ),
};

export class CursorCopilotCliDiscoveryService {
  private readonly catalog: CliDiscoveryCatalogSink;
  private readonly intervalMs: number;
  private readonly listers: Record<
    CursorCopilotDiscoveryProvider,
    () => Promise<ModelDisplayInfo[]>
  >;
  private refreshInFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CursorCopilotCliDiscoveryServiceOptions = {}) {
    this.catalog = options.catalog ?? getUnifiedModelCatalog();
    this.intervalMs = options.intervalMs ?? CURSOR_MODEL_DISCOVERY_CACHE_TTL_MS;
    this.listers = {
      cursor: options.listers?.cursor ?? DEFAULT_LISTERS.cursor,
      copilot: options.listers?.copilot ?? DEFAULT_LISTERS.copilot,
    };
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }

    void this.refreshOnce();
    this.timer = setInterval(() => {
      void this.refreshOnce();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  refreshOnce(): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    this.refreshInFlight = this.doRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<void> {
    await Promise.all([
      this.refreshProvider('cursor'),
      this.refreshProvider('copilot'),
    ]);
  }

  private async refreshProvider(provider: CursorCopilotDiscoveryProvider): Promise<void> {
    try {
      const models = await this.listers[provider]();
      if (models.length === 0) {
        logger.debug('CLI model discovery returned no live models; keeping existing catalog', {
          provider,
        });
        return;
      }
      this.catalog.onCliDiscoveryRefreshed(provider, models);
      logger.info('CLI models refreshed into unified catalog', { provider, count: models.length });
    } catch (error) {
      logger.warn('CLI model discovery failed; keeping existing catalog', {
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

let cursorCopilotCliDiscoveryService: CursorCopilotCliDiscoveryService | null = null;

export function getCursorCopilotCliDiscoveryService(): CursorCopilotCliDiscoveryService {
  cursorCopilotCliDiscoveryService ??= new CursorCopilotCliDiscoveryService();
  return cursorCopilotCliDiscoveryService;
}

export function _resetCursorCopilotCliDiscoveryServiceForTesting(): void {
  cursorCopilotCliDiscoveryService?.stop();
  cursorCopilotCliDiscoveryService = null;
}
