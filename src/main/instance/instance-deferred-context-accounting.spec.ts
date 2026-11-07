import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InputContextBundle, InputContextAssemblyDeps } from './instance-input-contexts';
import { queueDeferredInputContexts, resolveInputContextsBeforeDeadline } from './instance-input-contexts';
import { InstanceContinuityInputQueue } from './instance-continuity-input-queue';
import { createInstanceInputReceipt } from './instance-adapter-input-dispatch';
import { applyInputContextDelivery } from '../../shared/utils/input-context-delivery';
import { retrievedNotesUsage } from '../../renderer/app/features/instance-detail/retrieved-notes-usage';
import { outputMessageToContinuityEntry, continuityEntryToOutputMessage } from '../session/continuity-message-projection';
import type { OutputMessage } from '../../shared/types/instance.types';
import type { SessionContinuityManager as ContinuityManager } from '../session/session-continuity';

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({}), get: () => undefined }) }));
vi.mock('../context/context-engine.js', () => ({ getContextEngine: () => ({}) }));
vi.mock('../indexing/indexed-codebase-context', () => ({ getIndexedCodebaseContextService: () => ({ formatContextBlock: () => null }) }));
const receiptPorts = vi.hoisted(() => ({ recordUserSend: vi.fn<() => { admissionId: string } | null>(() => null), markDelivered: vi.fn(), markFailed: vi.fn() }));
vi.mock('../session/session-admission-service', () => ({ getSessionAdmissionService: () => receiptPorts }));
const bundle: InputContextBundle = { rlmContext: { context: 'Retrieved note', tokens: 120,
  sectionsAccessed: ['synthetic-section'], durationMs: 550, source: 'semantic' }, unifiedMemoryContext: null, indexedCodebaseContext: null };
