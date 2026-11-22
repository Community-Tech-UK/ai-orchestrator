import { describe, expect, it } from 'vitest';
import type { ProviderRuntimeEvent } from '@contracts/types/provider-runtime-events';
import { AdapterTurnEndingObservation } from './adapter-turn-ending-observation';

describe('AdapterTurnEndingObservation', () => {
  const stopDetails = { stoppedByHarness: { reason: 'turn-token-ceiling', tokens: 264825, thresholdTokens: 250000 } };

  it('keeps a Harness stop as a stop when the raw payload no longer carries the marker', () => {
    // The raw payload reaches the observer as a plain {message, willRetry} object (the error was serialised), so
    // only the event's own `details` still says Harness ended the turn on purpose.
    const event: ProviderRuntimeEvent = {
      kind: 'error', message: 'Stopped by Harness: this turn passed 250K tokens.', recoverable: false,
      details: stopDetails, turnEnding: { reason: 'completed', evidence: 'harness_stop', autoContinueSuppressed: true },
    } as ProviderRuntimeEvent;
    const enriched = new AdapterTurnEndingObservation().enrich(event, { message: 'Stopped by Harness', willRetry: false });
    expect(enriched.kind === 'error' && enriched.turnEnding?.reason).toBe('completed');
    expect(enriched.kind === 'error' && enriched.turnEnding?.evidence).toBe('harness_stop');
  });

  it('still reports an ordinary provider error as an error', () => {
    const event = { kind: 'error', message: 'boom', recoverable: false, turnEnding: { reason: 'unknown_error', evidence: 'provider_error' } } as ProviderRuntimeEvent;
    const enriched = new AdapterTurnEndingObservation().enrich(event, { message: 'boom', willRetry: false });
    expect(enriched.kind === 'error' && enriched.turnEnding?.reason).toBe('unknown_error');
  });
});
