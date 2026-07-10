import { describe, it, expect } from 'vitest';
import { filterDisplayItems } from './output-stream-item-filter';
import type { DisplayItem } from './display-item-processor.service';

function thoughtGroup(id: string, opts: { empty?: boolean; noThinking?: boolean } = {}): DisplayItem {
  if (opts.noThinking) {
    return {
      id,
      type: 'thought-group',
      thinking: [],
      thoughts: [],
    };
  }

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
// (renders nothing in the accordion path) when it has no standalone response.
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

  it('keeps thought-only groups as a collapsed-thinking accordion when thinking is hidden', () => {
    // These used to be flattened into a bare assistant message, which rendered
    // an empty "CLAUDE" header (the reasoning text was created after the
    // markdown pass and never rendered). Now they stay thought-groups flagged
    // to render a collapsed-by-default accordion.
    const items = [message('a'), thoughtGroup('planning', { empty: true }), message('c')];
    const result = filterDisplayItems(items, {
      hideToolGroups: false,
      hideEmptyThoughts: true,
      isThoughtGroupEmpty,
    });
    expect(result.map((i) => i.id)).toEqual(['a', 'planning', 'c']);
    expect(result[1].type).toBe('thought-group');
    expect(result[1].collapsedThinkingFallback).toBe(true);
  });

  it('does not mutate the original when flagging a collapsed-thinking fallback', () => {
    const group = thoughtGroup('planning', { empty: true });
    const result = filterDisplayItems([group], {
      hideToolGroups: false,
      hideEmptyThoughts: true,
      isThoughtGroupEmpty,
    });
    expect(result[0]).not.toBe(group);
    expect(group.collapsedThinkingFallback).toBeUndefined();
  });

  it('drops truly empty thought-groups when thinking is hidden', () => {
    const items = [message('a'), thoughtGroup('blank', { noThinking: true }), message('c')];
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

  it('flags hidden thought-groups inside work-cycle children as collapsed accordions', () => {
    const cycle = workCycle('cycle', [
      thoughtGroup('planning', { empty: true }),
      message('err'),
    ]);
    const result = filterDisplayItems([cycle], {
      hideToolGroups: false,
      hideEmptyThoughts: true,
      isThoughtGroupEmpty,
    });
    expect(result).toHaveLength(1);
    expect(result[0].children?.map((c) => c.id)).toEqual(['planning', 'err']);
    expect(result[0].children?.[0].type).toBe('thought-group');
    expect(result[0].children?.[0].collapsedThinkingFallback).toBe(true);
  });

  it('drops a work-cycle whose children are all truly empty thought-groups', () => {
    const cycle = workCycle('cycle', [
      thoughtGroup('blank1', { noThinking: true }),
      thoughtGroup('blank2', { noThinking: true }),
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
      thoughtGroup('drop', { noThinking: true }),
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
      thoughtGroup('planning', { empty: true }),
      message('err'),
    ]);
    filterDisplayItems([cycle], {
      hideToolGroups: false,
      hideEmptyThoughts: true,
      isThoughtGroupEmpty,
    });
    expect(cycle.children?.map((c) => c.id)).toEqual(['planning', 'err']);
  });
});
