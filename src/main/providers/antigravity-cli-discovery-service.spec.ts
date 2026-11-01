import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelDisplayInfo } from '../../shared/types/provider.types';
import { AntigravityCliDiscoveryService } from './antigravity-cli-discovery-service';

describe('AntigravityCliDiscoveryService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pushes live `agy models` output into the unified catalog under `antigravity`', async () => {
    const catalog = { onCliDiscoveryRefreshed: vi.fn() };
    const models: ModelDisplayInfo[] = [
      { id: 'Gemini 5 Boron (Medium)', name: 'Gemini 5 Boron (Medium)', tier: 'powerful', family: 'Gemini Pro', pinned: true },
    ];
    const lister = vi.fn().mockResolvedValue(models);
    const service = new AntigravityCliDiscoveryService({ catalog, lister });

    await service.refreshOnce();

    expect(lister).toHaveBeenCalledTimes(1);
    expect(catalog.onCliDiscoveryRefreshed).toHaveBeenCalledWith('antigravity', models);
  });

  it('keeps the existing catalog when the CLI is missing, signed out, or unparseable', async () => {
    const catalog = { onCliDiscoveryRefreshed: vi.fn() };
    const failingService = new AntigravityCliDiscoveryService({
      catalog,
      lister: vi.fn().mockRejectedValue(new Error('spawn agy ENOENT')),
    });
    const emptyService = new AntigravityCliDiscoveryService({
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
    const service = new AntigravityCliDiscoveryService({ catalog, lister });

    const first = service.refreshOnce();
    const second = service.refreshOnce();
    release([{ id: 'Gemini 3.8 Flash (Medium)', name: 'Gemini 3.8 Flash (Medium)', tier: 'balanced' }]);
    await Promise.all([first, second]);

    expect(lister).toHaveBeenCalledTimes(1);
    expect(catalog.onCliDiscoveryRefreshed).toHaveBeenCalledTimes(1);
  });

  it('starts an immediate refresh and continues on the configured interval', async () => {
    vi.useFakeTimers();
    const catalog = { onCliDiscoveryRefreshed: vi.fn() };
    const lister = vi.fn().mockResolvedValue([
      { id: 'Gemini 3.8 Flash (Medium)', name: 'Gemini 3.8 Flash (Medium)', tier: 'balanced' },
    ] satisfies ModelDisplayInfo[]);
    const service = new AntigravityCliDiscoveryService({ catalog, lister, intervalMs: 1_000 });

    service.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(lister).toHaveBeenCalledTimes(2);

    service.stop();
    vi.useRealTimers();
  });
});
