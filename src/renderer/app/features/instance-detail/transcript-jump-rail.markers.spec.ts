/**
 * transcript-jump-rail.markers spec
 *
 * Tests:
 *   1. collectJumpTargets picks only user messages, in order, at the top level.
 *   2. Reply pairing uses the LAST assistant text before the next user message,
 *      including responses nested inside work-cycle children.
 *   3. A trailing user message with no reply yet gets replyExcerpt ''.
 *   4. Edited-file collection: mutating tool_use messages contribute deduped
 *      basenames (input nested or flat, MultiEdit edits, work-cycle nesting);
 *      read-only tools and other turns' edits do not.
 *   5. mergeSessionTicks unions the session tally with loaded targets (loaded
 *      wins), ordered by timestamp, markdown-stripping stored excerpts.
 *   6. excerptText strips markdown noise and truncates with an ellipsis.
 *   7. computeMarkerLayout bunches ticks into a fixed-spacing cluster centred
 *      in the rail, compressing and clamping when they cannot fit.
 *   8. activeMarkerIndex finds the last loaded anchor above the reference
 *      line, skipping NaN (unloaded) anchors, and handles empty/edge cases.
 */

import { describe, expect, it } from 'vitest';
import type { DisplayItem } from './display-item.types';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import type { UserPromptRef } from '../../../../shared/types/prompt-index.types';
import {
  activeMarkerIndex,
  collectJumpTargets,
  computeMarkerLayout,
  excerptText,
  mergeSessionTicks,
} from './transcript-jump-rail.markers';

let nextId = 0;

function msg(type: OutputMessage['type'], content: string): OutputMessage {
  nextId++;
  return { id: `msg-${nextId}`, timestamp: nextId, type, content };
}

function userItem(content: string): DisplayItem {
  const message = msg('user', content);
  return { id: `item-${message.id}`, type: 'message', message };
}

function assistantItem(content: string): DisplayItem {
  const message = msg('assistant', content);
  return { id: `item-${message.id}`, type: 'message', message };
}

function thoughtGroup(response: string): DisplayItem {
  const responseMsg = msg('assistant', response);
  return { id: `item-${responseMsg.id}`, type: 'thought-group', response: responseMsg };
}

function toolGroup(toolMessages: OutputMessage[] = []): DisplayItem {
  nextId++;
  return { id: `item-tool-${nextId}`, type: 'tool-group', toolMessages };
}

function toolUse(name: string, metadata: Record<string, unknown>): OutputMessage {
  nextId++;
  return {
    id: `msg-${nextId}`,
    timestamp: nextId,
    type: 'tool_use',
    content: '',
    metadata: { name, ...metadata },
  };
}

function workCycle(children: DisplayItem[]): DisplayItem {
  return { id: `cycle-${children[0].id}`, type: 'work-cycle', children };
}

