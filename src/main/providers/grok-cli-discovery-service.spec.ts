import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelDisplayInfo } from '../../shared/types/provider.types';
import { GrokCliDiscoveryService } from './grok-cli-discovery-service';

describe('GrokCliDiscoveryService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pushes live `grok models` output into the unified catalog under `grok`', async () => {
    const catalog = { onCliDiscoveryRefreshed: vi.fn() };
    const models: ModelDisplayInfo[] = [
      { id: 'grok-4.7', name: 'Grok 4.7', tier: 'powerful', family: 'Grok', pinned: true },
    ];
    const lister = vi.fn().mockResolvedValue(models);
    const service = new GrokCliDiscoveryService({ catalog, lister });

    await service.refreshOnce();

    expect(lister).toHaveBeenCalledTimes(1);
    expect(catalog.onCliDiscoveryRefreshed).toHaveBeenCalledWith('grok', models);
  });

  it('keeps the existing catalog when the CLI is missing, signed out, or unparseable', async () => {
    const catalog = { onCliDiscoveryRefreshed: vi.fn() };
    const failingService = new GrokCliDiscoveryService({
      catalog,
      lister: vi.fn().mockRejectedValue(new Error('spawn grok ENOENT')),
    });
    const emptyService = new GrokCliDiscoveryService({
      catalog,
      lister: vi.fn().mockResolvedValue([]),
    });

    await failingService.refreshOnce();
    await emptyService.refreshOnce();

    expect(catalog.onCliDiscoveryRefreshed).not.toHaveBeenCalled();
  });

  it('coalesces overlapping refreshes onto one in-flight CLI call', async () => {
    const catalog = { onCliDiscoveryRefreshed: vi.fn() };
    let release: (models: ModelDisplayInfo[]) => void = () => {};
    const lister = vi.fn().mockReturnValue(
      new Promise<ModelDisplayInfo[]>((resolve) => {
        release = resolve;
      }),
    );
    const service = new GrokCliDiscoveryService({ catalog, lister });

    const first = service.refreshOnce();
    const second = service.refreshOnce();
    release([{ id: 'grok-4.6', name: 'Grok 4.6', tier: 'powerful' }]);
    await Promise.all([first, second]);

    expect(lister).toHaveBeenCalledTimes(1);
    expect(catalog.onCliDiscoveryRefreshed).toHaveBeenCalledTimes(1);
  });

  it('starts an immediate refresh and continues on the configured interval', async () => {
    vi.useFakeTimers();
    const catalog = { onCliDiscoveryRefreshed: vi.fn() };
    const lister = vi.fn().mockResolvedValue([
      { id: 'grok-4.6', name: 'Grok 4.6', tier: 'powerful' },
    ] satisfies ModelDisplayInfo[]);
    const service = new GrokCliDiscoveryService({ catalog, lister, intervalMs: 1_000 });

    service.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(lister).toHaveBeenCalledTimes(2);

    service.stop();
    vi.useRealTimers();
  });
});