afterEach(() => vi.useRealTimers());
describe('late retrieved-note accounting', () => {
  it('keeps delivery accounting independent of an admission bookkeeping failure', () => {
    receiptPorts.recordUserSend.mockReturnValueOnce({ admissionId: 'synthetic-admission' });
    receiptPorts.markDelivered.mockImplementationOnce(() => { throw new Error('Synthetic admission write failure'); });
    const delivered = vi.fn();
    const receipt = createInstanceInputReceipt('session', () => ({ message: 'Continue' }), undefined, delivered);
    receipt.record(); expect(() => receipt.delivered()).not.toThrow(); receipt.delivered();
    expect(delivered).toHaveBeenCalledOnce();
  });
  it('carries only retained formatted text and measurement through the deadline and queue', async () => {
    vi.useFakeTimers();
    const queue = new InstanceContinuityInputQueue();
    let drop = false;
    const unexpectedContextCall = (): never => { throw new Error('Unexpected context operation in deferred accounting test'); };
    const deps: InputContextAssemblyDeps = { context: {
      initializeRlm: unexpectedContextCall, endRlmSession: unexpectedContextCall,
      ingestInitialOutputToRlm: unexpectedContextCall, ingestToRLM: unexpectedContextCall,
      ingestToUnifiedMemory: unexpectedContextCall, recordTaskOutcome: unexpectedContextCall,
      calculateContextBudget: unexpectedContextCall, buildRlmContext: unexpectedContextCall,
      buildUnifiedMemoryContext: unexpectedContextCall, buildObservationContext: unexpectedContextCall,
      buildWakeContextText: unexpectedContextCall, buildMcpRuntimeToolContextSelection: unexpectedContextCall,
      compactContext: unexpectedContextCall, formatUnifiedMemoryContextBlock: () => null,
      formatRlmContextBlock: (value: InputContextBundle['rlmContext']) => drop ? null : value?.context ?? null },
      queueRetrievedContext: (id, text, tokens) => { queue.queueRetrievedContext(id, text, tokens); },
    };
    let finish!: (value: InputContextBundle) => void;
    const pending = new Promise<InputContextBundle>(resolve => { finish = resolve; });
    const deadline = resolveInputContextsBeforeDeadline('session', pending);
    await vi.advanceTimersByTimeAsync(500); expect(await deadline).toBeNull();
    queueDeferredInputContexts(deps, 'session', pending); finish(bundle); await Promise.resolve();
    queue.prepare('session', null, undefined, 'automated').commit();
    const prepared = queue.prepare('session', null, undefined, 'user');
    expect(prepared.contextBlock).toBe('Retrieved note'); expect(prepared.retrievedContextTokens).toBe(120);
    queue.queueContinuity('session', 'Replacement continuity'); prepared.commit();
    expect(queue.prepare('session', null, undefined, 'user').contextBlock).toBe('Replacement continuity');
    expect(queue.prepare('session', null, undefined, 'user').retrievedContextTokens).toBeUndefined();
    queue.cleanup('session'); drop = true;
    queueDeferredInputContexts(deps, 'session', Promise.resolve(bundle)); await Promise.resolve();
    expect(queue.prepare('session', null, undefined, 'user').contextBlock).toBeNull();
  });
  it('patches the existing continuity record and schedules normal persistence without another user turn', async () => {
    const { SessionContinuityManager } = await import('../session/session-continuity');
    const entry = { id: 'user', role: 'user' as const, timestamp: 1, content: 'Continue', retrievedContextDeliveries: { earlier: 50 },
      retrievedContextMetadata: { rlmContext: { injected: true, tokens: 50 } } };
    const state = { conversationHistory: [entry], conversationHistoryComplete: true };
    const dirty = new Set<string>();
    const recovery = new Map<string, unknown>([['session', {}]]);
    const owner = { readyPromise: Promise.resolve(), config: { persistSessionContent: true },
      sessionStates: new Map([['session', state]]), hydrateTrackedState: async () => state,
      stateRecoveryMetadata: recovery, dirty } as unknown as ContinuityManager;
    expect(await SessionContinuityManager.prototype.patchConversationEntry.call(owner, 'session', 'user',
      { retrievedContextDeliveries: { delivery: 120 } })).toBe(true);
    expect(dirty.has('session')).toBe(true); expect(recovery.has('session')).toBe(false);
    expect(state.conversationHistory).toHaveLength(1);
    expect(retrievedNotesUsage([continuityEntryToOutputMessage(JSON.parse(JSON.stringify(entry)))]))
      .toEqual({ times: 1, tokens: 220 });
    expect(await SessionContinuityManager.prototype.patchConversationEntry.call(owner, 'session', 'missing',
      { retrievedContextDeliveries: { absent: 90 } })).toBe(false);
    expect(state.conversationHistory).toHaveLength(1);
  });

  it('credits one successful receipt, restores delivered metadata and never appends an evicted user', () => {
    const user: OutputMessage = { id: 'user', type: 'user', timestamp: 1, content: 'Continue', metadata: { unrelated: true } };
    let messages = [user];
    const delivery = { messageId: user.id, deliveryId: 'delivery', tokens: 120 };
    const receipt = createInstanceInputReceipt('session', () => ({ message: user.content }), undefined, () => {
      messages = applyInputContextDelivery(messages, delivery);
    });
    receipt.record(); receipt.failed(new Error('Synthetic failed send'));
    expect(retrievedNotesUsage(messages)).toEqual({ times: 0, tokens: 0 });
    receipt.delivered(); receipt.delivered();
    expect(retrievedNotesUsage(messages)).toEqual({ times: 1, tokens: 120 });
    expect(messages[0].metadata?.['unrelated']).toBe(true);
    const persisted = JSON.parse(JSON.stringify(outputMessageToContinuityEntry(messages[0]))) as NonNullable<ReturnType<typeof outputMessageToContinuityEntry>>;
    expect(retrievedNotesUsage([continuityEntryToOutputMessage(persisted)])).toEqual({ times: 1, tokens: 120 });
    expect(applyInputContextDelivery([], delivery)).toEqual([]);
  });
});
