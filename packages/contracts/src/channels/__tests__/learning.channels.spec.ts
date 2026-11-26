import { LEARNING_CHANNELS } from '../learning.channels';

describe('LEARNING_CHANNELS', () => {
  it('has self-improvement channels', () => {
    expect(LEARNING_CHANNELS.LEARNING_RECORD_OUTCOME).toBe('learning:record-outcome');
    expect(LEARNING_CHANNELS.LEARNING_ENHANCE_PROMPT).toBe('learning:enhance-prompt');
  });

  it('has specialist channels', () => {
    expect(LEARNING_CHANNELS.SPECIALIST_LIST).toBe('specialist:list');
    expect(LEARNING_CHANNELS.SPECIALIST_INSTANCE_CREATED).toBe('specialist:instance-created');
  });

  it('has A/B testing channels', () => {
    expect(LEARNING_CHANNELS.AB_CREATE_EXPERIMENT).toBe('ab:create-experiment');
    expect(LEARNING_CHANNELS.AB_GET_WINNER).toBe('ab:get-winner');
  });
});
