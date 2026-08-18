import { describe, expect, it } from 'vitest';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import type { Instance } from '../../core/state/instance.store';
import type { InstanceStatus } from '../../../../shared/types/instance.types';
import {
  getHistoryTimeWindowCutoff,
  isHiddenAutomationHistoryEntry,
  isHiddenAutomationInstance,
  shouldShowHistoryOnlyProject,
} from './history-rail-filtering';

function historyEntry(
  id: string,
  overrides: Partial<ConversationHistoryEntry> = {}
): ConversationHistoryEntry {
  return {
    id,
    displayName: 'Imported task',
    createdAt: 1,
    endedAt: 2,
    workingDirectory: '/Users/me/work/imported-project',
    messageCount: 2,
    firstUserMessage: 'Imported native Claude task',
    lastUserMessage: 'Imported native Claude follow-up',
    status: 'completed',
    originalInstanceId: `imported-${id}`,
    parentId: null,
    sessionId: id,
    provider: 'claude',
    ...overrides,
  };
}

describe('history rail filtering', () => {
  it('resolves activity time-window cutoffs', () => {
    const now = Date.UTC(2026, 4, 2, 12, 0, 0);
    const day = 24 * 60 * 60 * 1000;

    expect(getHistoryTimeWindowCutoff('all', now)).toBeNull();
    expect(getHistoryTimeWindowCutoff('day', now)).toBe(now - day);
    expect(getHistoryTimeWindowCutoff('3-days', now)).toBe(now - 3 * day);
    expect(getHistoryTimeWindowCutoff('week', now)).toBe(now - 7 * day);
    expect(getHistoryTimeWindowCutoff('2-weeks', now)).toBe(now - 14 * day);
    expect(getHistoryTimeWindowCutoff('month', now)).toBe(now - 30 * day);
  });

  it('matches timestamps against the selected activity time window', () => {
    const now = Date.UTC(2026, 4, 2, 12, 0, 0);
    const day = 24 * 60 * 60 * 1000;
    const cutoff = getHistoryTimeWindowCutoff('day', now);

    expect(cutoff).toBe(now - day);
    expect(now - day + 1 >= cutoff!).toBe(true);
    expect(now - day - 1 >= cutoff!).toBe(false);
    expect(getHistoryTimeWindowCutoff('all', now)).toBeNull();
  });

  it('hides native-only history projects in relevant mode', () => {
    expect(
      shouldShowHistoryOnlyProject({
        mode: 'relevant',
        hasTextFilter: false,
        hasDraft: false,
        isPinnedProject: false,
        selectedHistoryEntryId: null,
        pinnedHistoryIds: new Set<string>(),
        historyItems: [
          historyEntry('native-1', { importSource: 'native-claude' }),
          historyEntry('native-2', { importSource: 'native-claude' }),
        ],
      })
    ).toBe(false);
  });

  it('shows native-only history projects when the user searches or switches to all history', () => {
    const historyItems = [historyEntry('native-1', { importSource: 'native-claude' })];

    expect(
      shouldShowHistoryOnlyProject({
        mode: 'relevant',
        hasTextFilter: true,
        hasDraft: false,
        isPinnedProject: false,
        selectedHistoryEntryId: null,
        pinnedHistoryIds: new Set<string>(),
        historyItems,
      })
    ).toBe(true);

    expect(
      shouldShowHistoryOnlyProject({
        mode: 'all',
        hasTextFilter: false,
        hasDraft: false,
        isPinnedProject: false,
        selectedHistoryEntryId: null,
        pinnedHistoryIds: new Set<string>(),
        historyItems,
      })
    ).toBe(true);
  });

  it('keeps native-only history projects when the user pinned or selected them', () => {
    const historyItems = [historyEntry('native-1', { importSource: 'native-claude' })];

    expect(
      shouldShowHistoryOnlyProject({
        mode: 'relevant',
        hasTextFilter: false,
        hasDraft: false,
        isPinnedProject: false,
        selectedHistoryEntryId: null,
        pinnedHistoryIds: new Set<string>(['native-1']),
        historyItems,
      })
    ).toBe(true);

    expect(
      shouldShowHistoryOnlyProject({
        mode: 'relevant',
        hasTextFilter: false,
        hasDraft: false,
        isPinnedProject: false,
        selectedHistoryEntryId: 'native-1',
        pinnedHistoryIds: new Set<string>(),
        historyItems,
      })
    ).toBe(true);
  });

  it('keeps regular orchestrator history projects in relevant mode', () => {
    expect(
      shouldShowHistoryOnlyProject({
        mode: 'relevant',
        hasTextFilter: false,
        hasDraft: false,
        isPinnedProject: false,
        selectedHistoryEntryId: null,
        pinnedHistoryIds: new Set<string>(),
        historyItems: [historyEntry('orchestrator-1')],
      })
    ).toBe(true);
  });
});

describe('hidden automation rail filtering', () => {
  function liveRun(
    status: InstanceStatus,
    metadata: Record<string, unknown> = { automationHidden: true },
  ): Pick<Instance, 'status' | 'metadata'> {
    return { status, metadata };
  }

  it('hides a healthy hidden automation run', () => {
    expect(isHiddenAutomationInstance(liveRun('busy'), false)).toBe(true);
    expect(isHiddenAutomationInstance(liveRun('idle'), false)).toBe(true);
  });

  it('never hides a session from a visible automation', () => {
    expect(
      isHiddenAutomationInstance(liveRun('busy', { automationId: 'a1' }), false)
    ).toBe(false);
  });

  it('reveals a hidden run that failed', () => {
    for (const status of ['error', 'failed', 'terminated', 'cancelled', 'superseded'] as const) {
      expect(isHiddenAutomationInstance(liveRun(status), false)).toBe(false);
    }
  });

  it('reveals a hidden run parked waiting for a human', () => {
    expect(isHiddenAutomationInstance(liveRun('waiting_for_permission'), false)).toBe(false);
    expect(isHiddenAutomationInstance(liveRun('waiting_for_input'), false)).toBe(false);
  });

  it('reveals every hidden run when the toggle is on', () => {
    expect(isHiddenAutomationInstance(liveRun('busy'), true)).toBe(false);
  });

  it('hides an archived hidden run, and reveals it with the toggle', () => {
    const entry = historyEntry('hidden-1', { isHiddenAutomation: true });
    expect(isHiddenAutomationHistoryEntry(entry, false)).toBe(true);
    expect(isHiddenAutomationHistoryEntry(entry, true)).toBe(false);
  });

  it('leaves ordinary archived entries alone', () => {
    expect(isHiddenAutomationHistoryEntry(historyEntry('plain-1'), false)).toBe(false);
  });

  it('does not hide an archived run that did not finish cleanly', () => {
    // HistoryManager resolves the outcome at archive time and only sets the
    // flag on a recorded success, so anything else arrives here unflagged.
    // This pins that contract: the rail must not try to second-guess it from
    // `status`, which cannot distinguish a failed run from a clean one.
    const failed = historyEntry('hidden-failed', {
      isHiddenAutomation: undefined,
      status: 'completed',
    });
    expect(isHiddenAutomationHistoryEntry(failed, false)).toBe(false);
  });
});
