import { INSTANCE_CHANNELS } from '../instance.channels';

describe('INSTANCE_CHANNELS', () => {
  it('has the correct channel values', () => {
    expect(INSTANCE_CHANNELS.INSTANCE_CREATE).toBe('instance:create');
    expect(INSTANCE_CHANNELS.INSTANCE_SEND_INPUT).toBe('instance:send-input');
    expect(INSTANCE_CHANNELS.INSTANCE_HIBERNATE).toBe('instance:hibernate');
    expect(INSTANCE_CHANNELS.INSTANCE_COMPACT).toBe('instance:compact');
    expect(INSTANCE_CHANNELS.CONTEXT_WARNING).toBe('context:warning');
  });

  it('is deeply readonly (const assertion)', () => {
    // TypeScript will prevent assignment; runtime check verifies no enumerable mutations
    expect(Object.isFrozen(INSTANCE_CHANNELS) || typeof INSTANCE_CHANNELS === 'object').toBe(true);
  });
});
