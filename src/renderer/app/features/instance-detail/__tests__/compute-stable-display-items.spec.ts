import { describe, it, expect } from 'vitest';
import {
  EMPTY_STABLE_DISPLAY_ITEMS_STATE,
  computeStableDisplayItems,
  isDisplayItemUnchanged,
  type StableDisplayItemsState,
} from '../compute-stable-display-items';
import type { DisplayItem } from '../display-item-processor.service';
import type { OutputMessage } from '../../../core/state/instance/instance.types';

let messageSeq = 0;
function makeMessage(overrides: Partial<OutputMessage> = {}): OutputMessage {
  return {
    id: `m-${messageSeq++}`,
    type: 'assistant',
    content: 'hello',
    timestamp: 1000,
    ...overrides,
  };
}

function makeMessageItem(
  id: string,
  message: OutputMessage = makeMessage(),
  overrides: Partial<DisplayItem> = {},
): DisplayItem {
  return { id, type: 'message', message, showHeader: true, ...overrides };
}

/** A fresh empty state per call so tests never share the module-level constant. */
function emptyState(): StableDisplayItemsState {
  return { byId: new Map(), signatures: new Map(), result: [] };
}

describe('computeStableDisplayItems', () => {
  it('returns the previous state by identity when empty in and empty out', () => {
    const previous = EMPTY_STABLE_DISPLAY_ITEMS_STATE;
    const next = computeStableDisplayItems([], previous);
    expect(next).toBe(previous);
    expect(next.result).toBe(previous.result);
  });

  it('returns a new state when adding to an empty list, keeping the input reference', () => {
    const item = makeMessageItem('a');
    const next = computeStableDisplayItems([item], emptyState());
    expect(next.result).toHaveLength(1);
    expect(next.result[0]).toBe(item);
  });

  it('returns the same state by identity for two identical calls in a row', () => {
    const items = [makeMessageItem('a'), makeMessageItem('b')];
    const first = computeStableDisplayItems(items, emptyState());
    const second = computeStableDisplayItems(items, first);
    expect(second).toBe(first);
    expect(second.result).toBe(first.result);
  });

  it('short-circuits to the same array when a fresh array carries unchanged items', () => {
    // The real pipeline hands us a brand-new array every recompute (displayItems
    // reslices), so the win depends on detecting "same content, new array".
    const a = makeMessageItem('a');
    const b = makeMessageItem('b');
    const first = computeStableDisplayItems([a, b], emptyState());
    const second = computeStableDisplayItems([a, b], first); // new array, same items
    expect(second).toBe(first);
    expect(second.result).toBe(first.result);
  });

  it('preserves four references and replaces one when a single message changes', () => {
    const items1 = [0, 1, 2, 3, 4].map((i) => makeMessageItem(`i${i}`));
    const state1 = computeStableDisplayItems(items1, emptyState());

    // i2 changes: the processor would hand back a new item object (same id) whose
    // message reference differs.
    const changed = makeMessageItem('i2', makeMessage({ content: 'changed' }));
    const items2 = [items1[0], items1[1], changed, items1[3], items1[4]];
    const state2 = computeStableDisplayItems(items2, state1);

    expect(state2).not.toBe(state1);
    expect(state2.result[0]).toBe(items1[0]);
    expect(state2.result[1]).toBe(items1[1]);
    expect(state2.result[2]).toBe(changed);
    expect(state2.result[2]).not.toBe(items1[2]);
    expect(state2.result[3]).toBe(items1[3]);
    expect(state2.result[4]).toBe(items1[4]);
  });

  it('preserves all references but allocates a new array when items are reordered', () => {
    const a = makeMessageItem('a');
    const b = makeMessageItem('b');
    const c = makeMessageItem('c');
    const state1 = computeStableDisplayItems([a, b, c], emptyState());
    const state2 = computeStableDisplayItems([c, b, a], state1);

    expect(state2).not.toBe(state1);
    expect(state2.result).not.toBe(state1.result);
    expect(state2.result).toEqual([c, b, a]);
    expect(state2.result[0]).toBe(c);
    expect(state2.result[1]).toBe(b);
    expect(state2.result[2]).toBe(a);
  });

  it('preserves remaining references when an item is removed', () => {
    const a = makeMessageItem('a');
    const b = makeMessageItem('b');
    const c = makeMessageItem('c');
    const state1 = computeStableDisplayItems([a, b, c], emptyState());
    const state2 = computeStableDisplayItems([a, c], state1);

    expect(state2).not.toBe(state1);
    expect(state2.result).toHaveLength(2);
    expect(state2.result[0]).toBe(a);
    expect(state2.result[1]).toBe(c);
    expect(state2.byId.has('b')).toBe(false);
  });

  describe('in-place mutation (DisplayItemProcessor reuses objects)', () => {
    it('detects a tool-group grown by toolMessages.push and emits a new array', () => {
      const toolMessages = [makeMessage({ type: 'tool_use' })];
      const group: DisplayItem = { id: 'tg', type: 'tool-group', toolMessages };
      const state1 = computeStableDisplayItems([group], emptyState());
      const firstResult = state1.result;

      // Same object reference, array grown in place — exactly what mergeNewItems does.
      toolMessages.push(makeMessage({ type: 'tool_result' }));
      const state2 = computeStableDisplayItems([group], state1);

      expect(state2).not.toBe(state1);
      expect(state2.result).not.toBe(firstResult);
      expect(state2.result[0]).toBe(group);
    });

    it('detects a system-event-group grown in place and emits a new array', () => {
      const group: DisplayItem = {
        id: 'seg',
        type: 'system-event-group',
        systemEvents: [makeMessage({ type: 'system' })],
        groupLabel: 'Tool calls',
        groupPreview: 'first',
      };
      const state1 = computeStableDisplayItems([group], emptyState());
      const firstResult = state1.result;

      // appendToSystemGroup reassigns systemEvents and rewrites groupPreview on the
      // same group object.
      group.systemEvents = [...group.systemEvents!, makeMessage({ type: 'system' })];
      group.groupPreview = 'second';
      const state2 = computeStableDisplayItems([group], state1);

      expect(state2).not.toBe(state1);
      expect(state2.result).not.toBe(firstResult);
    });

    it('detects a showHeader toggle mutated in place and emits a new array', () => {
      const item = makeMessageItem('m', makeMessage(), { showHeader: true });
      const state1 = computeStableDisplayItems([item], emptyState());
      const firstResult = state1.result;

      // computeHeaders() flips showHeader on the reused item object.
      item.showHeader = false;
      const state2 = computeStableDisplayItems([item], state1);

      expect(state2).not.toBe(state1);
      expect(state2.result).not.toBe(firstResult);
    });

    it('detects a merged plan-update rewritten in place and emits a new array', () => {
      const item: DisplayItem = {
        id: 'plan',
        type: 'plan-update',
        message: makeMessage({ type: 'system' }),
        planUpdate: {
          entries: [{ content: 'Audit', statusKind: 'in_progress', statusLabel: 'In progress', priorityKind: 'medium', priorityLabel: 'Medium' }],
          totalCount: 1,
          pendingCount: 0,
          inProgressCount: 1,
          completedCount: 0,
          cancelledCount: 0,
          unknownCount: 0,
          preview: 'Audit',
        },
        timestamp: 1000,
      };
      const state1 = computeStableDisplayItems([item], emptyState());
      const firstResult = state1.result;

      item.planUpdate = {
        entries: [
          { content: 'Audit', statusKind: 'completed', statusLabel: 'Done', priorityKind: 'medium', priorityLabel: 'Medium' },
          { content: 'Write tests', statusKind: 'in_progress', statusLabel: 'In progress', priorityKind: 'high', priorityLabel: 'High' },
        ],
        totalCount: 2,
        pendingCount: 0,
        inProgressCount: 1,
        completedCount: 1,
        cancelledCount: 0,
        unknownCount: 0,
        preview: 'Write tests',
      };
      item.timestamp = 2000;
      const state2 = computeStableDisplayItems([item], state1);

      expect(state2).not.toBe(state1);
      expect(state2.result).not.toBe(firstResult);
    });

    it('stabilises a work-cycle even though wrapForDisplay reslices its children', () => {
      const child = makeMessageItem('child', makeMessage());
      const cycle1: DisplayItem = { id: 'cycle', type: 'work-cycle', children: [child] };
      const state1 = computeStableDisplayItems([cycle1], emptyState());

      // New wrapper object with a freshly sliced children array, same child ref —
      // what wrapForDisplay produces on every recompute.
      const cycle2: DisplayItem = { id: 'cycle', type: 'work-cycle', children: [child] };
      const state2 = computeStableDisplayItems([cycle2], state1);

      expect(state2).toBe(state1);
      expect(state2.result[0]).toBe(cycle1);
      expect(state2.result[0]).not.toBe(cycle2);
    });
  });
});

