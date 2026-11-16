import { describe, expect, it } from 'vitest';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import { parseInterruptBoundary } from './display-item-metadata-parsers';

function boundary(metadata: Record<string, unknown>): OutputMessage {
  return {
    id: 'b1',
    type: 'system',
    timestamp: 10,
    content: 'Stopped.',
    metadata: { kind: 'interrupt-boundary', requestId: 'req-1', at: 10, ...metadata },
  };
}

describe('parseInterruptBoundary', () => {
  it('words the divider as a sentence, not "phase · outcome" codes', () => {
    const parsed = parseInterruptBoundary(boundary({ phase: 'completed', outcome: 'respawn-fallback' }));
    expect(parsed?.text).toBe('Stopped. The session restarted with only your recent messages carried over, so earlier detail may be missing.');
    expect(parsed?.text).not.toMatch(/respawn-fallback|completed ·/i);
  });

  it('reads the same for a stored row, because the words come from the metadata', () => {
    const stored = { ...boundary({ phase: 'completed', outcome: 'respawn-success' }), content: 'Interrupt completed: respawn-success' };
    expect(parseInterruptBoundary(stored)?.text).toBe('Stopped. The session restarted and kept its history.');
  });

  it('ignores messages that are not boundaries or carry unknown codes', () => {
    expect(parseInterruptBoundary({ ...boundary({ phase: 'completed', outcome: 'cancelled' }), type: 'assistant' })).toBeNull();
    expect(parseInterruptBoundary(boundary({ phase: 'nonsense', outcome: 'cancelled' }))).toBeNull();
  });
});
