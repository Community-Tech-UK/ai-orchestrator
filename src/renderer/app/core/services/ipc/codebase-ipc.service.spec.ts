import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronIpcService } from './electron-ipc.service';
import { CodebaseIpcService } from './codebase-ipc.service';
import type { IpcResponse } from './electron-ipc.service';
import type { IndexingProgress } from '../../../../../shared/types/codebase.types';

type GetIndexingStatus = (
  workspacePath?: string,
  target?: 'codemem' | 'legacy',
) => Promise<IpcResponse<IndexingProgress | null | Record<string, unknown>>>;

describe('CodebaseIpcService', () => {
  const api = {
    codebaseIndexStatus: vi.fn(),
    onCodebaseIndexProgress: vi.fn(),
    onCodebaseWatcherChanges: vi.fn(),
    onCodebaseAutoStatusChanged: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.codebaseIndexStatus.mockResolvedValue({ success: true, data: null });
    api.onCodebaseIndexProgress.mockReturnValue(() => undefined);
    api.onCodebaseWatcherChanges.mockReturnValue(() => undefined);
    api.onCodebaseAutoStatusChanged.mockReturnValue(() => undefined);

    TestBed.configureTestingModule({
      providers: [
        CodebaseIpcService,
        {
          provide: ElectronIpcService,
          useValue: {
            getApi: () => api,
            getNgZone: () => ({ run: (fn: () => void) => fn() }),
          },
        },
      ],
    });
  });

  it('delegates legacy indexing status requests to the preload API with the target', async () => {
    const service = TestBed.inject(CodebaseIpcService);
    const getIndexingStatus = service.getIndexingStatus as GetIndexingStatus;

    await getIndexingStatus.call(service, '/repo', 'legacy');

    expect(api.codebaseIndexStatus).toHaveBeenCalledWith('/repo', 'legacy');
  });
});
