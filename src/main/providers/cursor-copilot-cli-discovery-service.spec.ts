import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelDisplayInfo } from '../../shared/types/provider.types';
import {
  CursorCopilotCliDiscoveryService,
  _resetCursorCopilotCliDiscoveryServiceForTesting,
} from './cursor-copilot-cli-discovery-service';

describe('CursorCopilotCliDiscoveryService', () => {
  afterEach(() => {
    _resetCursorCopilotCliDiscoveryServiceForTesting();
    vi.restoreAllMocks();
  });

  it('pushes live Cursor and Copilot models into the unified catalog', async () => {
    const catalog = {
      onCliDiscoveryRefreshed: vi.fn(),
    };
    const cursorModels: ModelDisplayInfo[] = [
      { id: 'composer-2.5', name: 'Composer 2.5', tier: 'balanced' },
    ];
    const copilotModels: ModelDisplayInfo[] = [
      { id: 'gpt-5.5', name: 'GPT-5.5', tier: 'balanced' },
    ];
    const service = new CursorCopilotCliDiscoveryService({
      catalog,
      listers: {
        cursor: vi.fn().mockResolvedValue(cursorModels),
        copilot: vi.fn().mockResolvedValue(copilotModels),
      },
    });

    await service.refreshOnce();

    expect(catalog.onCliDiscoveryRefreshed).toHaveBeenCalledWith('cursor', cursorModels);
    expect(catalog.onCliDiscoveryRefreshed).toHaveBeenCalledWith('copilot', copilotModels);
  });

  it('does not update catalog provenance when live discovery fails or returns no models', async () => {
    const catalog = {
      onCliDiscoveryRefreshed: vi.fn(),
    };
    const failingService = new CursorCopilotCliDiscoveryService({
      catalog,
      listers: {
        cursor: vi.fn().mockRejectedValue(new Error('cursor-agent missing')),
        copilot: vi.fn().mockResolvedValue([]),
      },
    });
    const emptyService = new CursorCopilotCliDiscoveryService({
      catalog,
      listers: {
        cursor: vi.fn().mockResolvedValue([]),
        copilot: vi.fn().mockRejectedValue(new Error('copilot help config parse failed')),
      },
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
    const cursorLister = vi.fn().mockResolvedValue([
      { id: 'composer-2.5', name: 'Composer 2.5', tier: 'balanced' },
    ] satisfies ModelDisplayInfo[]);
    const copilotLister = vi.fn().mockResolvedValue([
      { id: 'gpt-5.5', name: 'GPT-5.5', tier: 'balanced' },
    ] satisfies ModelDisplayInfo[]);
    const service = new CursorCopilotCliDiscoveryService({
      catalog,
      listers: {
        cursor: cursorLister,
        copilot: copilotLister,
      },
      intervalMs: 1_000,
    });

    service.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(cursorLister).toHaveBeenCalledTimes(2);
    expect(copilotLister).toHaveBeenCalledTimes(2);

    service.stop();
    vi.useRealTimers();
  });
});
