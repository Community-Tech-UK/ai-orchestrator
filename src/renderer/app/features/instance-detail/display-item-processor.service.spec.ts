import { beforeEach, describe, expect, it } from 'vitest';
import {
  DisplayItemProcessor,
  resolveSystemActionLabel,
  buildSystemGroupPreview,
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

  it('should group two consecutive orchestration messages with the same action', () => {
    const msgs = [
      makeOrchMsg('get_children', '**Active children:**\n- foo idle', {
        id: 'g1', timestamp: 1_000,
      }),
      makeOrchMsg('get_children', '**Active children:**\n- foo busy', {
        id: 'g2', timestamp: 2_000,
      }),
    ];
    const items = processor.process(msgs);
    expect(items.length).toBe(1);
    expect(items[0].type).toBe('system-event-group');
    expect(items[0].systemEvents?.length).toBe(2);
    expect(items[0].groupAction).toBe('get_children');
    expect(items[0].groupLabel).toBe('Active children polled');
    expect(items[0].groupPreview).toContain('foo busy');  // latest content
  });

  it('should extend an existing system-event-group across process() calls', () => {
    const m1 = makeOrchMsg('get_children', '**Active children:**\n- a idle', { id: 'g1', timestamp: 1_000 });
    const m2 = makeOrchMsg('get_children', '**Active children:**\n- a busy', { id: 'g2', timestamp: 2_000 });
    processor.process([m1, m2]);
    const m3 = makeOrchMsg('get_children', '**Active children:**\n- a done', { id: 'g3', timestamp: 3_000 });
    const items = processor.process([m1, m2, m3]);
    expect(items.length).toBe(1);
    expect(items[0].type).toBe('system-event-group');
    expect(items[0].systemEvents?.length).toBe(3);
    expect(items[0].groupPreview).toContain('a done');
  });

  it('should not group across an always-visible action like task_complete', () => {
    const msgs = [
      makeOrchMsg('get_children', 'a', { id: 'g1', timestamp: 1_000 }),
      makeOrchMsg('get_children', 'b', { id: 'g2', timestamp: 2_000 }),
      makeOrchMsg('task_complete', 'done', { id: 'tc1', timestamp: 3_000 }),
      makeOrchMsg('get_children', 'c', { id: 'g3', timestamp: 4_000 }),
      makeOrchMsg('get_children', 'd', { id: 'g4', timestamp: 5_000 }),
    ];
    const items = processor.process(msgs);

    // Expect: [group(g1,g2), message(tc1), group(g3,g4)]
    expect(items.length).toBe(3);
    expect(items[0].type).toBe('system-event-group');
    expect(items[0].systemEvents?.length).toBe(2);
    expect(items[1].type).toBe('message');
    expect(items[1].message?.id).toBe('tc1');
    expect(items[2].type).toBe('system-event-group');
    expect(items[2].systemEvents?.length).toBe(2);
  });

  it('should leave a single orchestration message ungrouped', () => {
    const msgs = [
      makeOrchMsg('get_children', 'lone poll', { id: 'g1', timestamp: 1_000 }),
    ];
    const items = processor.process(msgs);
    expect(items.length).toBe(1);
    expect(items[0].type).toBe('message');
    expect(items[0].message?.id).toBe('g1');
  });

  it('should not merge orchestration messages with different actions', () => {
    const msgs = [
      makeOrchMsg('get_children', 'a', { id: 'g1', timestamp: 1_000 }),
      makeOrchMsg('get_children', 'b', { id: 'g2', timestamp: 2_000 }),
      makeOrchMsg('get_child_output', 'x', { id: 'o1', timestamp: 3_000 }),
      makeOrchMsg('get_child_output', 'y', { id: 'o2', timestamp: 4_000 }),
    ];
    const items = processor.process(msgs);

    expect(items.length).toBe(2);
    expect(items[0].type).toBe('system-event-group');
    expect(items[0].groupAction).toBe('get_children');
    expect(items[1].type).toBe('system-event-group');
    expect(items[1].groupAction).toBe('get_child_output');
  });

  it('should start a new system-event-group after the time-gap ceiling', () => {
    const start = 1_000_000;
    const sixMinutes = 6 * 60 * 1000;
    const msgs = [
      makeOrchMsg('get_children', 'a', { id: 'g1', timestamp: start }),
      makeOrchMsg('get_children', 'b', { id: 'g2', timestamp: start + 1_000 }),
      makeOrchMsg('get_children', 'c', { id: 'g3', timestamp: start + sixMinutes }),
      makeOrchMsg('get_children', 'd', { id: 'g4', timestamp: start + sixMinutes + 1_000 }),
    ];
    const items = processor.process(msgs);

    // First two form a group, then 6-min gap → new group of two.
    expect(items.length).toBe(2);
    expect(items[0].type).toBe('system-event-group');
    expect(items[0].systemEvents?.length).toBe(2);
    expect(items[1].type).toBe('system-event-group');
    expect(items[1].systemEvents?.length).toBe(2);
  });

  it('should absorb empty assistant turns between grouped orchestration messages', () => {
    const msgs = [
      makeOrchMsg('get_children', 'a', { id: 'g1', timestamp: 1_000 }),
      makeMsg({ type: 'assistant', content: '   ', id: 'a1', timestamp: 1_500 }),
      makeOrchMsg('get_children', 'b', { id: 'g2', timestamp: 2_000 }),
      makeMsg({ type: 'assistant', content: '\n\n', id: 'a2', timestamp: 2_500 }),
      makeOrchMsg('get_children', 'c', { id: 'g3', timestamp: 3_000 }),
    ];
    const items = processor.process(msgs);

    // Expect ONE group containing g1, g2, g3. The empty assistant items are gone.
    expect(items.length).toBe(1);
    expect(items[0].type).toBe('system-event-group');
    expect(items[0].systemEvents?.length).toBe(3);
    expect(items[0].systemEvents?.map(m => m.id)).toEqual(['g1', 'g2', 'g3']);
    expect(items[0].groupPreview).toContain('c');
  });

  it('should NOT absorb non-empty assistant turns between orchestration messages', () => {
    const msgs = [
      makeOrchMsg('get_children', 'a', { id: 'g1', timestamp: 1_000 }),
      makeMsg({ type: 'assistant', content: 'real reply', id: 'a1', timestamp: 1_500 }),
      makeOrchMsg('get_children', 'b', { id: 'g2', timestamp: 2_000 }),
    ];
    const items = processor.process(msgs);

    // Expect three items: message g1, message a1, message g2. No grouping.
    expect(items.length).toBe(3);
    expect(items.every(i => i.type === 'message')).toBe(true);
  });

  it('should create thought-group for messages with thinking', () => {
    const msg = makeMsg({
      type: 'assistant',
      thinking: [{ id: 'think1', content: 'Let me think...', format: 'structured' }],
    });
    const items = processor.process([msg]);
    expect(items.length).toBe(1);
    expect(items[0].type).toBe('thought-group');
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
  it('returns the mapped label for known actions', () => {
    expect(resolveSystemActionLabel('get_children')).toBe('Active children polled');
    expect(resolveSystemActionLabel('task_progress')).toBe('Task progress');
  });

  it('humanises unknown snake_case actions', () => {
    expect(resolveSystemActionLabel('some_new_action')).toBe('Some new action');
  });

  it('falls back to a placeholder for empty input', () => {
    expect(resolveSystemActionLabel('')).toBe('System event');
  });
});

describe('buildSystemGroupPreview', () => {
  it('strips markdown emphasis and collapses whitespace', () => {
    const out = buildSystemGroupPreview('**Active children:**\n- foo idle\n- bar busy');
    expect(out).toBe('Active children: foo idle bar busy');
  });

  it('drops fenced code blocks', () => {
    const out = buildSystemGroupPreview('Output:\n```\nbig blob\n```\nend');
    expect(out).toBe('Output: end');
  });

  it('truncates with an ellipsis when too long', () => {
    const long = 'word '.repeat(60).trim();          // 299 chars
    const out = buildSystemGroupPreview(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns an empty string for empty content', () => {
    expect(buildSystemGroupPreview('')).toBe('');
  });
});
