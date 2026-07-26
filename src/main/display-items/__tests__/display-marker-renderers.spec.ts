import { describe, expect, it } from 'vitest';
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
});
