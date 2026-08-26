import { describe, expect, it } from 'vitest';
import type { Instance } from '../../../shared/types/instance.types';
import { retainedPromptsMissingFrom } from '../prompt-retention';
import { WAKE_RESTORED_MESSAGES, restoreWokenOutputBuffer } from './wake-buffer-restore';

function history(count: number) {
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

    restoreWokenOutputBuffer(target, history(WAKE_RESTORED_MESSAGES + 20), 1);

    expect(target.outputBuffer).toHaveLength(WAKE_RESTORED_MESSAGES);
    expect(target.outputBuffer.some((m) => m.content === 'Migrate the billing service.')).toBe(false);
    expect(target.retainedPrompts?.map((m) => m.content)).toEqual(['Migrate the billing service.']);
  });

  it('keeps the whole history when it fits, retaining nothing', () => {
    const target = instance();

    restoreWokenOutputBuffer(target, history(10), 1);

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
      const persisted = [
        ...retainedPromptsMissingFrom(target.retainedPrompts, target.outputBuffer),
        ...target.outputBuffer,
      ].map((message, idx) => ({
        id: `msg-${idx}`,
        role: message.type === 'user' ? 'user' : 'assistant',
        content: message.content,
        timestamp: message.timestamp,
      }));
      restoreWokenOutputBuffer(target, persisted, cycle);
    }

    expect(target.retainedPrompts?.map((p) => p.content)).toEqual([
      'Opening ask.',
      'Second ask.',
    ]);
  });

  it('leaves the instance untouched for an empty history', () => {
    const target = instance();

    restoreWokenOutputBuffer(target, [], 1);

    expect(target.outputBuffer).toEqual([]);
    expect(target.retainedPrompts).toBeUndefined();
  });

  it('maps roles onto message types', () => {
    const target = instance();

    restoreWokenOutputBuffer(target, [
      { id: 'a', role: 'user', content: 'ask', timestamp: 1 },
      { id: 'b', role: 'assistant', content: 'answer', timestamp: 2 },
      { id: 'c', role: 'tool', content: 'ran', timestamp: 3 },
    ], 1);

    expect(target.outputBuffer.map((m) => m.type)).toEqual(['user', 'assistant', 'system']);
  });
});
