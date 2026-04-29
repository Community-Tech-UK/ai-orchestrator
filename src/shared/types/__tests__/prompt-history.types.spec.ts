import { describe, expect, it } from 'vitest';
import {
  PROMPT_HISTORY_MAX,
  createPromptHistoryEntryId,
  type ModelPickerItem,
  type PromptHistoryEntry,
  type PromptHistoryRecord,
  type SessionPickerItem,
  type VisibleInstanceOrder,
} from '../prompt-history.types';

describe('prompt-history.types', () => {
  it('caps at 100 entries by default', () => {
    expect(PROMPT_HISTORY_MAX).toBe(100);
  });

  it('createPromptHistoryEntryId returns unique non-empty ids', () => {
    const a = createPromptHistoryEntryId();
    const b = createPromptHistoryEntryId();

    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('PromptHistoryEntry shape compiles', () => {
    const e: PromptHistoryEntry = {
      id: 'entry-1',
      text: 'hello',
      createdAt: Date.now(),
    };

    expect(e.id).toBe('entry-1');
  });

  it('PromptHistoryRecord shape compiles', () => {
    const r: PromptHistoryRecord = {
      instanceId: 'inst-1',
      entries: [],
      updatedAt: Date.now(),
    };

    expect(r.entries).toEqual([]);
  });

  it('picker and visible-order shapes compile', () => {
    const order: VisibleInstanceOrder = {
      computedAt: 1,
      instanceIds: ['inst-1'],
      projectKeys: ['project-a'],
    };
    const session: SessionPickerItem = {
      id: 'inst-1',
      title: 'Session',
      kind: 'live',
      frecencyScore: 1,
    };
    const model: ModelPickerItem = {
      id: 'sonnet',
      label: 'Sonnet',
      group: 'Claude',
      kind: 'model',
      available: true,
    };

    expect(order.instanceIds).toEqual([session.id]);
    expect(model.available).toBe(true);
  });
});
