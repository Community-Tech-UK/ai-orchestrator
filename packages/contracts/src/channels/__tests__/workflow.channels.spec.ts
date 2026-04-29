import { WORKFLOW_CHANNELS } from '../workflow.channels';

describe('WORKFLOW_CHANNELS', () => {
  it('has correct workflow values', () => {
    expect(WORKFLOW_CHANNELS.WORKFLOW_CAN_TRANSITION).toBe('workflow:can-transition');
    expect(WORKFLOW_CHANNELS.WORKFLOW_NL_SUGGEST).toBe('workflow:nl-suggest');
  });
});
