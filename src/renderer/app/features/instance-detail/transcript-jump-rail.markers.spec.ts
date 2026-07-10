/**
 * transcript-jump-rail.markers spec
 *
 * Tests:
 *   1. collectJumpTargets picks only user messages, in order, at the top level.
 *   2. Reply pairing uses the LAST assistant text before the next user message,
 *      including responses nested inside work-cycle children.
 *   3. A trailing user message with no reply yet gets replyExcerpt ''.
 *   4. excerptText strips markdown noise and truncates with an ellipsis.
 *   5. computeMarkerLayout maps ratios proportionally, enforces minimum
 *      separation, and clamps to the rail bounds.
 *   6. activeMarkerIndex finds the last anchor above the reference line and
 *      handles empty/edge cases.
 */

import { describe, expect, it } from 'vitest';
import type { DisplayItem } from './display-item.types';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import {
  activeMarkerIndex,
  collectJumpTargets,
  computeMarkerLayout,
  excerptText,
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

function toolGroup(): DisplayItem {
  nextId++;
  return { id: `item-tool-${nextId}`, type: 'tool-group', toolMessages: [] };
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
  it('maps ratios proportionally onto the rail', () => {
    expect(computeMarkerLayout([0, 0.5, 1], 200)).toEqual([0, 100, 200]);
  });

  it('enforces minimum separation on dense clusters', () => {
    const tops = computeMarkerLayout([0.5, 0.5, 0.5], 200, 6);
    expect(tops[1] - tops[0]).toBeGreaterThanOrEqual(6);
    expect(tops[2] - tops[1]).toBeGreaterThanOrEqual(6);
  });

  it('pulls a cluster at the rail end back inside the bounds', () => {
    const tops = computeMarkerLayout([1, 1, 1], 200, 6);
    expect(tops[2]).toBeLessThanOrEqual(200);
    expect(tops[0]).toBe(188);
    expect(tops[1]).toBe(194);
  });

  it('clamps out-of-range ratios and never goes negative', () => {
    const tops = computeMarkerLayout([-0.5, 2], 100);
    expect(tops[0]).toBe(0);
    expect(tops[1]).toBe(100);
  });

  it('returns an empty layout for no ratios', () => {
    expect(computeMarkerLayout([], 200)).toEqual([]);
  });
});

describe('activeMarkerIndex', () => {
  it('returns -1 for an empty anchor list', () => {
    expect(activeMarkerIndex([], 0, 500)).toBe(-1);
  });

  it('returns 0 when scrolled above the first anchor', () => {
    expect(activeMarkerIndex([1000, 2000], 0, 500)).toBe(0);
  });

  it('returns the last anchor above the mid-viewport reference line', () => {
    // reference line = 1000 + 250 = 1250 → anchors at 0 and 1200 qualify
    expect(activeMarkerIndex([0, 1200, 2400], 1000, 500)).toBe(1);
  });

  it('returns the final anchor when scrolled to the bottom', () => {
    expect(activeMarkerIndex([0, 1200, 2400], 2400, 500)).toBe(2);
  });
});
