import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { InstanceContextPort } from '../instance/instance-context-port';
vi.mock('./compaction-coordinator', () => ({ getCompactionCoordinator: () => ({ onContextUpdate: vi.fn(), compactInstance: vi.fn(async () => ({ success: true })), cleanupInstance: vi.fn() }) }));
import { LegacyContextEngine } from './context-engine';

const instance = { id: 'instance', sessionId: 'one', restartEpoch: 0 } as Instance;
function port() {
  return { calculateContextBudget: vi.fn(() => ({ totalTokens: 300, rlmMaxTokens: 200, unifiedMaxTokens: 100, rlmTopK: 3 })),
    buildRlmContext: vi.fn(async () => ({ context: '[Match 1] Old section\nUseful content', tokens: 12, sectionsAccessed: ['one'], source: 'hybrid' as const, durationMs: 1 })),
    buildUnifiedMemoryContext: vi.fn(async () => ({ context: 'Long-term Memory:\n- retained insight', tokens: 10, longTermCount: 1, proceduralCount: 0, durationMs: 1 })) };
}
describe('retrieved notes runtime policy', () => {
  it('cleans all lookup queries while budgeting against the raw message', async () => {
    const context = port(); const engine = new LegacyContextEngine();
    const raw = 'Pasted log line\n'.repeat(100) + 'Why does migration rollback fail after restart?';
    const code = vi.fn(async (_instance: Instance, _message: string, _strategy?: string) => null);
    await engine.assemble({ instance, message: raw, contextPort: context as unknown as InstanceContextPort, taskId: 'task', buildIndexedCodebaseContext: code });
    expect(context.calculateContextBudget).toHaveBeenCalledWith(instance, raw);
    expect(context.buildRlmContext).toHaveBeenCalledWith(instance.id, 'Why does migration rollback fail after restart?', 200, 3, 'last-question');
    expect(context.buildUnifiedMemoryContext).toHaveBeenCalledWith(instance, 'Why does migration rollback fail after restart?', 'task', 100);
    expect(code).toHaveBeenCalledWith(instance, 'Why does migration rollback fail after restart?', 'last-question');
  });
  it('skips continue, drops repeats, and restores recall after restart or cleanup', async () => {
    const context = port(); const engine = new LegacyContextEngine();
    const assemble = (message: string, target = instance) => engine.assemble({ instance: target, message, contextPort: context as unknown as InstanceContextPort });
    expect((await assemble('continue')).rlmContext).toBeNull(); expect(context.buildRlmContext).not.toHaveBeenCalled();
    expect((await assemble('Investigate migration rollback transaction failures')).rlmContext).not.toBeNull();
    expect((await assemble('Investigate migration rollback transaction failures')).rlmContext).toBeNull();
    expect((await assemble('Investigate migration rollback transaction failures', { ...instance, restartEpoch: 1 })).rlmContext).not.toBeNull();
    engine.cleanupInstance(instance.id);
    expect((await assemble('Investigate migration rollback transaction failures')).unifiedMemoryContext).not.toBeNull();
  });
  it('restores recall after observed and successful explicit compaction without changing the native session id', async () => {
    const context = port(); const engine = new LegacyContextEngine();
    const assemble = () => engine.assemble({ instance, message: 'Investigate migration rollback transaction failures', contextPort: context as unknown as InstanceContextPort });
    expect((await assemble()).rlmContext).not.toBeNull(); expect((await assemble()).rlmContext).toBeNull();
    engine.onContextUpdate(instance.id, { used: 0, total: 1000, percentage: 0, source: 'thread-compacted' });
    expect((await assemble()).rlmContext).not.toBeNull();
    await engine.compactInstance(instance.id); expect((await assemble()).rlmContext).not.toBeNull();
  });

});
