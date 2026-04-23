import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildSystemGroupPreview,
  DisplayItemProcessor,
  resolveSystemActionLabel,
} from './display-item-processor.service';
import type { OutputMessage } from '../../core/state/instance/instance.types';

function makeMsg(overrides: Partial<OutputMessage> = {}): OutputMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    type: 'assistant',
    content: 'Hello',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeOrchMsg(
  action: string,
  content: string,
  overrides: Partial<OutputMessage> = {},
): OutputMessage {
  return {
    id: `orch-${Math.random().toString(36).slice(2)}`,
    type: 'system',
    content,
    timestamp: Date.now(),
    metadata: { source: 'orchestration', action, status: 'SUCCESS', rawData: {} },
    ...overrides,
  };
}

describe('DisplayItemProcessor', () => {
  let processor: DisplayItemProcessor;

  beforeEach(() => {
    processor = new DisplayItemProcessor();
  });

  it('should process a single message into a display item', () => {
    const msg = makeMsg();
    const items = processor.process([msg]);
    expect(items.length).toBe(1);
    expect(items[0].type).toBe('message');
    expect(items[0].message?.id).toBe(msg.id);
  });

  it('should group consecutive tool messages into a tool-group', () => {
    const msgs = [
      makeMsg({ type: 'tool_use', id: 'tu1' }),
      makeMsg({ type: 'tool_result', id: 'tr1' }),
    ];
    const items = processor.process(msgs);
    expect(items.length).toBe(1);
    expect(items[0].type).toBe('tool-group');
    expect(items[0].toolMessages?.length).toBe(2);
  });

  it('should collapse repeated identical messages', () => {
    const msgs = [
      makeMsg({ content: 'Same response', type: 'assistant', id: 'e1' }),
      makeMsg({ content: 'Same response', type: 'assistant', id: 'e2' }),
      makeMsg({ content: 'Same response', type: 'assistant', id: 'e3' }),
    ];
    const items = processor.process(msgs);
    expect(items.length).toBe(1);
    expect(items[0].repeatCount).toBe(3);
    expect(items[0].bufferIndex).toBe(2);
  });

  it('should NOT collapse repeated system messages', () => {
    const msgs = [
      makeMsg({ content: 'System notice', type: 'system', id: 's1' }),
      makeMsg({ content: 'System notice', type: 'system', id: 's2' }),
      makeMsg({ content: 'System notice', type: 'system', id: 's3' }),
    ];
    const items = processor.process(msgs);
    expect(items.length).toBe(3);
    expect(items[0].repeatCount).toBeUndefined();
  });

  it('should create thought-group for messages with thinking and no standalone content', () => {
    const msg = makeMsg({
      type: 'assistant',
      content: '',
      thinking: [{ id: 'think1', content: 'Let me think...', format: 'structured' }],
    });
    const items = processor.process([msg]);
    expect(items.length).toBe(1);
    expect(items[0].type).toBe('thought-group');
    expect(items[0].response?.id).toBe(msg.id);
  });

  it('should split thought-group from standalone assistant content', () => {
    const msg = makeMsg({
      type: 'assistant',
      content: 'Hello',
      thinking: [{ id: 'think1', content: 'Let me think...', format: 'structured' }],
    });
    const items = processor.process([msg]);
    expect(items.length).toBe(2);
    expect(items[0].type).toBe('thought-group');
    expect(items[0].response).toBeUndefined();
    expect(items[1].type).toBe('message');
    expect(items[1].message?.id).toBe(msg.id);
  });

  it('should incrementally append new messages', () => {
    const msg1 = makeMsg({ timestamp: 1000, content: 'First message' });
    processor.process([msg1]);

    const msg2 = makeMsg({ timestamp: 2000, content: 'Second message' });
    const items = processor.process([msg1, msg2]);
    expect(items.length).toBe(2);
  });

  it('should compute showHeader based on sender and time gap', () => {
    const now = Date.now();
    const msgs = [
      makeMsg({ type: 'assistant', timestamp: now, id: 'a1', content: 'Message one' }),
      makeMsg({ type: 'assistant', timestamp: now + 1000, id: 'a2', content: 'Message two' }),
      makeMsg({ type: 'assistant', timestamp: now + 200000, id: 'a3', content: 'Message three' }),
    ];
    const items = processor.process(msgs);
    expect(items[0].showHeader).toBe(true);
    expect(items[1].showHeader).toBe(false);
    expect(items[2].showHeader).toBe(true);
  });

  it('should reset on instance switch', () => {
    const msg1 = makeMsg({ id: 'a' });
    processor.process([msg1], 'instance-1');

    const msg2 = makeMsg({ id: 'b' });
    const items = processor.process([msg2], 'instance-2');
    expect(items.length).toBe(1);
    expect(items[0].message?.id).toBe('b');
  });

  it('should track newItemCount correctly', () => {
    const msg1 = makeMsg({ id: 'a' });
    processor.process([msg1]);
    expect(processor.newItemCount).toBe(1);

    const msg2 = makeMsg({ id: 'b' });
    processor.process([msg1, msg2]);
    expect(processor.newItemCount).toBe(1);
  });

  it('should handle first-time streaming messages', () => {
    const msg = makeMsg({
      id: 'stream1',
      metadata: { streaming: true, accumulatedContent: 'Hello world' },
    });
    const items = processor.process([msg]);
    expect(items.length).toBe(1);
    expect(items[0].type).toBe('message');
    expect(items[0].message?.content).toBe('Hello world');
  });

  it('should update existing streaming message on duplicate', () => {
    const msg1 = makeMsg({
      id: 'stream1',
      content: 'Hel',
      metadata: { streaming: true, accumulatedContent: 'Hel' },
    });
    processor.process([msg1]);

    const msg2 = makeMsg({
      id: 'stream1',
      content: 'Hello world',
      metadata: { streaming: true, accumulatedContent: 'Hello world' },
    });
    const items = processor.process([msg1, msg2]);
    expect(items.length).toBe(1);
    expect(items[0].message?.content).toBe('Hello world');
  });

  it('should merge tool messages across process() calls', () => {
    const toolUse = makeMsg({ type: 'tool_use', id: 'tu1' });
    processor.process([toolUse]);

    const toolResult = makeMsg({ type: 'tool_result', id: 'tr1' });
    const items = processor.process([toolUse, toolResult]);
    expect(items.length).toBe(1);
    expect(items[0].type).toBe('tool-group');
    expect(items[0].toolMessages?.length).toBe(2);
  });

  it('should set bufferIndex on each message item', () => {
    const messages: OutputMessage[] = [
      { id: '1', timestamp: 1000, type: 'user', content: 'hello' },
      { id: '2', timestamp: 2000, type: 'assistant', content: 'hi' },
      { id: '3', timestamp: 3000, type: 'user', content: 'how are you' },
    ];
    const items = processor.process(messages);
    const messageItems = items.filter(i => i.type === 'message');
    for (const item of messageItems) {
      expect(item.bufferIndex).toBeDefined();
      expect(typeof item.bufferIndex).toBe('number');
    }
    expect(messageItems[0].bufferIndex).toBe(0);
  });

  describe('system-event grouping', () => {
    it('groups consecutive orchestration messages with the same action', () => {
      const msgs = [
        makeOrchMsg('get_children', '**Active children:**\n- foo idle', {
          id: 'g1',
          timestamp: 1_000,
        }),
        makeOrchMsg('get_children', '**Active children:**\n- foo busy', {
          id: 'g2',
          timestamp: 2_000,
        }),
      ];

      const items = processor.process(msgs);

      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('system-event-group');
      expect(items[0].groupAction).toBe('get_children');
      expect(items[0].groupLabel).toBe('Active children polled');
      expect(items[0].systemEvents?.map(message => message.id)).toEqual(['g1', 'g2']);
      expect(items[0].groupPreview).toContain('foo busy');
    });

    it('extends an existing system-event-group across process() calls', () => {
      const m1 = makeOrchMsg('get_children', 'a', { id: 'g1', timestamp: 1_000 });
      const m2 = makeOrchMsg('get_children', 'b', { id: 'g2', timestamp: 2_000 });
      processor.process([m1, m2]);

      const m3 = makeOrchMsg('get_children', 'c', { id: 'g3', timestamp: 3_000 });
      const items = processor.process([m1, m2, m3]);

      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('system-event-group');
      expect(items[0].systemEvents?.map(message => message.id)).toEqual(['g1', 'g2', 'g3']);
      expect(items[0].groupPreview).toContain('c');
    });

    it('does not group across an always-visible action', () => {
      const msgs = [
        makeOrchMsg('get_children', 'a', { id: 'g1', timestamp: 1_000 }),
        makeOrchMsg('get_children', 'b', { id: 'g2', timestamp: 2_000 }),
        makeOrchMsg('task_complete', 'done', { id: 'tc1', timestamp: 3_000 }),
        makeOrchMsg('get_children', 'c', { id: 'g3', timestamp: 4_000 }),
        makeOrchMsg('get_children', 'd', { id: 'g4', timestamp: 5_000 }),
      ];

      const items = processor.process(msgs);

      expect(items).toHaveLength(3);
      expect(items[0].type).toBe('system-event-group');
      expect(items[1].type).toBe('message');
      expect(items[1].message?.id).toBe('tc1');
      expect(items[2].type).toBe('system-event-group');
      expect(items[2].systemEvents?.map(message => message.id)).toEqual(['g3', 'g4']);
    });

    it('leaves a single orchestration message ungrouped', () => {
      const items = processor.process([
        makeOrchMsg('get_children', 'lone poll', { id: 'g1', timestamp: 1_000 }),
      ]);

      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('message');
      expect(items[0].message?.id).toBe('g1');
    });

    it('keeps different orchestration actions in separate groups', () => {
      const msgs = [
        makeOrchMsg('get_children', 'a', { id: 'g1', timestamp: 1_000 }),
        makeOrchMsg('get_children', 'b', { id: 'g2', timestamp: 2_000 }),
        makeOrchMsg('get_child_output', 'x', { id: 'o1', timestamp: 3_000 }),
        makeOrchMsg('get_child_output', 'y', { id: 'o2', timestamp: 4_000 }),
      ];

      const items = processor.process(msgs);

      expect(items).toHaveLength(2);
      expect(items[0].type).toBe('system-event-group');
      expect(items[0].groupAction).toBe('get_children');
      expect(items[1].type).toBe('system-event-group');
      expect(items[1].groupAction).toBe('get_child_output');
    });

    it('starts a new group after the time-gap ceiling', () => {
      const start = 1_000_000;
      const sixMinutes = 6 * 60 * 1000;
      const msgs = [
        makeOrchMsg('get_children', 'a', { id: 'g1', timestamp: start }),
        makeOrchMsg('get_children', 'b', { id: 'g2', timestamp: start + 1_000 }),
        makeOrchMsg('get_children', 'c', { id: 'g3', timestamp: start + sixMinutes }),
        makeOrchMsg('get_children', 'd', { id: 'g4', timestamp: start + sixMinutes + 1_000 }),
      ];

      const items = processor.process(msgs);

      expect(items).toHaveLength(2);
      expect(items[0].type).toBe('system-event-group');
      expect(items[0].systemEvents?.map(message => message.id)).toEqual(['g1', 'g2']);
      expect(items[1].type).toBe('system-event-group');
      expect(items[1].systemEvents?.map(message => message.id)).toEqual(['g3', 'g4']);
    });

    it('absorbs empty assistant turns between grouped orchestration messages', () => {
      const msgs = [
        makeOrchMsg('get_children', 'a', { id: 'g1', timestamp: 1_000 }),
        makeMsg({ type: 'assistant', content: '   ', id: 'a1', timestamp: 1_500 }),
        makeOrchMsg('get_children', 'b', { id: 'g2', timestamp: 2_000 }),
        makeMsg({ type: 'assistant', content: '\n\n', id: 'a2', timestamp: 2_500 }),
        makeOrchMsg('get_children', 'c', { id: 'g3', timestamp: 3_000 }),
      ];

      const items = processor.process(msgs);

      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('system-event-group');
      expect(items[0].systemEvents?.map(message => message.id)).toEqual(['g1', 'g2', 'g3']);
    });

    it('does not absorb non-empty assistant turns between orchestration messages', () => {
      const msgs = [
        makeOrchMsg('get_children', 'a', { id: 'g1', timestamp: 1_000 }),
        makeMsg({ type: 'assistant', content: 'real reply', id: 'a1', timestamp: 1_500 }),
        makeOrchMsg('get_children', 'b', { id: 'g2', timestamp: 2_000 }),
      ];

      const items = processor.process(msgs);

      expect(items).toHaveLength(3);
      expect(items.every(item => item.type === 'message')).toBe(true);
    });
  });

  describe('work-cycle wrapping', () => {
    it('wraps a sealed run of thinking + tools + errors into a work-cycle', () => {
      const base = Date.now();
      const msgs: OutputMessage[] = [
        { id: 'u1', type: 'user', content: 'go', timestamp: base },
        { id: 't1', type: 'assistant', content: '', timestamp: base + 100,
          thinking: [{ id: 'th1', content: 'thinking a', format: 'structured' }] },
        { id: 'tu1', type: 'tool_use', content: 'bash', timestamp: base + 200 },
        { id: 'tr1', type: 'tool_result', content: 'ok', timestamp: base + 300 },
        { id: 't2', type: 'assistant', content: '', timestamp: base + 400,
          thinking: [{ id: 'th2', content: 'thinking b', format: 'structured' }] },
        { id: 'err1', type: 'error', content: 'oops', timestamp: base + 500 },
        { id: 'a1', type: 'assistant', content: 'final reply', timestamp: base + 600 },
      ];
      const items = processor.process(msgs);
      // [user, work-cycle(thought+tool-group+thought+error), assistant]
      expect(items.length).toBe(3);
      expect(items[0].type).toBe('message');
      expect(items[1].type).toBe('work-cycle');
      expect(items[1].children?.length).toBe(4);
      expect(items[2].type).toBe('message');
    });

    it('leaves a trailing unsealed run flat so streaming stays visible', () => {
      const base = Date.now();
      const msgs: OutputMessage[] = [
        { id: 'u1', type: 'user', content: 'go', timestamp: base },
        { id: 't1', type: 'assistant', content: '', timestamp: base + 100,
          thinking: [{ id: 'th1', content: 'thinking', format: 'structured' }] },
        { id: 'tu1', type: 'tool_use', content: 'bash', timestamp: base + 200 },
        { id: 'tr1', type: 'tool_result', content: 'ok', timestamp: base + 300 },
      ];
      const items = processor.process(msgs);
      // user, thought-group, tool-group — trailing run stays flat (no assistant yet)
      expect(items.length).toBe(3);
      expect(items.find(i => i.type === 'work-cycle')).toBeUndefined();
    });

    it('does not wrap a single thought-group (run of 1)', () => {
      const base = Date.now();
      const msgs: OutputMessage[] = [
        { id: 'u1', type: 'user', content: 'go', timestamp: base },
        { id: 't1', type: 'assistant', content: '', timestamp: base + 100,
          thinking: [{ id: 'th1', content: 'thinking', format: 'structured' }] },
        { id: 'a1', type: 'assistant', content: 'reply', timestamp: base + 200 },
      ];
      const items = processor.process(msgs);
      expect(items.length).toBe(3);
      expect(items[1].type).toBe('thought-group');
    });
  });

  it('should offset bufferIndex by the hidden-history count', () => {
    const messages: OutputMessage[] = [
      { id: '1', timestamp: 1000, type: 'user', content: 'hello' },
      { id: '2', timestamp: 2000, type: 'assistant', content: 'hi' },
    ];
    const items = processor.process(messages, 'instance-1', 250);
    const messageItems = items.filter(i => i.type === 'message');

    expect(messageItems[0].bufferIndex).toBe(250);
    expect(messageItems[1].bufferIndex).toBe(251);
  });
});

