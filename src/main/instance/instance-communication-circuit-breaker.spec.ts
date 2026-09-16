import { describe, expect, it } from 'vitest';
import { InstanceCommunicationCircuitBreakers } from './instance-communication-circuit-breaker';
import { CIRCUIT_BREAKER_CONFIG } from './instance-communication.constants';

describe('InstanceCommunicationCircuitBreakers', () => {
  it('trips after consecutive empty responses and recovers after cooldown', () => {
    const breakers = new InstanceCommunicationCircuitBreakers();
    const start = 1_000;

    expect(breakers.recordResponse('inst-1', false, start)).toBe(true);
    expect(breakers.recordResponse('inst-1', false, start + 10)).toBe(true);
    expect(breakers.recordResponse('inst-1', false, start + 20)).toBe(false);
    expect(breakers.isTripped('inst-1')).toBe(true);

    expect(breakers.recordResponse('inst-1', true, start + 21)).toBe(false);

    expect(breakers.recordResponse(
      'inst-1',
      true,
      start + 21 + CIRCUIT_BREAKER_CONFIG.cooldownMs,
    )).toBe(true);
    expect(breakers.isTripped('inst-1')).toBe(false);
  });

  it('resets empty counters on tool activity and manual reset', () => {
    const breakers = new InstanceCommunicationCircuitBreakers();
    breakers.recordResponse('inst-2', false, 1);
    breakers.noteToolActivity('inst-2');
    expect(breakers.get('inst-2').consecutiveEmptyResponses).toBe(0);

    breakers.recordResponse('inst-2', false, 2);
    breakers.recordResponse('inst-2', false, 3);
    breakers.recordResponse('inst-2', false, 4);
    expect(breakers.isTripped('inst-2')).toBe(true);
    breakers.reset('inst-2');
    expect(breakers.isTripped('inst-2')).toBe(false);
  });
});