describe('collectJumpTargets', () => {
  it('returns one target per top-level user message, in order', () => {
    const first = userItem('first question');
    const second = userItem('second question');
    const targets = collectJumpTargets([first, thoughtGroup('answer one'), second]);

    expect(targets.map((t) => t.itemId)).toEqual([first.id, second.id]);
    expect(targets.map((t) => t.messageId)).toEqual([first.message!.id, second.message!.id]);
    expect(targets[0].promptExcerpt).toBe('first question');
  });

  it('ignores assistant, tool, and system items as targets', () => {
    const items = [
      assistantItem('greeting'),
      toolGroup(),
      { id: 'sys-1', type: 'system-event-group', systemEvents: [] } as DisplayItem,
    ];
    expect(collectJumpTargets(items)).toEqual([]);
  });

  it('pairs each prompt with the LAST assistant text before the next user message', () => {
    const items = [
      userItem('question'),
      thoughtGroup('let me look into it'),
      thoughtGroup('final answer'),
      userItem('follow-up'),
      thoughtGroup('follow-up answer'),
    ];
    const targets = collectJumpTargets(items);

    expect(targets[0].replyExcerpt).toBe('final answer');
    expect(targets[1].replyExcerpt).toBe('follow-up answer');
  });

  it('finds replies nested inside work-cycle children', () => {
    const items = [
      userItem('question'),
      workCycle([toolGroup(), thoughtGroup('early note'), thoughtGroup('wrapped answer')]),
      userItem('next'),
    ];
    expect(collectJumpTargets(items)[0].replyExcerpt).toBe('wrapped answer');
  });

  it('prefers later top-level text over an earlier work-cycle response', () => {
    const items = [
      userItem('question'),
      workCycle([thoughtGroup('mid-work'), toolGroup()]),
      thoughtGroup('closing answer'),
      userItem('next'),
    ];
    expect(collectJumpTargets(items)[0].replyExcerpt).toBe('closing answer');
  });

  it('gives a trailing unanswered user message an empty replyExcerpt', () => {
    const targets = collectJumpTargets([userItem('answered'), thoughtGroup('yes'), userItem('pending')]);
    expect(targets[1].replyExcerpt).toBe('');
  });

  it('skips whitespace-only assistant content when pairing', () => {
    const items = [userItem('question'), thoughtGroup('real answer'), thoughtGroup('   '), userItem('next')];
    expect(collectJumpTargets(items)[0].replyExcerpt).toBe('real answer');
  });

  // ── Edited-file collection ─────────────────────────────────────────────────

  it('collects deduped basenames from mutating tool calls, per turn', () => {
    const items = [
      userItem('question'),
      toolGroup([
        toolUse('Edit', { input: { file_path: '/repo/src/coin-manager.ts' } }),
        toolUse('Write', { input: { file_path: '/repo/docs/plan.md' } }),
        toolUse('Edit', { input: { file_path: '/repo/src/coin-manager.ts' } }),
      ]),
      userItem('next'),
      toolGroup([toolUse('Edit', { input: { file_path: '/repo/other.ts' } })]),
    ];
    const targets = collectJumpTargets(items);

    expect(targets[0].files).toEqual(['coin-manager.ts', 'plan.md']);
    expect(targets[1].files).toEqual(['other.ts']);
  });

  it('reads flat metadata, MultiEdit edits arrays, and work-cycle nesting', () => {
    const items = [
      userItem('question'),
      workCycle([
        toolGroup([toolUse('write_file', { path: 'src/nested.ts' })]),
        toolGroup([
          toolUse('MultiEdit', {
            input: { edits: [{ file_path: '/repo/a.ts' }, { file_path: '/repo/b.ts' }] },
          }),
        ]),
      ]),
    ];
    expect(collectJumpTargets(items)[0].files).toEqual(['nested.ts', 'a.ts', 'b.ts']);
  });

  it('ignores read-only tools and tool_results', () => {
    const readResult: OutputMessage = {
      id: 'msg-result',
      timestamp: 1,
      type: 'tool_result',
      content: '',
      metadata: { name: 'Edit', file_path: '/repo/result-side.ts' },
    };
    const items = [
      userItem('question'),
      toolGroup([toolUse('Read', { input: { file_path: '/repo/read-only.ts' } }), readResult]),
    ];
    expect(collectJumpTargets(items)[0].files).toEqual([]);
  });
});

describe('mergeSessionTicks', () => {
  function prompt(id: string, timestamp: number, excerpt: string): UserPromptRef {
    return { id, timestamp, excerpt };
  }

  it('unions session prompts with loaded targets, loaded winning by message id', () => {
    const loadedItem = userItem('loaded question');
    const [target] = collectJumpTargets([loadedItem]);
    const ticks = mergeSessionTicks(
      [
        prompt('older-1', 1, 'unloaded prompt'),
        prompt(loadedItem.message!.id, loadedItem.message!.timestamp, 'stale stored excerpt'),
      ],
      [target],
    );

    expect(ticks.map((t) => t.messageId)).toEqual(['older-1', loadedItem.message!.id]);
    expect(ticks[0].target).toBeUndefined();
    expect(ticks[0].promptExcerpt).toBe('unloaded prompt');
    expect(ticks[1].target).toBe(target);
    expect(ticks[1].promptExcerpt).toBe('loaded question');
  });

  it('orders ticks by timestamp across both sources', () => {
    const late = userItem('late question'); // timestamp = high nextId
    const [target] = collectJumpTargets([late]);
    const ticks = mergeSessionTicks([prompt('early', 0.5, 'early prompt')], [target]);
    expect(ticks.map((t) => t.messageId)).toEqual(['early', late.message!.id]);
  });

  it('strips markdown from stored excerpts', () => {
    const [tick] = mergeSessionTicks([prompt('p1', 1, '**bold** `code`')], []);
    expect(tick.promptExcerpt).toBe('bold code');
  });
});

