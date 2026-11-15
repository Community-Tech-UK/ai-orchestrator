import { describe, expect, it } from 'vitest';
import type { OutputMessage } from '../../src/shared/types/instance.types';
import { findStops } from './stop-finder';

let clock = 1_000_000;
function msg(type: OutputMessage['type'], content: string, metadata?: OutputMessage['metadata']): OutputMessage {
  clock += 10_000;
  return { id: `m${clock}`, timestamp: clock, type, content, metadata };
}
const person = (content: string) => msg('user', content, { inputOrigin: { kind: 'person', typedAt: clock + 5_000 } });
const harness = (content: string) => msg('system', content, { internalInput: { actor: 'harness', source: 'waiting-check-in' } });

describe('findStops', () => {
  it('finds a stop followed by a typed message and measures the reply', () => {
    const all = [person('Add a cache'), msg('assistant', 'Done phase 1. Shall I do phase 2?'), person('yes please')];
    const stops = findStops(all);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ stopIndex: 1, final: false, next: { kind: 'person', bareGoAhead: true, chars: 10 } });
    expect(stops[0].next.gapMs).toBe(5_000);
  });

  it('does not mark a long reply as a bare go-ahead', () => {
    const stops = findStops([person('x'), msg('assistant', 'Finished.'), person('Now please also rename the module and update the docs')]);
    expect(stops[0].next.bareGoAhead).toBe(false);
  });

  it('skips tool, error and plain system rows when looking for the next turn', () => {
    const all = [
      person('go'), msg('assistant', 'Working on it.'), msg('tool_use', 'Bash'), msg('tool_result', 'ok'), msg('tool_outcome', 'ok'),
      msg('error', 'oops'), msg('system', 'a notice with no internalInput'), person('continue'),
    ];
    const stops = findStops(all);
    expect(stops.map((s) => s.stopIndex)).toEqual([1]);
  });

  it('uses the last assistant text of a turn, not an earlier one', () => {
    const stops = findStops([person('go'), msg('assistant', 'First note'), msg('tool_use', 'Bash'), msg('assistant', 'Final note'), person('ok')]);
    expect(stops.map((s) => s.stopIndex)).toEqual([3]);
  });

  it('ignores assistant messages with empty text and stops followed by Harness or an unmarked user message', () => {
    const unmarked = msg('user', 'text with no person mark');
    const all = [
      person('go'), msg('assistant', 'Reply A'), harness('Automatic check-in: ...'),
      msg('assistant', 'Reply B'), unmarked,
      msg('assistant', '   '), person('hello'),
    ];
    expect(findStops(all)).toEqual([]);
  });

  it('emits the last assistant text as final when no turn starter follows', () => {
    const stops = findStops([person('go'), msg('assistant', 'All done.'), msg('tool_outcome', 'x')]);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ stopIndex: 1, final: true, next: { kind: 'none', chars: 0, bareGoAhead: false, gapMs: null } });
  });

  it('emits nothing for a conversation with no assistant text', () => {
    expect(findStops([person('hi')])).toEqual([]);
  });
});
