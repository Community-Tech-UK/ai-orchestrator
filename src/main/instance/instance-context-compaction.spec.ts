/**
 * Compaction trims the output buffer far harder than the buffer-size trim and
 * persists nothing to disk storage, so it is the path most able to destroy the
 * user's opening prompt outright. This covers the non-worker fallback; the
 * production worker path is covered in __tests__/context-worker-client.spec.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Constructing the manager otherwise starts the real unified-memory controller,
// which fires a background request and leaks an unhandled rejection into the suite.
vi.mock('../memory/unified-controller', () => ({
  getUnifiedMemory: () => ({ retrieve: vi.fn().mockResolvedValue(null) }),
}));
vi.mock('../rlm/context-manager', () => ({
  RLMContextManager: { getInstance: () => ({ getStore: vi.fn(), executeQuery: vi.fn() }) },
}));

import { InstanceContextManager } from './instance-context';

function message(id: string, type: OutputMessage['type'], content: string, timestamp: number): OutputMessage {
  return { id, type, content, timestamp } as OutputMessage;
}

function instanceWithOpeningPrompt(): Instance {
  return {
    id: 'inst-1',
    outputBuffer: [
      message('p0', 'user', 'Migrate the billing service.', 1),
      ...Array.from({ length: 60 }, (_, i) =>
        message(`m${i}`, 'tool_result', `noise ${i}`, i + 2)),
    ],
  } as unknown as Instance;
}

describe('InstanceContextManager.compactContext', () => {
  it('retains an evicted opening prompt beside the trimmed buffer', async () => {
    const instance = instanceWithOpeningPrompt();

    await new InstanceContextManager().compactContext('inst-1', instance);

    expect(instance.outputBuffer).toHaveLength(50);
    expect(instance.outputBuffer.some((m) => m.id === 'p0')).toBe(false);
    expect(instance.retainedPrompts?.map((m) => m.content)).toEqual(['Migrate the billing service.']);
  });

  it('leaves a short buffer and its prompts untouched', async () => {
    const instance = {
      id: 'inst-2',
      outputBuffer: [message('p0', 'user', 'Short session.', 1)],
    } as unknown as Instance;

    await new InstanceContextManager().compactContext('inst-2', instance);

    expect(instance.outputBuffer).toHaveLength(1);
    expect(instance.retainedPrompts).toBeUndefined();
  });
});
