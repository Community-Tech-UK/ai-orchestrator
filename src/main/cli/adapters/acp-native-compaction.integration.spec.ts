import { describe, expect, it, vi } from 'vitest';
import { createInitializedAgentHarness, TestAcpCliAdapter } from './acp-cli-adapter.test-helpers';
import type { AcpSessionPromptParams } from '../../../shared/types/cli.types';
import type { OutputMessage } from '../../../shared/types/instance.types';
import { CompactionCoordinator } from '../../context/compaction-coordinator';

describe('native compact through the real ACP prompt lifecycle', () => {
  it.each(['success', 'rpc-error', 'timeout', 'exit', 'cancelled', 'client-cancel'] as const)('accepts only successful compaction: %s', async mode => {
    CompactionCoordinator._resetForTesting();
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, {
      command: 'acp-placeholder', workingDirectory: '/tmp', systemPrompt: 'fixture instructions',
      nativeCompaction: { command: '/compact', timeoutMs: 1000 }, promptTimeoutMs: 30,
    });
    const output: OutputMessage[] = [];
    adapter.on('output', message => output.push(message));
    adapter.on('status', () => undefined);
    adapter.on('error', () => undefined); // Production has error listeners; throwing must not mask false success.
    try {
      proc.onRequest('session/prompt', request => proc.respond(request.id, { stopReason: 'end_turn' }));
      await adapter.spawn(); await adapter.sendInput('ordinary first turn');
      proc.onRequest('session/prompt', request => {
        expect((request.params as AcpSessionPromptParams).prompt).toEqual([{ type: 'text', text: '/compact' }]);
        // Fail only after the actual native write callback has accepted delivery.
        setImmediate(() => {
          if (mode === 'rpc-error') proc.respondError(request.id, -32000, 'fixture provider failure');
          else if (mode === 'exit') proc.exit(1);
          else if (mode === 'client-cancel') adapter.interrupt();
          else if (mode !== 'timeout') proc.respond(request.id, { stopReason: mode === 'cancelled' ? 'cancelled' : 'end_turn' });
        });
      });
      let nativeResult: boolean | undefined;
      const fallback = vi.fn(async () => true);
      const coordinator = CompactionCoordinator.getInstance();
      coordinator.configure({ nativeCompact: async () => { nativeResult = await adapter.compactContext(); return nativeResult; },
        supportsNativeCompaction: () => adapter.getRuntimeCapabilities().supportsNativeCompaction,
        restartCompact: fallback });
      const result = await coordinator.compactInstance('fixture-instance');
      expect(nativeResult).toBe(mode === 'success');
      expect(result.method).toBe(mode === 'success' ? 'native' : 'restart-with-summary');
      expect(fallback).toHaveBeenCalledTimes(mode === 'success' ? 0 : 1);
      expect(output.filter(message => message.metadata?.['threadCompacted'])).toHaveLength(mode === 'success' ? 1 : 0);
    } finally { proc.exit(); await adapter.terminate(false); CompactionCoordinator._resetForTesting(); }
  });
});
