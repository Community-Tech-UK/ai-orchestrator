import { ORCHESTRATION_CHANNELS } from '../orchestration.channels';

describe('ORCHESTRATION_CHANNELS', () => {
  it('has orchestration activity channel', () => {
    expect(ORCHESTRATION_CHANNELS.ORCHESTRATION_ACTIVITY).toBe('orchestration:activity');
  });

  it('has verification channels', () => {
    expect(ORCHESTRATION_CHANNELS.VERIFY_START).toBe('verify:start');
    expect(ORCHESTRATION_CHANNELS.VERIFICATION_COMPLETE).toBe('verification:complete');
  });

  it('has debate channels', () => {
    expect(ORCHESTRATION_CHANNELS.DEBATE_START).toBe('debate:start');
    expect(ORCHESTRATION_CHANNELS.DEBATE_EVENT).toBe('debate:event');
  });

  it('has consensus channels', () => {
    expect(ORCHESTRATION_CHANNELS.CONSENSUS_QUERY).toBe('consensus:query');
  });

  it('has workflow channels', () => {
    expect(ORCHESTRATION_CHANNELS.WORKFLOW_START).toBe('workflow:start');
    expect(ORCHESTRATION_CHANNELS.WORKFLOW_GATE_PENDING).toBe('workflow:gate-pending');
  });

  it('has review agent channels', () => {
    expect(ORCHESTRATION_CHANNELS.REVIEW_START_SESSION).toBe('review:start-session');
  });

  it('has hooks channels', () => {
    expect(ORCHESTRATION_CHANNELS.HOOKS_LIST).toBe('hooks:list');
    expect(ORCHESTRATION_CHANNELS.HOOKS_TRIGGERED).toBe('hooks:triggered');
  });

  it('has skills channels', () => {
    expect(ORCHESTRATION_CHANNELS.SKILLS_DISCOVER).toBe('skills:discover');
    expect(ORCHESTRATION_CHANNELS.SKILLS_GET_MEMORY).toBe('skills:get-memory');
  });
});
