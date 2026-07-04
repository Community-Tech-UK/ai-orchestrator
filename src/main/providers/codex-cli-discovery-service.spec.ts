import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelDisplayInfo } from '../../shared/types/provider.types';
import { CodexCliDiscoveryService } from './codex-cli-discovery-service';

describe('CodexCliDiscoveryService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pushes live Codex app-server models into the unified catalog', async () => {
    const catalog = {
      onCliDiscoveryRefreshed: vi.fn(),
    };
    const models: ModelDisplayInfo[] = [
      { id: 'gpt-5.9-codex', name: 'GPT-5.9 Codex', tier: 'balanced' },
    ];
    const lister = vi.fn().mockResolvedValue(models);
    const service = new CodexCliDiscoveryService({ catalog, lister });

    await service.refreshOnce();

    expect(lister).toHaveBeenCalledTimes(1);
    expect(catalog.onCliDiscoveryRefreshed).toHaveBeenCalledWith('codex', models);
  });

  it('does not update catalog provenance when live discovery fails or returns no models', async () => {
    const catalog = {
      onCliDiscoveryRefreshed: vi.fn(),
    };
    const failingService = new CodexCliDiscoveryService({
      catalog,
      lister: vi.fn().mockRejectedValue(new Error('model/list unsupported')),
    });
    const emptyService = new CodexCliDiscoveryService({
      catalog,
      lister: vi.fn().mockResolvedValue([]),
    });

    await failingService.refreshOnce();
    await emptyService.refreshOnce();

    expect(catalog.onCliDiscoveryRefreshed).not.toHaveBeenCalled();
  });

  it('starts an immediate refresh and continues on the configured interval', async () => {
    vi.useFakeTimers();
    const catalog = {
      onCliDiscoveryRefreshed: vi.fn(),
    };
    const lister = vi.fn().mockResolvedValue([
      { id: 'gpt-5.9-codex', name: 'GPT-5.9 Codex', tier: 'balanced' },
    ] satisfies ModelDisplayInfo[]);
    const service = new CodexCliDiscoveryService({
      catalog,
      lister,
      intervalMs: 1_000,
    });

    service.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(lister).toHaveBeenCalledTimes(2);

    service.stop();
    vi.useRealTimers();
  });
});
