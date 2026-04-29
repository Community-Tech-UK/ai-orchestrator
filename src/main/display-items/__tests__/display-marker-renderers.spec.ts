import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { buildCompactionSummaryMessage, registerCompactionSummaryRenderer } from '../compaction-summary-renderer';
import { buildInterruptBoundaryMessage } from '../interrupt-boundary-renderer';

describe('display marker renderers', () => {
  it('builds structured interrupt boundary messages', () => {
    const message = buildInterruptBoundaryMessage({
      phase: 'completed',
      requestId: 'req-1',
      outcome: 'respawn-success',
      at: 10,
      fallbackMode: 'native-resume',
    });

    expect(message.metadata).toMatchObject({
      kind: 'interrupt-boundary',
      phase: 'completed',
      requestId: 'req-1',
      outcome: 'respawn-success',
      fallbackMode: 'native-resume',
    });
  });

  it('builds and forwards compaction summary messages', () => {
    const continuity = new EventEmitter();
    const emitOutputMessage = vi.fn();
    registerCompactionSummaryRenderer(continuity, { emitOutputMessage });

    continuity.emit('session:compaction-display', {
      instanceId: 'inst-1',
      reason: 'context-budget',
      beforeCount: 100,
      afterCount: 40,
    });

    expect(emitOutputMessage).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({
        metadata: expect.objectContaining({
          kind: 'compaction-summary',
          reason: 'context-budget',
          beforeCount: 100,
          afterCount: 40,
        }),
      }),
    );
  });

  it('builds compact compaction messages without transcripts', () => {
    expect(buildCompactionSummaryMessage({
      instanceId: 'inst-1',
      reason: 'context-budget',
      beforeCount: 100,
      afterCount: 40,
    }).content).toBe('Context compacted: 100 -> 40 messages');
  });
});
