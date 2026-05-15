import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronIpcService } from './electron-ipc.service';
import { FileIpcService } from './file-ipc.service';

describe('FileIpcService', () => {
  let invoke: ReturnType<typeof vi.fn>;
  let service: FileIpcService;

  beforeEach(() => {
    invoke = vi.fn().mockResolvedValue({ success: true });

    TestBed.configureTestingModule({
      providers: [
        FileIpcService,
        {
          provide: ElectronIpcService,
          useValue: {
            invoke,
            getApi: () => null,
          },
        },
      ],
    });

    service = TestBed.inject(FileIpcService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('routes legacy editorOpen calls through the handled editor open-file channel', async () => {
    await service.editorOpen('/tmp/review.md', { line: 4, column: 2 });

    expect(invoke).toHaveBeenCalledWith('editor:open-file', {
      filePath: '/tmp/review.md',
      line: 4,
      column: 2,
    });
  });

  it('flattens editorOpenFile options for the main-process schema', async () => {
    await service.editorOpenFile('/tmp/review.md', { waitForClose: true });

    expect(invoke).toHaveBeenCalledWith('editor:open-file', {
      filePath: '/tmp/review.md',
      waitForClose: true,
    });
  });
});
