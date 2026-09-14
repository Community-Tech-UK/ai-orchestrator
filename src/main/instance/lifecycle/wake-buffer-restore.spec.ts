import { describe, expect, it } from 'vitest';
import type { Instance } from '../../../shared/types/instance.types';
import type { ConversationEntry } from '../../session/session-continuity.types';
import { DEFAULT_SETTINGS } from '../../../shared/types/settings-defaults';
import { retainedPromptsMissingFrom } from '../prompt-retention';
import { restoreWokenOutputBuffer, selectRestoredEntries } from './wake-buffer-restore';

const KEEP = 50;

function history(count: number): ConversationEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    role: i === 0 ? 'user' : 'assistant',
    content: i === 0 ? 'Migrate the billing service.' : `turn ${i}`,
    timestamp: i + 1,
  }));
}

function instance(): Pick<Instance, 'outputBuffer' | 'retainedPrompts'> {
  return { outputBuffer: [] };
}

describe('restoreWokenOutputBuffer', () => {
  it('retains an opening prompt that falls outside the restored window', () => {
    const target = instance();

    restoreWokenOutputBuffer(target, history(KEEP + 20), 1, KEEP);

    expect(target.outputBuffer).toHaveLength(KEEP);
    expect(target.outputBuffer.some((m) => m.content === 'Migrate the billing service.')).toBe(false);
    expect(target.retainedPrompts?.map((m) => m.content)).toEqual(['Migrate the billing service.']);
  });

  it('keeps the whole history when it fits, retaining nothing', () => {
    const target = instance();

    restoreWokenOutputBuffer(target, history(10), 1, KEEP);

    expect(target.outputBuffer).toHaveLength(10);
    expect(target.outputBuffer[0].content).toBe('Migrate the billing service.');
    expect(target.retainedPrompts ?? []).toEqual([]);
  });

  it('does not accumulate duplicates across repeated hibernate/wake round trips', () => {
    // The history must be REGENERATED between wakes the way `instanceToState`
    // really does it — prepending retained-but-missing prompts and renumbering
    // every entry positionally. Replaying one static array instead cannot
    // exercise the id drift this guards, and silently passes either way.
    const target: Pick<Instance, 'outputBuffer' | 'retainedPrompts'> = {
      outputBuffer: Array.from({ length: 60 }, (_, i) => ({
        id: `m${i}`, type: 'assistant', content: `turn ${i}`, timestamp: 100 + i,
      })) as Instance['outputBuffer'],
      retainedPrompts: [
        { id: 'p0', type: 'user', content: 'Opening ask.', timestamp: 1 },
        { id: 'p1', type: 'user', content: 'Second ask.', timestamp: 2 },
      ] as Instance['outputBuffer'],
    };

    for (let cycle = 1; cycle <= 3; cycle++) {
      const persisted: ConversationEntry[] = [
        ...retainedPromptsMissingFrom(target.retainedPrompts, target.outputBuffer),
        ...target.outputBuffer,
      ].map((message, idx) => ({
        id: `msg-${idx}`,
        role: message.type === 'user' ? 'user' : 'assistant',
        content: message.content,
        timestamp: message.timestamp,
      }));
      restoreWokenOutputBuffer(target, persisted, cycle, KEEP);
    }

    expect(target.retainedPrompts?.map((p) => p.content)).toEqual([
      'Opening ask.',
      'Second ask.',
    ]);
  });

  it('leaves the instance untouched for an empty history', () => {
    const target = instance();

    restoreWokenOutputBuffer(target, [], 1, KEEP);

    expect(target.outputBuffer).toEqual([]);
    expect(target.retainedPrompts).toBeUndefined();
  });

  it('restores tool traffic as typed tool messages with their metadata', () => {
    const target = instance();

    restoreWokenOutputBuffer(target, [
      { id: 'a', role: 'user', content: 'ask', timestamp: 1 },
      {
        id: 'b', role: 'assistant', content: '', timestamp: 2,
        toolUse: { kind: 'call', toolName: 'view', callId: 'c1', input: { path: 'config.ts' } },
      },
      {
        id: 'c', role: 'tool', content: 'file body', timestamp: 3,
        toolUse: { kind: 'result', toolName: 'view', resultForCallId: 'c1', input: null, output: 'file body' },
      },
      { id: 'd', role: 'assistant', content: 'answer', timestamp: 4 },
      { id: 'e', role: 'system', content: 'notice', timestamp: 5 },
    ], 1, KEEP);

    expect(target.outputBuffer.map((m) => m.type))
      .toEqual(['user', 'tool_use', 'tool_result', 'assistant', 'system']);
    expect(target.outputBuffer[1].metadata).toMatchObject({ id: 'c1', toolName: 'view' });
    expect(target.outputBuffer[2].metadata).toMatchObject({ tool_use_id: 'c1' });
    expect(target.outputBuffer.map((m) => m.id)).toEqual([
      'restored-0-1', 'restored-1-1', 'restored-2-1', 'restored-3-1', 'restored-4-1',
    ]);
  });

  it('keeps assistant replies that precede a burst of tool traffic within the buffer size', () => {
    // The regression: a 50-entry window was filled by one minute of tool calls,
    // so every earlier reply vanished while the user's prompts survived.
    const reply: ConversationEntry = { id: 'reply', role: 'assistant', content: 'Here is my review.', timestamp: 2 };
    const burst: ConversationEntry[] = Array.from({ length: 120 }, (_, i) => ({
      id: `tool-${i}`,
      role: i % 2 === 0 ? 'assistant' : 'tool',
      content: i % 2 === 0 ? '' : 'output',
      timestamp: 10 + i,
      toolUse: { kind: i % 2 === 0 ? 'call' : 'result', toolName: 'view', input: null },
    }));
    const target = instance();

    restoreWokenOutputBuffer(target, [
      { id: 'ask', role: 'user', content: 'Review the branch.', timestamp: 1 },
      reply,
      ...burst,
    ], 1, 500);

    expect(target.outputBuffer).toHaveLength(122);
    expect(target.outputBuffer.some((m) => m.content === 'Here is my review.')).toBe(true);
  });

  it('sheds the oldest tool traffic before any conversation when history exceeds the limit', () => {
    const burst: ConversationEntry[] = Array.from({ length: 120 }, (_, i) => ({
      id: `tool-${i}`,
      role: i % 2 === 0 ? 'assistant' : 'tool',
      content: i % 2 === 0 ? '' : `output ${i}`,
      timestamp: 10 + i,
      toolUse: { kind: i % 2 === 0 ? 'call' : 'result', toolName: 'view', input: null },
    }));
    const target = instance();

    restoreWokenOutputBuffer(target, [
      { id: 'ask', role: 'user', content: 'Review the branch.', timestamp: 1 },
      { id: 'reply', role: 'assistant', content: 'Here is my review.', timestamp: 2 },
      ...burst,
      { id: 'final', role: 'assistant', content: 'Done.', timestamp: 500 },
    ], 1, KEEP);

    expect(target.outputBuffer).toHaveLength(KEEP);
    expect(target.outputBuffer.slice(0, 2).map((m) => m.content))
      .toEqual(['Review the branch.', 'Here is my review.']);
    expect(target.outputBuffer.at(-1)?.content).toBe('Done.');
    // The surviving tool traffic is the newest, still in original order.
    expect(target.outputBuffer.at(-2)?.content).toBe('output 119');
    expect(target.retainedPrompts ?? []).toEqual([]);
  });
});

