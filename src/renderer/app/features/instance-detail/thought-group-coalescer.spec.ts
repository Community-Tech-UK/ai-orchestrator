import { describe, it, expect } from 'vitest';
import {
  EMPTY_THOUGHT_COALESCE_STATE,
  coalesceThoughtGroups,
} from './thought-group-coalescer';
import { filterDisplayItems } from './output-stream-item-filter';
import type { DisplayItem } from './display-item-processor.service';

function thoughtGroup(
  id: string,
  opts: { blocks?: number; response?: string; fallback?: boolean; timestamp?: number } = {},
): DisplayItem {
  const blocks = opts.blocks ?? 1;
  return {
    id,
    type: 'thought-group',
    thinking: Array.from({ length: blocks }, (_, i) => ({
      id: `${id}-t${i}`,
      content: `${id} reasoning ${i}`,
      format: 'structured' as const,
    })),
    thoughts: Array.from({ length: blocks }, (_, i) => `${id} reasoning ${i}`),
    response: opts.response
      ? ({
          id: `${id}-r`,
          type: 'assistant',
          content: opts.response,
          timestamp: 1,
        } as DisplayItem['response'])
      : undefined,
    collapsedThinkingFallback: opts.fallback,
    timestamp: opts.timestamp ?? 100,
  };
}

function toolGroup(id: string): DisplayItem {
  return { id, type: 'tool-group', toolMessages: [] };
}

function message(id: string): DisplayItem {
  return {
    id,
    type: 'message',
    message: { id: `${id}-m`, type: 'assistant', content: 'hi', timestamp: 1 } as DisplayItem['message'],
  };
}

function workCycle(id: string, children: DisplayItem[]): DisplayItem {
  return { id, type: 'work-cycle', children };
}

function coalesce(items: DisplayItem[]) {
  return coalesceThoughtGroups(items, EMPTY_THOUGHT_COALESCE_STATE).result;
}

