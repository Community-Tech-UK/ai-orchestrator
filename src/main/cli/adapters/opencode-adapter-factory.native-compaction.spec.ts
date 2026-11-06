import { describe, expect, it, vi } from 'vitest';
import { createOpenCodeAdapter } from './opencode-adapter-factory';
import { AcpCliAdapter } from './acp-cli-adapter';

/**
 * Plan 11b: the OpenCode factory is the only place that turns on native
 * compaction and the `opencode-acp` capability profile. These tests build the
 * adapter through the real factory so deleting either wired line fails them.
 */
describe('createOpenCodeAdapter native compaction wiring', () => {
  it('reports the opencode-acp context capability profile (provider compacts inline)', () => {
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp' });
    expect(adapter.getContextCapabilities()).toMatchObject({
      transcriptControl: 'native-compaction',
      compactionProof: 'acknowledged-only',
      providerAutoCompaction: 'inline',
    });
  });

  it('advertises native compaction and sends exactly /compact when asked to compact', async () => {
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp' });
    expect(adapter.getRuntimeCapabilities().supportsNativeCompaction).toBe(true);

    const send = vi.spyOn(adapter, 'sendMessage').mockResolvedValue({
      id: 'compact-fixture', role: 'assistant', content: '', metadata: { stopReason: 'end_turn' },
    });
    const notices: unknown[] = [];
    adapter.on('output', (message) => notices.push(message));

    await expect(adapter.compactContext()).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ role: 'user', content: '/compact' });
    expect(notices).toEqual([expect.objectContaining({
      type: 'system',
      content: 'OpenCode compacted this conversation.',
      metadata: expect.objectContaining({ threadCompacted: true, source: 'opencode-compact' }),
    })]);
  });
});

describe('ACP adapter without the OpenCode wiring', () => {
  it('reports no native compaction and no provider auto-compaction', async () => {
    const adapter = new AcpCliAdapter({ command: 'acp-placeholder', workingDirectory: '/tmp' });
    expect(adapter.getRuntimeCapabilities().supportsNativeCompaction).toBe(false);
    expect(adapter.getContextCapabilities().providerAutoCompaction).not.toBe('inline');
    expect(adapter.getContextCapabilities().transcriptControl).not.toBe('native-compaction');
    await expect(adapter.compactContext()).resolves.toBe(false);
  });
});
