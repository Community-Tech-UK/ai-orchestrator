import { describe, expect, it, vi } from 'vitest';

import type { CodexContextCostController } from './context-cost-controller';
import { awaitProviderCompactionSettled, createProviderCompactionSendGate } from './provider-compaction-send-gate';
import { runCodexInputSend } from './input-send-lifecycle';

describe('provider compaction send gate', () => {
  it.each(['cancelled', 'observed', 'no-compaction'] as const)('keeps cancellation quiet when compaction returns %s to the outer send gate', async (outcome) => {
    const abort = new AbortController();
    const emitPaused = vi.fn();
    const emitTurnError = vi.fn();
    const emitOutput = vi.fn();
    const nativeWrite = vi.fn();
    const controller = {
      isCompactionRunning: () => outcome !== 'no-compaction',
      awaitCompactionSettled: async () => { abort.abort(); return outcome === 'cancelled' ? 'cancelled' : 'observed'; },
    } as unknown as CodexContextCostController;
    const gate = createProviderCompactionSendGate({ controller, signal: abort.signal, emitPaused });
    const sending = runCodexInputSend({
      isSpawned: () => true, isAppServerMode: () => true, hasAppServerClient: () => true,
      hasActiveTurn: () => false, isProviderCompacting: () => true, isRecoverableTurnError: () => false,
      sendAppServer: () => gate(nativeWrite), sendExec: nativeWrite,
      emitStatus: vi.fn(), emitOutput, emitTurnError,
    });
    abort.abort();
    await expect(sending).rejects.toMatchObject({ name: 'AbortError' });
    expect(emitPaused).not.toHaveBeenCalled();
    expect(emitTurnError).not.toHaveBeenCalled();
    expect(emitOutput).not.toHaveBeenCalled();
    expect(nativeWrite).not.toHaveBeenCalled();
  });
  it('uses collision-resistant ids for simultaneous paused notices', async () => {
    const emitted: { id: string }[] = [];
    const controller = {
      isCompactionRunning: () => true,
      awaitCompactionSettled: vi.fn(async () => 'stalled' as const),
    } as unknown as CodexContextCostController;

    const first = awaitProviderCompactionSettled({ controller, emitPaused: (message) => emitted.push(message) });
    const second = awaitProviderCompactionSettled({ controller, emitPaused: (message) => emitted.push(message) });

    await expect(first).rejects.toThrow('Codex is still compacting');
    await expect(second).rejects.toThrow('Codex is still compacting');
    expect(emitted).toHaveLength(2);
    expect(new Set(emitted.map(({ id }) => id)).size).toBe(2);
  });
});
