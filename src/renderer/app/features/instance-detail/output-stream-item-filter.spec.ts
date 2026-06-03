import { describe, it, expect } from 'vitest';
import { filterDisplayItems } from './output-stream-item-filter';
import type { DisplayItem } from './display-item-processor.service';

function thoughtGroup(id: string, opts: { empty?: boolean } = {}): DisplayItem {
  return {
    id,
    type: 'thought-group',
    thinking: [{ id: `${id}-t`, content: 'reasoning', format: 'structured' }],
    thoughts: ['reasoning'],
    // An "empty" thought-group has no standalone response; a non-empty one does.
    response: opts.empty
      ? undefined
      : ({ id: `${id}-r`, type: 'assistant', content: 'answer', timestamp: 1 } as DisplayItem['response']),
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

// Stub matching the showThinking=false semantics: a thought-group is "empty"
// (renders nothing) when it has no standalone response.
const isThoughtGroupEmpty = (item: DisplayItem): boolean => !item.response;

describe('filterDisplayItems', () => {
  it('returns the same array reference when no filtering is requested', () => {
    const items = [message('a'), toolGroup('b'), thoughtGroup('c', { empty: true })];
    const result = filterDisplayItems(items, {
      hideToolGroups: false,
      hideEmptyThoughts: false,
      isThoughtGroupEmpty,
    });
    expect(result).toBe(items);
  });

  it('strips top-level tool-groups when tool calls are hidden', () => {
    const items = [message('a'), toolGroup('b'), message('c')];
    const result = filterDisplayItems(items, {
      hideToolGroups: true,
      hideEmptyThoughts: false,
      isThoughtGroupEmpty,
    });
    expect(result.map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('strips empty thought-groups when thinking is hidden', () => {
    const items = [message('a'), thoughtGroup('empty', { empty: true }), message('c')];
    const result = filterDisplayItems(items, {
      hideToolGroups: false,
      hideEmptyThoughts: true,
      isThoughtGroupEmpty,
    });
    expect(result.map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('keeps thought-groups that still render a response when thinking is hidden', () => {
    const items = [thoughtGroup('withResponse', { empty: false })];
    const result = filterDisplayItems(items, {
      hideToolGroups: false,
      hideEmptyThoughts: true,
      isThoughtGroupEmpty,
    });
    expect(result.map((i) => i.id)).toEqual(['withResponse']);
  });

  it('removes empty thought-groups from work-cycle children', () => {
    const cycle = workCycle('cycle', [
      thoughtGroup('empty', { empty: true }),
      message('err'),
    ]);
    const result = filterDisplayItems([cycle], {
      hideToolGroups: false,
      hideEmptyThoughts: true,
      isThoughtGroupEmpty,
    });
    expect(result).toHaveLength(1);
    expect(result[0].children?.map((c) => c.id)).toEqual(['err']);
  });

  it('drops a work-cycle whose children are all filtered out', () => {
    const cycle = workCycle('cycle', [
      thoughtGroup('empty1', { empty: true }),
      thoughtGroup('empty2', { empty: true }),
    ]);
    const result = filterDisplayItems([cycle], {
      hideToolGroups: false,
      hideEmptyThoughts: true,
      isThoughtGroupEmpty,
    });
    expect(result).toHaveLength(0);
  });

  it('applies both filters together and preserves a non-empty work-cycle', () => {
    const cycle = workCycle('cycle', [
      thoughtGroup('keep', { empty: false }),
      thoughtGroup('drop', { empty: true }),
      toolGroup('tool'),
    ]);
    const result = filterDisplayItems([cycle, toolGroup('topTool'), message('m')], {
      hideToolGroups: true,
      hideEmptyThoughts: true,
      isThoughtGroupEmpty,
    });
    expect(result.map((i) => i.id)).toEqual(['cycle', 'm']);
    expect(result[0].children?.map((c) => c.id)).toEqual(['keep']);
  });

  it('does not mutate the original work-cycle children', () => {
    const cycle = workCycle('cycle', [
      thoughtGroup('empty', { empty: true }),
      message('err'),
    ]);
    filterDisplayItems([cycle], {
      hideToolGroups: false,
      hideEmptyThoughts: true,
      isThoughtGroupEmpty,
    });
    expect(cycle.children?.map((c) => c.id)).toEqual(['empty', 'err']);
  });
});