describe('coalesceThoughtGroups', () => {
  it('merges adjacent thought-groups into one panel', () => {
    const result = coalesce([thoughtGroup('a'), thoughtGroup('b'), thoughtGroup('c')]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('thought-group');
    expect(result[0].thinking?.map((block) => block.id)).toEqual(['a-t0', 'b-t0', 'c-t0']);
    expect(result[0].thoughts).toEqual(['a reasoning 0', 'b reasoning 0', 'c reasoning 0']);
  });

  it('keeps the lead id and timestamp so expansion state and ordering survive', () => {
    const result = coalesce([
      thoughtGroup('a', { timestamp: 100 }),
      thoughtGroup('b', { timestamp: 900 }),
    ]);

    expect(result[0].id).toBe('a');
    expect(result[0].timestamp).toBe(100);
  });

  it('returns the input array itself when nothing merges', () => {
    const items = [message('u'), thoughtGroup('a'), toolGroup('t'), thoughtGroup('b')];
    const state = coalesceThoughtGroups(items, EMPTY_THOUGHT_COALESCE_STATE);

    expect(state.result).toBe(items);
  });

  it('merges two runs separated by a visible row in a single pass', () => {
    const result = coalesce([
      message('u'),
      thoughtGroup('a'),
      thoughtGroup('b'),
      toolGroup('t'),
      thoughtGroup('c'),
      thoughtGroup('d'),
    ]);

    expect(result.map((item) => item.id)).toEqual(['u', 'a', 't', 'c']);
    expect(result[1].thinking?.map((block) => block.id)).toEqual(['a-t0', 'b-t0']);
    expect(result[3].thinking?.map((block) => block.id)).toEqual(['c-t0', 'd-t0']);
  });

  it('merges a run that ends at the last row', () => {
    const result = coalesce([message('u'), thoughtGroup('a'), thoughtGroup('b')]);

    expect(result.map((item) => item.id)).toEqual(['u', 'a']);
    expect(result[1].thinking).toHaveLength(2);
  });

  it('handles an empty list', () => {
    expect(coalesce([])).toEqual([]);
  });

  it('preserves the rows around a merged run by identity', () => {
    const before = message('u');
    const after = toolGroup('t');
    const result = coalesce([before, thoughtGroup('a'), thoughtGroup('b'), after]);

    expect(result).toHaveLength(3);
    expect(result[0]).toBe(before);
    expect(result[2]).toBe(after);
  });

  it('adopts the last member bufferIndex so "Fork from here" covers the whole run', () => {
    const first = { ...thoughtGroup('a'), bufferIndex: 4 };
    const second = { ...thoughtGroup('b'), bufferIndex: 9 };
    const result = coalesce([first, second]);

    expect(result[0].bufferIndex).toBe(9);
  });

  it('does not mutate the source groups or their arrays', () => {
    const first = thoughtGroup('a');
    const second = thoughtGroup('b');
    coalesce([first, second]);

    expect(first.thinking).toHaveLength(1);
    expect(first.thoughts).toEqual(['a reasoning 0']);
    expect(second.thinking).toHaveLength(1);
  });

  it('leaves a lone thought-group untouched', () => {
    const only = thoughtGroup('a');
    const result = coalesce([message('u'), only, message('v')]);

    expect(result).toHaveLength(3);
    expect(result[1]).toBe(only);
  });

  it('does not merge across a visible item', () => {
    const result = coalesce([thoughtGroup('a'), toolGroup('t'), thoughtGroup('b')]);

    expect(result.map((item) => item.id)).toEqual(['a', 't', 'b']);
  });

  it('never swallows a group that renders its own assistant bubble', () => {
    const result = coalesce([
      thoughtGroup('a'),
      thoughtGroup('b', { response: 'here is the answer' }),
      thoughtGroup('c'),
    ]);

    expect(result.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('merges thought-groups inside work-cycle children', () => {
    const result = coalesce([workCycle('cycle', [thoughtGroup('a'), thoughtGroup('b'), message('m')])]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('work-cycle');
    expect(result[0].children?.map((child) => child.id)).toEqual(['a', 'm']);
    expect(result[0].children?.[0].thinking).toHaveLength(2);
  });

  it('returns the work-cycle unchanged when its children do not merge', () => {
    const cycle = workCycle('cycle', [thoughtGroup('a'), toolGroup('t')]);
    const result = coalesce([cycle]);

    expect(result[0]).toBe(cycle);
  });

  it('keeps the collapsed-thinking fallback flag on the merged row', () => {
    const result = coalesce([
      thoughtGroup('a', { fallback: true }),
      thoughtGroup('b', { fallback: true }),
    ]);

    expect(result[0].collapsedThinkingFallback).toBe(true);
  });

  it('reuses the merged row when nothing changed', () => {
    const items = [thoughtGroup('a'), thoughtGroup('b')];
    const first = coalesceThoughtGroups(items, EMPTY_THOUGHT_COALESCE_STATE);
    const second = coalesceThoughtGroups(items, first);

    expect(second.result[0]).toBe(first.result[0]);
    expect(second.result[0].thinking).toBe(first.result[0].thinking);
  });

  it('rebuilds the merged row when the run grows', () => {
    const first = coalesceThoughtGroups(
      [thoughtGroup('a'), thoughtGroup('b')],
      EMPTY_THOUGHT_COALESCE_STATE,
    );
    const second = coalesceThoughtGroups(
      [thoughtGroup('a'), thoughtGroup('b'), thoughtGroup('c')],
      first,
    );

    expect(second.result).toHaveLength(1);
    expect(second.result[0].thinking).toHaveLength(3);
    expect(second.result[0]).not.toBe(first.result[0]);
  });

  it('rebuilds the merged row when a member gains a reasoning block', () => {
    const first = coalesceThoughtGroups(
      [thoughtGroup('a'), thoughtGroup('b')],
      EMPTY_THOUGHT_COALESCE_STATE,
    );
    const second = coalesceThoughtGroups(
      [thoughtGroup('a'), thoughtGroup('b', { blocks: 2 })],
      first,
    );

    expect(second.result[0].thinking).toHaveLength(3);
  });

  it('drops stale merged rows so the cache cannot grow unbounded', () => {
    const first = coalesceThoughtGroups(
      [thoughtGroup('a'), thoughtGroup('b')],
      EMPTY_THOUGHT_COALESCE_STATE,
    );
    const second = coalesceThoughtGroups(
      [message('u'), thoughtGroup('c'), thoughtGroup('d')],
      first,
    );

    expect([...second.merged.keys()]).toEqual(['c']);
  });
});

describe('filter + coalesce pipeline', () => {
  // The screenshot case: a Claude turn alternating reasoning and Bash calls,
  // viewed with "show tool calls" and "show thinking" both off. The processor
  // cannot merge across the tool-groups; once the filter strips them the boxes
  // are adjacent on screen and must fold into one.
  it('merges reasoning that only hidden tool calls kept apart', () => {
    const items = [
      message('user'),
      thoughtGroup('a'),
      toolGroup('t1'),
      thoughtGroup('b'),
      toolGroup('t2'),
      thoughtGroup('c'),
    ];

    const filtered = filterDisplayItems(items, {
      hideToolGroups: true,
      hideEmptyThoughts: true,
      hideProgressNotes: false,
      isThoughtGroupEmpty: () => true,
    });
    const result = coalesce(filtered);

    expect(result.map((item) => item.id)).toEqual(['user', 'a']);
    expect(result[1].thinking).toHaveLength(3);
    expect(result[1].collapsedThinkingFallback).toBe(true);
  });

  it('leaves the reasoning boxes separate while tool calls are shown', () => {
    const items = [thoughtGroup('a'), toolGroup('t1'), thoughtGroup('b')];

    const filtered = filterDisplayItems(items, {
      hideToolGroups: false,
      hideEmptyThoughts: false,
      hideProgressNotes: false,
      isThoughtGroupEmpty: () => false,
    });
    const result = coalesce(filtered);

    expect(result.map((item) => item.id)).toEqual(['a', 't1', 'b']);
  });
});
