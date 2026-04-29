import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronIpcService } from '../../services/ipc/electron-ipc.service';
import { CliUpdatePillStore } from '../cli-update-pill.store';

describe('CliUpdatePillStore', () => {
  let deltaCallback: ((state: unknown) => void) | null;
  const api = {
    cliUpdatePillGetState: vi.fn(),
    cliUpdatePillRefresh: vi.fn(),
    onCliUpdatePillDelta: vi.fn((callback: (state: unknown) => void) => {
      deltaCallback = callback;
      return () => {
        deltaCallback = null;
      };
    }),
  };

  beforeEach(() => {
    deltaCallback = null;
    vi.clearAllMocks();
    api.cliUpdatePillGetState.mockResolvedValue({
      success: true,
      data: { generatedAt: 1, count: 0, entries: [] },
    });
    api.cliUpdatePillRefresh.mockResolvedValue({
      success: true,
      data: { generatedAt: 2, count: 1, entries: [{ cli: 'claude' }] },
    });
    TestBed.configureTestingModule({
      providers: [
        CliUpdatePillStore,
        {
          provide: ElectronIpcService,
          useValue: { getApi: () => api },
        },
      ],
    });
  });

  it('loads initial state and applies delta updates', async () => {
    const store = TestBed.inject(CliUpdatePillStore);

    store.init();
    await store.load();
    deltaCallback?.({ generatedAt: 3, count: 2, entries: [{ cli: 'claude' }, { cli: 'codex' }] });

    expect(api.onCliUpdatePillDelta).toHaveBeenCalled();
    expect(store.state().count).toBe(2);
  });

  it('refreshes state through IPC', async () => {
    const store = TestBed.inject(CliUpdatePillStore);

    await store.refresh();

    expect(store.state().count).toBe(1);
    expect(api.cliUpdatePillRefresh).toHaveBeenCalled();
  });
});
