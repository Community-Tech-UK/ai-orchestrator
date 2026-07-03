import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { ClaudeCliAdapter } from './claude-cli-adapter';
import type { OutputMessage } from '../../../shared/types/instance.types';

interface Feed {
  outputs: OutputMessage[];
  feed: (m: unknown) => void;
}
function makeAdapter(): Feed {
  const adapter = new ClaudeCliAdapter();
  const outputs: OutputMessage[] = [];
  adapter.on('output', (m: OutputMessage) => outputs.push(m));
  const feed = (adapter as unknown as { processCliMessage: (m: unknown) => void })
    .processCliMessage.bind(adapter);
  return { outputs, feed };
}

const rl = (status: string, resetsAt = 1893456000) => ({
  type: 'rate_limit_event',
  timestamp: 3,
  rate_limit_info: { status, rateLimitType: 'seven_day_overage_included', resetsAt },
});

describe('Claude adapter: assistant text blocks are never dropped or merged', () => {
  // Reproduces the reported incident shape:
  //   text A -> tool -> [rate-limit storm] -> text B (long) -> tool -> text C
  it('emits every text block as its own assistant output through a rate-limit storm', () => {
    const { outputs, feed } = makeAdapter();
    const textA = 'Good screenshot. Researching EasyPeasy now.';
    const textB = 'B-DELIVERABLE '.repeat(80).trim();
    const textC = 'Done. File updated.';

    feed({ type: 'assistant', timestamp: 1, message: { content: [
      { type: 'text', text: textA },
      { type: 'tool_use', id: 't1', name: 'WebSearch', input: { q: 'x' } },
    ] } });
    feed({ type: 'user', timestamp: 2, message: { content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'results' },
    ] } });

    // `allowed` heartbeats interleave with the warning — the old guard re-fired
    // on every allowed->warning flip and stacked duplicate notices.
    feed(rl('allowed_warning'));
    feed(rl('allowed'));
    feed(rl('allowed_warning'));
    feed(rl('allowed'));
    feed(rl('allowed_warning'));

    feed({ type: 'assistant', timestamp: 4, message: { content: [
      { type: 'text', text: textB },
      { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/tmp/x' } },
    ] } });
    feed({ type: 'user', timestamp: 5, message: { content: [
      { type: 'tool_result', tool_use_id: 't2', content: 'ok' },
    ] } });

    feed({ type: 'assistant', timestamp: 6, message: { content: [
      { type: 'text', text: textC },
    ] } });

    const assistantTexts = outputs.filter(o => o.type === 'assistant').map(o => o.content);
    expect(assistantTexts).toContain(textA);
    expect(assistantTexts).toContain(textB);
    expect(assistantTexts).toContain(textC);

    // Deliverable: identical consecutive rate-limit notices show once.
    const rlNotices = outputs.filter(o => o.type === 'system' && o.metadata?.['rateLimit']);
    expect(rlNotices).toHaveLength(1);
  });

  it('emits each text block separately, in document order, around an in-message tool_use', () => {
    const { outputs, feed } = makeAdapter();
    feed({ type: 'assistant', timestamp: 1, message: { content: [
      { type: 'text', text: 'BEFORE-TOOL' },
      { type: 'tool_use', id: 't1', name: 'Edit', input: {} },
      { type: 'text', text: 'AFTER-TOOL' },
    ] } });

    const seq = outputs.map(o => `${o.type}:${o.content}`);
    expect(seq).toEqual([
      'assistant:BEFORE-TOOL',
      'tool_use:Using tool: Edit',
      'assistant:AFTER-TOOL',
    ]);
  });

  it('never merges distinct text blocks into one output', () => {
    const { outputs, feed } = makeAdapter();
    feed({ type: 'assistant', timestamp: 1, message: { content: [
      { type: 'text', text: 'A' },
      { type: 'tool_use', id: 't1', name: 'WebSearch', input: {} },
      { type: 'text', text: 'B'.repeat(500) },
      { type: 'tool_use', id: 't2', name: 'Edit', input: {} },
      { type: 'text', text: 'C' },
    ] } });

    const texts = outputs.filter(o => o.type === 'assistant').map(o => o.content);
    expect(texts).toEqual(['A', 'B'.repeat(500), 'C']);
  });

  it('re-notifies when a genuinely new throttle window (different resetsAt) arrives', () => {
    const { outputs, feed } = makeAdapter();
    feed(rl('allowed_warning', 1893456000));
    feed(rl('allowed'));
    feed(rl('allowed_warning', 1893456000)); // same window -> suppressed
    feed(rl('allowed_warning', 1900000000)); // new window -> re-notify
    const rlNotices = outputs.filter(o => o.type === 'system' && o.metadata?.['rateLimit']);
    expect(rlNotices).toHaveLength(2);
  });
});
