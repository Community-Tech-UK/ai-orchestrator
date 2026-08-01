import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import { UsageStore } from '../../core/state/usage.store';
import { SessionPickerController } from './session-picker.controller';

describe('SessionPickerController', () => {
  const instances = signal([
    {
      id: 'inst-1',
      displayName: 'Live session',
      sessionId: 'session-1',
      provider: 'claude',
      currentModel: 'sonnet',
      workingDirectory: '/repo',
      lastActivity: 10,
      status: 'busy',
    },
  ]);
  const historyEntries = signal([
    {
      id: 'hist-1',
      displayName: 'History session',
      firstUserMessage: 'first',
      sessionId: 'session-old',
      provider: 'codex',
      workingDirectory: '/repo',
      endedAt: 5,
      createdAt: 1,
      archivedAt: null,
    },
  ]);
  const instanceStore = {
    instances,
    setSelectedInstance: vi.fn(),
  };
  const historyStore = {
    entries: historyEntries,
    restoreEntry: vi.fn(async () => ({ success: true, instanceId: 'restored-1' })),
  };
  const usageStore = {
    frecency: vi.fn(() => 0),
    record: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        SessionPickerController,
        { provide: InstanceStore, useValue: instanceStore },
        { provide: HistoryStore, useValue: historyStore },
        { provide: UsageStore, useValue: usageStore },
      ],
    });
  });

  it('groups live and history sessions', () => {
    const controller = TestBed.inject(SessionPickerController);

    expect(controller.groups().map((group) => [group.id, group.items.length])).toEqual([
      ['needs-you', 0],
      ['live', 1],
      ['history', 1],
      ['archived', 0],
    ]);
  });

  it('selects live sessions without restoring history', async () => {
    const controller = TestBed.inject(SessionPickerController);
    const liveItem = controller.groups()[1].items[0];

    await controller.run(liveItem);

    expect(instanceStore.setSelectedInstance).toHaveBeenCalledWith('inst-1');
    expect(historyStore.restoreEntry).not.toHaveBeenCalled();
  });

  describe('WS-C2 Needs You grouping (shared attention scale)', () => {
    it('moves a blocked/failed live session into its own Needs You group, ordered most-urgent first', () => {
      instances.set([
        { id: 'a', displayName: 'Working', sessionId: 's-a', provider: 'claude', currentModel: 'sonnet', workingDirectory: '/repo', lastActivity: 10, status: 'busy' },
        { id: 'b', displayName: 'Failed', sessionId: 's-b', provider: 'claude', currentModel: 'sonnet', workingDirectory: '/repo', lastActivity: 10, status: 'error' },
        { id: 'c', displayName: 'Blocked', sessionId: 's-c', provider: 'claude', currentModel: 'sonnet', workingDirectory: '/repo', lastActivity: 10, status: 'waiting_for_permission' },
      ]);
      const controller = TestBed.inject(SessionPickerController);

      const [needsYou, live] = controller.groups();
      expect(needsYou.id).toBe('needs-you');
      // `blocked` outranks `failed` on the shared scale.
      expect(needsYou.items.map((item) => item.value.id)).toEqual(['c', 'b']);
      expect(live.items.map((item) => item.value.id)).toEqual(['a']);
    });

    it('does not move a merely working or waiting session into Needs You', () => {
      instances.set([
        { id: 'a', displayName: 'Working', sessionId: 's-a', provider: 'claude', currentModel: 'sonnet', workingDirectory: '/repo', lastActivity: 10, status: 'busy' },
        { id: 'b', displayName: 'Hibernating', sessionId: 's-b', provider: 'claude', currentModel: 'sonnet', workingDirectory: '/repo', lastActivity: 10, status: 'hibernating' },
      ]);
      const controller = TestBed.inject(SessionPickerController);

      const [needsYou, live] = controller.groups();
      expect(needsYou.items).toHaveLength(0);
      expect(live.items.map((item) => item.value.id).sort()).toEqual(['a', 'b']);
    });
  });
});
