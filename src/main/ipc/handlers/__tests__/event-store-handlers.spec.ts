/**
 * EventStoreHandlers — Unit Tests
 *
 * Mocks `electron` to capture ipcMain.handle registrations, then invokes
 * the captured handlers directly to verify routing behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { ipcMain } from 'electron';
import { registerEventStoreHandlers, unregisterEventStoreHandlers } from '../event-store-handlers';

/** Dummy IPC event object used in tests. */
const fakeEvent = {} as Parameters<Parameters<typeof ipcMain.handle>[1]>[0];

/** Helper: find a registered handler by channel name and cast to a typed callable. */
function getHandler(channel: string): (...args: unknown[]) => unknown {
  const calls = vi.mocked(ipcMain.handle).mock.calls;
  const entry = calls.find(c => c[0] === channel);
  if (!entry) throw new Error(`No handler registered for channel: ${channel}`);
  return entry[1] as (...args: unknown[]) => unknown;
}

describe('EventStoreHandlers', () => {
  const mockDeps = {
    getByAggregateId: vi.fn().mockReturnValue([]),
    getByType: vi.fn().mockReturnValue([]),
    getRecentEvents: vi.fn().mockReturnValue([]),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers all event store handlers', () => {
    registerEventStoreHandlers(mockDeps);
    expect(ipcMain.handle).toHaveBeenCalledTimes(3);
    expect(ipcMain.handle).toHaveBeenCalledWith('events:by-aggregate', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('events:by-type', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('events:recent', expect.any(Function));
  });

  it('by-aggregate handler calls getByAggregateId', async () => {
    registerEventStoreHandlers(mockDeps);
    const handler = getHandler('events:by-aggregate');
    await handler(fakeEvent, 'v-1');
    expect(mockDeps.getByAggregateId).toHaveBeenCalledWith('v-1');
  });

  it('by-type handler calls getByType with type and limit', async () => {
    registerEventStoreHandlers(mockDeps);
    const handler = getHandler('events:by-type');
    await handler(fakeEvent, 'debate.started', 10);
    expect(mockDeps.getByType).toHaveBeenCalledWith('debate.started', 10);
  });

  it('recent handler calls getRecentEvents with limit', async () => {
    registerEventStoreHandlers(mockDeps);
    const handler = getHandler('events:recent');
    await handler(fakeEvent, 25);
    expect(mockDeps.getRecentEvents).toHaveBeenCalledWith(25);
  });

  it('recent handler calls getRecentEvents without limit', async () => {
    registerEventStoreHandlers(mockDeps);
    const handler = getHandler('events:recent');
    await handler(fakeEvent, undefined);
    expect(mockDeps.getRecentEvents).toHaveBeenCalledWith(undefined);
  });

  it('unregisters all handlers', () => {
    unregisterEventStoreHandlers();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('events:by-aggregate');
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('events:by-type');
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('events:recent');
  });

  it('by-aggregate handler returns data from getByAggregateId', async () => {
    const fakeEvents = [{ id: 'evt-1', type: 'verification.requested' }];
    mockDeps.getByAggregateId.mockReturnValue(fakeEvents);

    registerEventStoreHandlers(mockDeps);
    const handler = getHandler('events:by-aggregate');
    const result = await handler(fakeEvent, 'v-1');
    expect(result).toEqual(fakeEvents);
  });
});
