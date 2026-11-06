import { beforeEach, describe, expect, it } from 'vitest';
import { DisplayItemProcessor } from './display-item-processor.service';
import { ROUTINE_NOTICE_GROUP_ACTION } from './display-item-system-events';
import { ROUTINE_AUDIENCE_METADATA } from '../../../../shared/utils/system-message-audience';
import type { OutputMessage } from '../../core/state/instance/instance.types';

const WAITING = 'Interrupted — waiting for input';
const RESTARTED = 'Interrupted — session restarted (resume failed)';

function system(
  id: string,
  content: string,
  timestamp: number,
  metadata?: Record<string, unknown>,
): OutputMessage {
  return { id, type: 'system', content, timestamp, ...(metadata ? { metadata } : {}) };
}

/** Shaped like the interrupt-respawn-handler emit sites, which spread the same constant. */
function routine(id: string, timestamp: number, content = WAITING, extra: Record<string, unknown> = {}): OutputMessage {
  return system(id, content, timestamp, { ...ROUTINE_AUDIENCE_METADATA, ...extra });
}

function assistant(id: string, content: string, timestamp: number): OutputMessage {
  return { id, type: 'assistant', content, timestamp };
}

describe('DisplayItemProcessor routine notice fold (U10)', () => {
  let processor: DisplayItemProcessor;

  beforeEach(() => {
    processor = new DisplayItemProcessor();
  });

  it('folds a routine pair into one "N system events" row', () => {
    const items = processor.process([
      routine('r1', 1_000),
      routine('r2', 2_000, RESTARTED, { severity: 'warning' }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'system-event-group',
      groupAction: ROUTINE_NOTICE_GROUP_ACTION,
      groupLabel: '2 system events',
      groupPreview: RESTARTED,
    });
    expect(items[0].systemEvents?.map((message) => message.id)).toEqual(['r1', 'r2']);
  });

  it('keeps a lone routine notice as a collapsed, inspectable row instead of hiding it', () => {
    const items = processor.process([routine('r1', 1_000)]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'system-event-group', groupLabel: '1 system event' });
    expect(items[0].systemEvents?.[0].content).toBe(WAITING);
  });

  it('folds consecutive routine notices regardless of their action', () => {
    const items = processor.process([
      routine('a', 1_000, 'Active children polled', { source: 'orchestration', action: 'get_children' }),
      routine('b', 2_000, 'Child spawned', { source: 'orchestration', action: 'spawn_child' }),
      routine('c', 3_000),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].groupLabel).toBe('3 system events');
    expect(items[0].systemEvents?.map((message) => message.id)).toEqual(['a', 'b', 'c']);
  });

  it('splits the fold at an attention message', () => {
    const items = processor.process([
      routine('r1', 1_000),
      system('n1', 'Context usage at 81%.', 2_000),
      routine('r2', 3_000),
      routine('r3', 4_000),
    ]);

    expect(items.map((item) => item.type)).toEqual(['system-event-group', 'message', 'system-event-group']);
    expect(items[0].systemEvents?.map((message) => message.id)).toEqual(['r1']);
    expect(items[1].message?.id).toBe('n1');
    expect(items[2].systemEvents?.map((message) => message.id)).toEqual(['r2', 'r3']);
  });

  it('treats an explicit attention flag like no flag', () => {
    const items = processor.process([
      routine('r1', 1_000),
      system('n1', 'Heads up', 2_000, { audience: 'attention' }),
      routine('r2', 3_000),
    ]);

    expect(items.map((item) => item.type)).toEqual(['system-event-group', 'message', 'system-event-group']);
  });

  it('shows the two old exact strings when nothing flags them, so the text match is gone', () => {
    const items = processor.process([
      system('old1', WAITING, 1_000, { interruptStatus: 'interrupted' }),
      system('old2', RESTARTED, 2_000),
    ]);

    expect(items.map((item) => item.type)).toEqual(['message', 'message']);
    expect(items.map((item) => item.message?.content)).toEqual([WAITING, RESTARTED]);
  });

  it('folds the same two strings when the emit site flags them routine', () => {
    const items = processor.process([
      routine('new1', 1_000, WAITING, { interruptStatus: 'interrupted' }),
      routine('new2', 2_000, RESTARTED, { severity: 'warning' }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].systemEvents?.map((message) => message.content)).toEqual([WAITING, RESTARTED]);
  });

  it('extends the fold across process() calls and keeps the same row id', () => {
    const first = routine('r1', 1_000);
    const second = routine('r2', 2_000);
    const firstItems = processor.process([first]);
    const rowId = firstItems[0].id;

    const items = processor.process([first, second]);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(rowId);
    expect(items[0].groupLabel).toBe('2 system events');

    const third = routine('r3', 3_000);
    const later = processor.process([first, second, third]);
    expect(later).toHaveLength(1);
    expect(later[0].id).toBe(rowId);
    expect(later[0].groupLabel).toBe('3 system events');
    expect(later[0].systemEvents?.map((message) => message.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('absorbs empty assistant turns between routine notices, like the orchestration fold does', () => {
    const items = processor.process([
      routine('r1', 1_000),
      assistant('blank', '   ', 1_500),
      routine('r2', 2_000),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].systemEvents?.map((message) => message.id)).toEqual(['r1', 'r2']);
  });

  it('does not fold across a real assistant reply', () => {
    const items = processor.process([
      routine('r1', 1_000),
      assistant('reply', 'Here is the answer.', 1_500),
      routine('r2', 2_000),
    ]);

    expect(items.map((item) => item.type)).toEqual(['system-event-group', 'message', 'system-event-group']);
  });

  it('never folds a failed tool call: the tool group sits outside and splits the fold', () => {
    const items = processor.process([
      routine('r1', 1_000),
      { id: 'tu1', type: 'tool_use', content: 'Running command: npm test', timestamp: 1_500, metadata: { name: 'Bash', id: 'c1' } },
      { id: 'tr1', type: 'tool_result', content: 'boom', timestamp: 1_600, metadata: { id: 'c1', name: 'Bash', is_error: true } },
      routine('r2', 2_000),
    ]);

    expect(items.map((item) => item.type)).toEqual(['system-event-group', 'tool-group', 'system-event-group']);
    expect(items[1].toolMessages?.map((message) => message.id)).toEqual(['tu1', 'tr1']);
    expect(items[0].systemEvents).toHaveLength(1);
    expect(items[2].systemEvents).toHaveLength(1);
  });

  it.each([
    ['an approval request', { action: 'request_user_action', source: 'orchestration' }],
    ['an approval answer', { action: 'user_action_response', source: 'orchestration' }],
    ['a permission decision', { permissionDecision: true }],
    ['a blocked secret request', { secretRequestBlocked: true }],
    ['a permission prompt', { type: 'permission_denial' }],
    ['a failed tool note', { is_error: true }],
  ])('keeps %s outside the fold even if it was mis-flagged routine', (_label, extra) => {
    const items = processor.process([
      routine('r1', 1_000),
      routine('guarded', 2_000, 'Needs a decision', extra),
      routine('r2', 3_000),
    ]);

    expect(items.map((item) => item.type)).toEqual(['system-event-group', 'message', 'system-event-group']);
    expect(items[1].message?.id).toBe('guarded');
  });

  it('does not merge a routine fold with an orchestration action group', () => {
    const items = processor.process([
      system('g1', 'Active children polled', 1_000, { source: 'orchestration', action: 'get_children' }),
      routine('r1', 2_000),
      system('g2', 'Active children polled again', 3_000, { source: 'orchestration', action: 'get_children' }),
    ]);

    expect(items.map((item) => item.groupAction)).toEqual(['get_children', ROUTINE_NOTICE_GROUP_ACTION, 'get_children']);
  });

  it('still hides structural interrupt-boundary markers even when they are flagged routine', () => {
    // Those markers carry raw phase/outcome codes and are hidden by kind, not by wording.
    const items = processor.process([
      system('marker', 'Interrupt requested: unresolved', 1_000, {
        kind: 'interrupt-boundary',
        phase: 'requested',
        requestId: 'req-1',
        outcome: 'unresolved',
        at: 1_000,
        audience: 'routine',
      }),
    ]);

    expect(items).toEqual([]);
  });

  it('does not mutate the source messages when it folds them', () => {
    const first = routine('r1', 1_000);
    const second = routine('r2', 2_000);
    const snapshot = JSON.stringify([first, second]);

    processor.process([first, second]);

    expect(JSON.stringify([first, second])).toBe(snapshot);
  });
});
