import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import type { SessionRecoveryCandidate } from '../../../../shared/types/session-recovery.types';
import { ToastService } from '../../core/services/toast.service';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import { SessionRecoveryStore } from '../../core/state/session-recovery.store';
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

function recoveryCandidate(overrides: Partial<SessionRecoveryCandidate> = {}): SessionRecoveryCandidate {
  return {
    recoveryKey: 'recovery:claude:key',
    sourceInstanceId: 'source-1',
    historyThreadId: 'thread-1',
    provider: 'claude',
    modelId: 'sonnet',
    displayName: 'Autosaved auth fix',
    workingDirectory: '/repo',
    lastActivityAt: 1_700_000_000_000,
    historyCoveredThrough: 1_699_999_990_000,
    recoveredMessageCount: 7,
    reason: 'newer-than-history',
    nativeResumeAvailable: true,
    ...overrides,
  };
}

function liveInstance(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'live-1',
    displayName: 'Live auth fix',
    provider: 'claude',
    currentModel: 'sonnet',
    workingDirectory: '/repo',
    lastActivity: 1_690_000_060_000,
    ...overrides,
  };
}

describe('ResumePickerController', () => {
  const historyEntries = signal<ConversationHistoryEntry[]>([]);
  const recoveryCandidates = signal<SessionRecoveryCandidate[]>([]);
  const recoveryLoading = signal(false);
  const recoveringKey = signal<string | null>(null);
  const recoveryError = signal<string | null>(null);
  const instances = signal<unknown[]>([]);
  const selectedInstance = signal<unknown | null>(null);
  const setSelectedInstance = vi.fn();
  const refreshInstances = vi.fn();
  const loadHistory = vi.fn();
  const usageRecord = vi.fn();
  const toast = { show: vi.fn() };
  const actions = {
    resumeLatest: vi.fn(),
    resumeById: vi.fn(),
    switchToLive: vi.fn(),
    forkNew: vi.fn(),
    restoreFromFallback: vi.fn(),
    recoverAutosave: vi.fn(),
  };

  beforeEach(() => {
    historyEntries.set([]);
    recoveryCandidates.set([]);
    recoveryLoading.set(false);
    recoveringKey.set(null);
    recoveryError.set(null);
    instances.set([]);
    selectedInstance.set(null);
    vi.clearAllMocks();
    usageRecord.mockResolvedValue(undefined);
    refreshInstances.mockResolvedValue(undefined);
    loadHistory.mockResolvedValue(undefined);
    actions.resumeById.mockResolvedValue({ success: true, data: { instanceId: 'restored-1' } });
    actions.restoreFromFallback.mockResolvedValue({ success: true, data: { instanceId: 'fallback-1' } });
    actions.recoverAutosave.mockResolvedValue({
      success: true,
      source: 'recovery',
      recoveredMessageCount: 7,
      data: { instanceId: 'recovered-1' },
    });

    TestBed.configureTestingModule({
      providers: [
        ResumePickerController,
        { provide: HistoryStore, useValue: { entries: historyEntries, loadHistory } },
        {
          provide: InstanceStore,
          useValue: {
            instances,
            selectedInstance,
            setSelectedInstance,
            refreshInstances,
          },
        },
        {
          provide: SessionRecoveryStore,
          useValue: {
            candidates: recoveryCandidates.asReadonly(),
            loading: recoveryLoading.asReadonly(),
            recoveringKey: recoveringKey.asReadonly(),
            error: recoveryError.asReadonly(),
          },
        },
        {
          provide: UsageStore,
          useValue: {
            frecency: vi.fn().mockReturnValue(0),
            record: usageRecord,
          },
        },
        { provide: ToastService, useValue: toast },
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

  it('groups autosave recovery above history with reason, count, and badge content', () => {
    recoveryCandidates.set([recoveryCandidate()]);
    historyEntries.set([entry({ id: 'history-1', displayName: 'Archived auth fix' })]);
    const controller = TestBed.inject(ResumePickerController);

    const visibleGroups = controller.groups().filter(group => group.items.length > 0);
    expect(visibleGroups.map(group => group.id)).toEqual(['quick', 'recovery', 'history']);

    const recoveryItem = visibleGroups.find(group => group.id === 'recovery')?.items[0];
    expect(recoveryItem?.badge).toBe('Autosave');
    expect(recoveryItem?.label).toBe('Autosaved auth fix');
    expect(recoveryItem?.description).toContain('Newer than history');
    expect(recoveryItem?.description).toContain('7 autosaved messages');
  });

  it('orders autosave recovery candidates by newest activity first', () => {
    recoveryCandidates.set([
      recoveryCandidate({ recoveryKey: 'recovery:claude:old', lastActivityAt: 10, displayName: 'Old autosave' }),
      recoveryCandidate({ recoveryKey: 'recovery:claude:new', lastActivityAt: 20, displayName: 'New autosave' }),
    ]);
    const controller = TestBed.inject(ResumePickerController);

    const recoveryItems = controller.groups().find(group => group.id === 'recovery')!.items;

    expect(recoveryItems.map(item => item.value.id)).toEqual([
      'recovery:claude:new',
      'recovery:claude:old',
    ]);
  });

  it('describes Resume Latest as the newest recovery candidate when autosave exists', () => {
    recoveryCandidates.set([
      recoveryCandidate({ recoveryKey: 'recovery:claude:old', lastActivityAt: 10, displayName: 'Old autosave' }),
      recoveryCandidate({ recoveryKey: 'recovery:claude:new', lastActivityAt: 20, displayName: 'New autosave' }),
    ]);
    const controller = TestBed.inject(ResumePickerController);
    const latest = controller.groups().find(group => group.id === 'quick')!.items[0]!.value;

    expect(latest.subtitle).toContain('Autosave recovery');
    expect(latest.subtitle).toContain('New autosave');
    expect(latest.projectPath).toBe('/repo');
  });

  it('selects, refreshes, closes, and announces successful autosave recovery', async () => {
    recoveryCandidates.set([recoveryCandidate()]);
    const controller = TestBed.inject(ResumePickerController);
    const recoveryItem = controller.groups().find(group => group.id === 'recovery')!.items[0]!.value;

    const handled = await controller.executeAction(recoveryItem, 'recoverAutosave');

    expect(handled).toBe(true);
    expect(actions.recoverAutosave).toHaveBeenCalledWith('recovery:claude:key');
    expect(setSelectedInstance).toHaveBeenCalledWith('recovered-1');
    expect(loadHistory).toHaveBeenCalledOnce();
    expect(refreshInstances).toHaveBeenCalledOnce();
    expect(toast.show).toHaveBeenCalledWith('Recovered 7 autosaved messages.', 'success');
  });

  it('treats recovery success as authoritative when usage telemetry rejects', async () => {
    recoveryCandidates.set([recoveryCandidate()]);
    usageRecord.mockRejectedValueOnce(new Error('Usage IPC unavailable'));
    const controller = TestBed.inject(ResumePickerController);
    const recoveryItem = controller.groups().find(group => group.id === 'recovery')!.items[0]!.value;

    const handled = await controller.executeAction(recoveryItem, 'recoverAutosave');

    expect(handled).toBe(true);
    expect(setSelectedInstance).toHaveBeenCalledWith('recovered-1');
    expect(loadHistory).toHaveBeenCalledOnce();
    expect(refreshInstances).toHaveBeenCalledOnce();
    expect(toast.show).toHaveBeenCalledWith('Recovered 7 autosaved messages.', 'success');
    expect(controller.lastError()).toBeNull();
  });

  it('keeps recovery errors retryable without refreshing or selecting', async () => {
    recoveryCandidates.set([recoveryCandidate()]);
    actions.recoverAutosave.mockResolvedValueOnce({
      success: false,
      source: 'recovery',
      error: { message: 'Recovery provider is unavailable' },
    });
    const controller = TestBed.inject(ResumePickerController);
    const recoveryItem = controller.groups().find(group => group.id === 'recovery')!.items[0]!.value;

    const handled = await controller.executeAction(recoveryItem, 'recoverAutosave');

    expect(handled).toBe(false);
    expect(controller.lastError()).toBe('Recovery provider is unavailable');
    expect(setSelectedInstance).not.toHaveBeenCalled();
    expect(loadHistory).not.toHaveBeenCalled();
    expect(refreshInstances).not.toHaveBeenCalled();
    expect(toast.show).not.toHaveBeenCalled();
  });

  it('focuses recovery content when opened from the startup banner', () => {
    recoveryCandidates.set([recoveryCandidate()]);
    historyEntries.set([entry({ id: 'history-1', displayName: 'Archived auth fix' })]);
    const controller = TestBed.inject(ResumePickerController);

    controller.focusRecoveryContent();

    expect(controller.query()).toBe('autosave');
    expect(controller.groups().find(group => group.id === 'recovery')?.items).toHaveLength(1);
    expect(controller.groups().find(group => group.id === 'history')?.items).toHaveLength(0);
  });

  it('clears the recovery filter so a later normal open shows default live and history rows', () => {
    recoveryCandidates.set([recoveryCandidate()]);
    instances.set([liveInstance()]);
    historyEntries.set([entry({ id: 'history-1', displayName: 'Archived auth fix' })]);
    const controller = TestBed.inject(ResumePickerController);

    controller.focusRecoveryContent();
    expect(controller.query()).toBe('autosave');
    expect(controller.groups().find(group => group.id === 'recovery')?.items).toHaveLength(1);
    expect(controller.groups().find(group => group.id === 'live')?.items).toHaveLength(0);
    expect(controller.groups().find(group => group.id === 'history')?.items).toHaveLength(0);

    controller.resetTransientFocus();

    expect(controller.query()).toBe('');
    expect(controller.groups().find(group => group.id === 'recovery')?.items).toHaveLength(1);
    expect(controller.groups().find(group => group.id === 'live')?.items).toHaveLength(1);
    expect(controller.groups().find(group => group.id === 'history')?.items).toHaveLength(1);
  });
});
