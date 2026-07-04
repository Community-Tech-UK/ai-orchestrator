import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../../shared/types/ipc.types';

const routerMocks = vi.hoisted(() => ({
  modelRouter: {
    getConfig: vi.fn(() => ({})),
    updateConfig: vi.fn(),
    route: vi.fn(() => ({ provider: 'claude', model: 'opus', reason: 'test' })),
    getRoutingExplanation: vi.fn(() => 'test explanation'),
    getModelTier: vi.fn(() => 'premium'),
  },
  hotModelSwitcher: {
    getConfig: vi.fn(() => ({})),
    configure: vi.fn(),
    getStats: vi.fn(() => ({})),
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../routing/model-router', () => ({
  getModelRouter: () => routerMocks.modelRouter,
}));

vi.mock('../../../routing/hot-model-switcher', () => ({
  getHotModelSwitcher: () => routerMocks.hotModelSwitcher,
}));

import { registerRoutingHandlers } from '../routing-handlers';

type HandlerFn = (
  event: unknown,
  payload: unknown,
) => Promise<{ success: boolean; data?: unknown; error?: { message: string } }>;

const maxCatalogModelId = `${'m'.repeat(509)}-v1`;
const tooLongCatalogModelId = `${'m'.repeat(510)}-v1`;

function handlerFor(channel: string): HandlerFn {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel);
  if (!call) throw new Error(`no handler registered for ${channel}`);
  return call[1] as unknown as HandlerFn;
}

describe('registerRoutingHandlers', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear();
    routerMocks.modelRouter.getModelTier.mockClear();
    routerMocks.modelRouter.getModelTier.mockReturnValue('premium');
    registerRoutingHandlers();
  });

  it('accepts model-tier lookups up to the dynamic catalog limit', async () => {
    expect(maxCatalogModelId).toHaveLength(512);

    const result = await handlerFor(IPC_CHANNELS.ROUTING_GET_TIER)({}, {
      modelId: maxCatalogModelId,
    });

    expect(result).toEqual({
      success: true,
      data: { modelId: maxCatalogModelId, tier: 'premium' },
    });
    expect(routerMocks.modelRouter.getModelTier).toHaveBeenCalledWith(maxCatalogModelId);
  });

  it('rejects model-tier lookups beyond the dynamic catalog limit', async () => {
    expect(tooLongCatalogModelId).toHaveLength(513);

    const result = await handlerFor(IPC_CHANNELS.ROUTING_GET_TIER)({}, {
      modelId: tooLongCatalogModelId,
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeTruthy();
    expect(routerMocks.modelRouter.getModelTier).not.toHaveBeenCalled();
  });
});