describe('resolveSystemActionLabel', () => {
  it('returns mapped labels for known actions', () => {
    expect(resolveSystemActionLabel('get_children')).toBe('Active children polled');
    expect(resolveSystemActionLabel('task_progress')).toBe('Task progress');
  });

  it('humanizes unknown snake_case actions', () => {
    expect(resolveSystemActionLabel('some_new_action')).toBe('Some new action');
  });

  it('falls back to a placeholder for empty input', () => {
    expect(resolveSystemActionLabel('')).toBe('System event');
  });
});

describe('buildSystemGroupPreview', () => {
  it('strips markdown emphasis and collapses whitespace', () => {
    expect(buildSystemGroupPreview('**Active children:**\n- foo idle\n- bar busy'))
      .toBe('Active children: foo idle bar busy');
  });

  it('drops fenced code blocks', () => {
    expect(buildSystemGroupPreview('Output:\n```\nbig blob\n```\nend')).toBe('Output: end');
  });

  it('truncates long previews', () => {
    const preview = buildSystemGroupPreview('word '.repeat(60).trim());
    expect(preview.length).toBeLessThanOrEqual(120);
    expect(preview.endsWith('...')).toBe(true);
  });

  it('returns an empty string for empty content', () => {
    expect(buildSystemGroupPreview('')).toBe('');
  });
});
