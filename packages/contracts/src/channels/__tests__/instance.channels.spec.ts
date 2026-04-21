import { INSTANCE_CHANNELS } from '../instance.channels';

describe('INSTANCE_CHANNELS', () => {
  it('has the correct channel values', () => {
    expect(INSTANCE_CHANNELS.INSTANCE_CREATE).toBe('instance:create');
    expect(INSTANCE_CHANNELS.INSTANCE_SEND_INPUT).toBe('instance:send-input');
    expect(INSTANCE_CHANNELS.INSTANCE_HIBERNATE).toBe('instance:hibernate');
    expect(INSTANCE_CHANNELS.INSTANCE_COMPACT).toBe('instance:compact');
    expect(INSTANCE_CHANNELS.CONTEXT_WARNING).toBe('context:warning');
  });

  it('uses unique string channel names within the instance domain', () => {
    const values = Object.values(INSTANCE_CHANNELS);

    expect(new Set(values).size).toBe(values.length);
    expect(values.every((value) => /^[a-z-]+:[a-z-]+$/.test(value))).toBe(true);
  });
});