describe('selectRestoredEntries', () => {
  it('drops the oldest conversation only once no tool traffic is left to shed', () => {
    const entries: ConversationEntry[] = [
      { id: 'u1', role: 'user', content: 'first', timestamp: 1 },
      { id: 't1', role: 'tool', content: 'out', timestamp: 2 },
      { id: 'a1', role: 'assistant', content: 'reply 1', timestamp: 3 },
      { id: 'u2', role: 'user', content: 'second', timestamp: 4 },
      { id: 'a2', role: 'assistant', content: 'reply 2', timestamp: 5 },
    ];

    const { kept, dropped } = selectRestoredEntries(entries, 3);

    expect(kept.map((e) => e.id)).toEqual(['a1', 'u2', 'a2']);
    expect(dropped.map((e) => e.id)).toEqual(['u1', 't1']);
  });

  it('falls back to the default buffer size for a non-finite or sub-one limit', () => {
    const entries = history(DEFAULT_SETTINGS.outputBufferSize + 5);

    expect(selectRestoredEntries(entries, Number.NaN).kept).toHaveLength(DEFAULT_SETTINGS.outputBufferSize);
    expect(selectRestoredEntries(entries, 0).kept).toHaveLength(DEFAULT_SETTINGS.outputBufferSize);
  });
});
