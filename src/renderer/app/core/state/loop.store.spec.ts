import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopIpcService, type LoopStartConfigInput } from '../services/ipc/loop-ipc.service';
import { LoopStore } from './loop.store';

describe('LoopStore', () => {
  let ipc: { start: ReturnType<typeof vi.fn> };
  let store: LoopStore;

  beforeEach(() => {
    TestBed.resetTestingModule();
    ipc = {
      start: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        LoopStore,
        { provide: LoopIpcService, useValue: ipc },
      ],
    });

    store = TestBed.inject(LoopStore);
  });

  it('returns a loop start failure instead of throwing when IPC rejects', async () => {
    ipc.start
      .mockRejectedValueOnce(new Error('preload loopStart failed'))
      .mockResolvedValueOnce({
        success: false,
        error: { message: 'backend rejected start' },
      });

    await expect(store.start('chat-1', validConfig())).resolves.toEqual({
      ok: false,
      error: 'preload loopStart failed',
    });

    await expect(store.start('chat-1', validConfig())).resolves.toEqual({
      ok: false,
      error: 'backend rejected start',
    });
    expect(ipc.start).toHaveBeenCalledTimes(2);
  });
});

function validConfig(): LoopStartConfigInput {
  return {
    initialPrompt: 'continue until done',
    workspaceCwd: '/tmp/project',
    provider: 'claude',
    contextStrategy: 'same-session',
  };
}
