import { beforeEach, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { InputContextAssemblyDeps } from './instance-input-contexts';
const state = vi.hoisted(() => ({ every: false, assemble: vi.fn(async () => ({ rlmContext: null, unifiedMemoryContext: null, indexedCodebaseContext: null })) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ memoryNotesEveryMessage: state.every }) }) }));
vi.mock('../context/context-engine.js', () => ({ getContextEngine: () => ({ assemble: state.assemble }) }));
import { buildInputContexts, queueDeferredInputContexts } from './instance-input-contexts';
import { InstanceContinuityInputQueue } from './instance-continuity-input-queue';
const instance = { id: 'session', sessionId: 'native', restartEpoch: 0 } as Instance;
const deps = { context: {}, queueRetrievedContext: vi.fn() } as unknown as InputContextAssemblyDeps;
beforeEach(() => { state.every = false; state.assemble.mockClear(); });
it('skips internal plan-queue prompts and automated messages before retrieval starts', async () => {
  for (const origin of ['internal', 'automated'] as const) expect(await buildInputContexts(deps, instance, 'Plan queue prompt', origin)).toEqual({ rlmContext: null, unifiedMemoryContext: null, indexedCodebaseContext: null });
  expect(state.assemble).not.toHaveBeenCalled();
});
it('still assembles a user message and passes its policy setting', async () => {
  await buildInputContexts(deps, instance, 'Investigate migration transaction ordering please', 'user');
  expect(state.assemble).toHaveBeenCalledWith(expect.objectContaining({ memoryNotesEveryMessage: false, message: 'Investigate migration transaction ordering please' }));
});
it('restores the old every-message behavior when explicitly enabled', async () => {
  state.every = true; await buildInputContexts(deps, instance, 'continue', 'internal');
  expect(state.assemble).toHaveBeenCalledWith(expect.objectContaining({ memoryNotesEveryMessage: true }));
});

const lateBundle = {
  rlmContext: { context: 'Verifier retrieved section', sectionsAccessed: ['verifier-section'], tokens: 5, durationMs: 1, source: 'semantic' as const },
  unifiedMemoryContext: null,
  indexedCodebaseContext: null,
};

function deferredQueueDeps(queue: InstanceContinuityInputQueue, dropTag = false): InputContextAssemblyDeps {
  return {
    context: {
      formatRlmContextBlock: (c: { context: string } | null) => (c ? `[Retrieved Context]\n${c.context}` : null),
      formatUnifiedMemoryContextBlock: () => null,
    },
    queueRetrievedContext: dropTag
      ? (id: string, text: string) => { queue.queueRetrievedContext(id, text); }
      : (id: string, text: string, tokens: number | null) => { queue.queueRetrievedContext(id, text, tokens); },
  } as unknown as InputContextAssemblyDeps;
}

it('queues late retrieved context for the next user message only, never a machine turn', async () => {
  const queue = new InstanceContinuityInputQueue();
  queueDeferredInputContexts(deferredQueueDeps(queue), 'session', Promise.resolve(lateBundle));
  await Promise.resolve(); await Promise.resolve();
  for (const origin of ['internal', 'automated'] as const) {
    expect(queue.prepare('session', null, undefined, origin).contextBlock).toBeNull();
  }
  expect(queue.prepare('session', null).contextBlock).toBeNull();
  expect(queue.consume('session', null, 'user')).toBe('[Retrieved Context]\nVerifier retrieved section');
});

it('a queue hook that drops the user-only tag still cannot leak notes to a machine turn', async () => {
  const queue = new InstanceContinuityInputQueue();
  queueDeferredInputContexts(deferredQueueDeps(queue, true), 'session', Promise.resolve(lateBundle));
  await Promise.resolve(); await Promise.resolve();
  expect(queue.prepare('session', null, undefined, 'internal').contextBlock).toBeNull();
  expect(queue.prepare('session', null).contextBlock).toBeNull();
});
