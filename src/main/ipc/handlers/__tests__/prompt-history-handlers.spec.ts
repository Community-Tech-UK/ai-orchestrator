import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

import { ipcMain } from 'electron';
import { registerPromptHistoryHandlers } from '../prompt-history-handlers';
import { PromptHistoryService } from '../../../prompt-history/prompt-history-service';
import type { PromptHistoryStoreBackend } from '../../../prompt-history/prompt-history-store';
import type { PromptHistoryStoreV1 } from '../../../../shared/types/prompt-history.types';

const fakeEvent = {} as Parameters<Parameters<typeof ipcMain.handle>[1]>[0];

class MemoryPromptHistoryStore implements PromptHistoryStoreBackend {
  private data: PromptHistoryStoreV1 = {
    schemaVersion: 1,
    byInstance: {},
    byProject: {},
  };

  get<K extends keyof PromptHistoryStoreV1>(key: K): PromptHistoryStoreV1[K] {
    return this.data[key];
  }

  set<K extends keyof PromptHistoryStoreV1>(key: K, value: PromptHistoryStoreV1[K]): void {
    this.data = {
      ...this.data,
      [key]: value,
    };
  }
}

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const entry = vi.mocked(ipcMain.handle).mock.calls.find((call) => call[0] === channel);
  if (!entry) {
    throw new Error(`No handler registered for channel: ${channel}`);
  }
  return entry[1] as (...args: unknown[]) => unknown;
}

describe('registerPromptHistoryHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers snapshot, record, and clear handlers', () => {
    registerPromptHistoryHandlers({
      windowManager: { sendToRenderer: vi.fn() },
      service: new PromptHistoryService(new MemoryPromptHistoryStore()),
    });

    expect(ipcMain.handle).toHaveBeenCalledWith('prompt-history:get-snapshot', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('prompt-history:record', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('prompt-history:clear-instance', expect.any(Function));
  });

  it('records a prompt and returns the canonical record', async () => {
    registerPromptHistoryHandlers({
      windowManager: { sendToRenderer: vi.fn() },
      service: new PromptHistoryService(new MemoryPromptHistoryStore()),
    });

    const handler = getHandler('prompt-history:record');
    const result = await handler(fakeEvent, {
      instanceId: 'inst-1',
      entry: { id: 'entry-1', text: 'hello', createdAt: 1 },
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        instanceId: 'inst-1',
        entries: [{ id: 'entry-1', text: 'hello' }],
      },
    });
  });

  it('forwards prompt-history deltas to the renderer', async () => {
    const sendToRenderer = vi.fn();
    registerPromptHistoryHandlers({
      windowManager: { sendToRenderer },
      service: new PromptHistoryService(new MemoryPromptHistoryStore()),
    });

    const handler = getHandler('prompt-history:record');
    await handler(fakeEvent, {
      instanceId: 'inst-1',
      entry: { id: 'entry-1', text: 'hello', createdAt: 1 },
    });

    expect(sendToRenderer).toHaveBeenCalledWith(
      'prompt-history:delta',
      expect.objectContaining({ instanceId: 'inst-1' }),
    );
  });
});