describe('excerptText', () => {
  it('collapses whitespace and strips markdown syntax', () => {
    expect(excerptText('## Heading\n\n- a **bold** point\n- a [link](https://x.dev)')).toBe(
      'Heading a bold point a link',
    );
  });

  it('replaces fenced code blocks with a [code] placeholder', () => {
    expect(excerptText('before\n```ts\nconst x = 1;\n```\nafter')).toBe('before [code] after');
  });

  it('replaces an unterminated fence (still streaming) too', () => {
    expect(excerptText('before\n```ts\nconst x = 1;')).toBe('before [code]');
  });

  it('truncates long text with an ellipsis at the limit', () => {
    const out = excerptText('word '.repeat(100), 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns short text unchanged', () => {
    expect(excerptText('short prompt')).toBe('short prompt');
  });
});

describe('computeMarkerLayout', () => {
  it('bunches ticks at the vertical centre with fixed spacing', () => {
    // 3 ticks, 12px spacing → 24px cluster centred in 400px: 188/200/212
    expect(computeMarkerLayout(3, 400)).toEqual([188, 200, 212]);
  });

  it('centres a single tick', () => {
    expect(computeMarkerLayout(1, 400)).toEqual([200]);
  });

  it('compresses spacing when the cluster would overflow the rail', () => {
    // 41 ticks in 200px: gap = 200/40 = 5, cluster fills the rail exactly
    const tops = computeMarkerLayout(41, 200);
    expect(tops[0]).toBe(0);
    expect(tops[40]).toBe(200);
    expect(tops[1] - tops[0]).toBe(5);
  });

  it('floors the spacing and clamps to the rail bounds under extreme density', () => {
    const tops = computeMarkerLayout(101, 200);
    expect(tops[1] - tops[0]).toBe(4);
    expect(tops.every((top) => top >= 0 && top <= 200)).toBe(true);
    expect(tops[100]).toBe(200);
  });

  it('returns an empty layout for zero ticks', () => {
    expect(computeMarkerLayout(0, 200)).toEqual([]);
  });
});

describe('activeMarkerIndex', () => {
  it('returns -1 for an empty anchor list', () => {
    expect(activeMarkerIndex([], 0, 500)).toBe(-1);
  });

  it('returns 0 when scrolled above the first anchor', () => {
    expect(activeMarkerIndex([1000, 2000], 0, 500)).toBe(0);
  });

  it('skips unloaded (NaN) anchors and falls back to the first loaded one', () => {
    expect(activeMarkerIndex([Number.NaN, 1000, Number.NaN, 2000], 0, 500)).toBe(1);
    expect(activeMarkerIndex([Number.NaN, 1000, Number.NaN, 2000], 1800, 500)).toBe(3);
  });

  it('returns -1 when no anchors are loaded', () => {
    expect(activeMarkerIndex([Number.NaN, Number.NaN], 0, 500)).toBe(-1);
  });

  it('returns the last anchor above the mid-viewport reference line', () => {
    // reference line = 1000 + 250 = 1250 → anchors at 0 and 1200 qualify
    expect(activeMarkerIndex([0, 1200, 2400], 1000, 500)).toBe(1);
  });

  it('returns the final anchor when scrolled to the bottom', () => {
    expect(activeMarkerIndex([0, 1200, 2400], 2400, 500)).toBe(2);
  });
});