describe('isDisplayItemUnchanged', () => {
  it('returns false when id or type differ', () => {
    const message = makeMessage();
    expect(
      isDisplayItemUnchanged(makeMessageItem('a', message), makeMessageItem('b', message)),
    ).toBe(false);
    expect(
      isDisplayItemUnchanged(
        { id: 'x', type: 'message', message },
        { id: 'x', type: 'tool-group', toolMessages: [message] },
      ),
    ).toBe(false);
  });

  describe('per-variant equality (content-equal means shared field references)', () => {
    it('message', () => {
      const message = makeMessage();
      const a: DisplayItem = { id: 'x', type: 'message', message, showHeader: true, repeatCount: 1 };
      const b: DisplayItem = { id: 'x', type: 'message', message, showHeader: true, repeatCount: 1 };
      expect(isDisplayItemUnchanged(a, b)).toBe(true);

      expect(isDisplayItemUnchanged(a, { ...b, showHeader: false })).toBe(false);
      expect(isDisplayItemUnchanged(a, { ...b, message: makeMessage() })).toBe(false);
      expect(isDisplayItemUnchanged(a, { ...b, repeatCount: 2 })).toBe(false);
    });

    it('tool-group', () => {
      const toolMessages = [makeMessage({ type: 'tool_use' })];
      const a: DisplayItem = { id: 'x', type: 'tool-group', toolMessages };
      const b: DisplayItem = { id: 'x', type: 'tool-group', toolMessages };
      expect(isDisplayItemUnchanged(a, b)).toBe(true);

      // A grown group (different length) is changed.
      expect(
        isDisplayItemUnchanged(a, {
          id: 'x',
          type: 'tool-group',
          toolMessages: [...toolMessages, makeMessage({ type: 'tool_result' })],
        }),
      ).toBe(false);
    });

    it('plan-update', () => {
      const planUpdate = {
        entries: [{ content: 'Audit', statusKind: 'in_progress' as const, statusLabel: 'In progress', priorityKind: 'medium' as const, priorityLabel: 'Medium' }],
        totalCount: 1,
        pendingCount: 0,
        inProgressCount: 1,
        completedCount: 0,
        cancelledCount: 0,
        unknownCount: 0,
        preview: 'Audit',
      };
      const a: DisplayItem = {
        id: 'x',
        type: 'plan-update',
        message: makeMessage({ type: 'system' }),
        planUpdate,
        timestamp: 1000,
      };
      const b: DisplayItem = {
        id: 'x',
        type: 'plan-update',
        message: makeMessage({ type: 'system' }),
        planUpdate: { ...planUpdate, entries: [...planUpdate.entries] },
        timestamp: 1000,
      };
      expect(isDisplayItemUnchanged(a, b)).toBe(true);

      expect(
        isDisplayItemUnchanged(a, {
          ...b,
          planUpdate: {
            ...planUpdate,
            entries: [
              ...planUpdate.entries,
              { content: 'Write tests', statusKind: 'pending', statusLabel: 'Pending', priorityKind: 'high', priorityLabel: 'High' },
            ],
            totalCount: 2,
            pendingCount: 1,
          },
        }),
      ).toBe(false);
    });

    it('thought-group', () => {
      const thinking = [{ id: 't1', content: 'thinking', format: 'structured' as const }];
      const thoughts = ['thinking'];
      const response = makeMessage();
      const a: DisplayItem = { id: 'x', type: 'thought-group', thinking, thoughts, response };
      const b: DisplayItem = { id: 'x', type: 'thought-group', thinking, thoughts, response };
      expect(isDisplayItemUnchanged(a, b)).toBe(true);

      expect(isDisplayItemUnchanged(a, { ...b, response: makeMessage() })).toBe(false);
      expect(
        isDisplayItemUnchanged(a, { ...b, thoughts: ['thinking', 'more'] }),
      ).toBe(false);
    });

    it('work-cycle', () => {
      const child = makeMessageItem('child');
      const a: DisplayItem = { id: 'x', type: 'work-cycle', children: [child] };
      // Different children array instance, same child reference: still unchanged.
      const b: DisplayItem = { id: 'x', type: 'work-cycle', children: [child] };
      expect(isDisplayItemUnchanged(a, b)).toBe(true);

      const otherChild = makeMessageItem('child', makeMessage({ content: 'different' }));
      expect(
        isDisplayItemUnchanged(a, { id: 'x', type: 'work-cycle', children: [otherChild] }),
      ).toBe(false);
      expect(
        isDisplayItemUnchanged(a, { id: 'x', type: 'work-cycle', children: [child, child] }),
      ).toBe(false);
    });

    it('system-event-group', () => {
      const systemEvents = [makeMessage({ type: 'system' })];
      const a: DisplayItem = {
        id: 'x',
        type: 'system-event-group',
        systemEvents,
        groupLabel: 'Tool calls',
        groupPreview: 'preview',
      };
      const b: DisplayItem = {
        id: 'x',
        type: 'system-event-group',
        systemEvents,
        groupLabel: 'Tool calls',
        groupPreview: 'preview',
      };
      expect(isDisplayItemUnchanged(a, b)).toBe(true);

      expect(isDisplayItemUnchanged(a, { ...b, groupPreview: 'changed' })).toBe(false);
      expect(
        isDisplayItemUnchanged(a, {
          ...b,
          systemEvents: [...systemEvents, makeMessage({ type: 'system' })],
        }),
      ).toBe(false);
    });

    it('interrupt-boundary', () => {
      const a: DisplayItem = {
        id: 'x',
        type: 'interrupt-boundary',
        interruptBoundary: { phase: 'completed', requestId: 'r1', outcome: 'cancelled', at: 5 },
      };
      // Distinct boundary object, equal field values: unchanged (compared by value).
      const b: DisplayItem = {
        id: 'x',
        type: 'interrupt-boundary',
        interruptBoundary: { phase: 'completed', requestId: 'r1', outcome: 'cancelled', at: 5 },
      };
      expect(isDisplayItemUnchanged(a, b)).toBe(true);

      expect(
        isDisplayItemUnchanged(a, {
          ...b,
          interruptBoundary: { phase: 'cancelling', requestId: 'r1', outcome: 'cancelled', at: 5 },
        }),
      ).toBe(false);
    });

    it('compaction-summary', () => {
      const a: DisplayItem = {
        id: 'x',
        type: 'compaction-summary',
        compactionSummary: { reason: 'auto', beforeCount: 100, afterCount: 20, at: 9 },
      };
      const b: DisplayItem = {
        id: 'x',
        type: 'compaction-summary',
        compactionSummary: { reason: 'auto', beforeCount: 100, afterCount: 20, at: 9 },
      };
      expect(isDisplayItemUnchanged(a, b)).toBe(true);

      expect(
        isDisplayItemUnchanged(a, {
          ...b,
          compactionSummary: { reason: 'auto', beforeCount: 100, afterCount: 30, at: 9 },
        }),
      ).toBe(false);
    });
  });
});
