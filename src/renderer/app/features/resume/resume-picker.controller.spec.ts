import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import { UsageStore } from '../../core/state/usage.store';
import { ResumeActionsService } from './resume-actions.service';
import { ResumePickerController } from './resume-picker.controller';

function entry(overrides: Partial<ConversationHistoryEntry> = {}): ConversationHistoryEntry {
  return {
    id: 'entry-1',
    displayName: 'Auth thread',
    createdAt: 1,
    endedAt: 2,
    workingDirectory: '/repo',
    messageCount: 2,
    firstUserMessage: 'Review auth',
    lastUserMessage: 'Fix auth',
    status: 'completed',
    originalInstanceId: 'old-1',
    parentId: null,
    sessionId: 'session-1',
    ...overrides,
  };
}

describe('ResumePickerController', () => {
  const historyEntries = signal<ConversationHistoryEntry[]>([]);
  const instances = signal<unknown[]>([]);
  const selectedInstance = signal<unknown | null>(null);
  const setSelectedInstance = vi.fn();
  const usageRecord = vi.fn();
  const actions = {
    resumeLatest: vi.fn(),
    resumeById: vi.fn(),
    switchToLive: vi.fn(),
    forkNew: vi.fn(),
    restoreFromFallback: vi.fn(),
  };

  beforeEach(() => {
    historyEntries.set([]);
    instances.set([]);
    selectedInstance.set(null);
    vi.clearAllMocks();
    usageRecord.mockResolvedValue(undefined);
    actions.resumeById.mockResolvedValue({ success: true, data: { instanceId: 'restored-1' } });
    actions.restoreFromFallback.mockResolvedValue({ success: true, data: { instanceId: 'fallback-1' } });

    TestBed.configureTestingModule({
      providers: [
        ResumePickerController,
        { provide: HistoryStore, useValue: { entries: historyEntries } },
        {
          provide: InstanceStore,
          useValue: {
            instances,
            selectedInstance,
            setSelectedInstance,
          },
        },
        {
          provide: UsageStore,
          useValue: {
            frecency: vi.fn().mockReturnValue(0),
            record: usageRecord,
          },
        },
        { provide: ResumeActionsService, useValue: actions },
      ],
    });
  });

  it('shows only fallback action for entries with a failed native resume', () => {
    historyEntries.set([entry({ nativeResumeFailedAt: 123 })]);

    const controller = TestBed.inject(ResumePickerController);
    const historyGroup = controller.groups().find(group => group.id === 'history');

    expect(historyGroup?.items[0]?.value.availableActions).toEqual(['restoreFromFallback']);
  });

  it('runs the selected resume action and selects the restored instance', async () => {
    historyEntries.set([entry()]);
    const controller = TestBed.inject(ResumePickerController);
    const historyItem = controller.groups().find(group => group.id === 'history')!.items[0]!;

    const handled = await controller.executeAction(historyItem.value, 'resumeById');

    expect(handled).toBe(true);
    expect(actions.resumeById).toHaveBeenCalledWith('entry-1');
    expect(usageRecord).toHaveBeenCalledWith('resume', 'entry-1', '/repo');
    expect(setSelectedInstance).toHaveBeenCalledWith('restored-1');
  });
});
