import { afterEach, describe, expect, it, vi } from 'vitest';
import { CampaignCoordinator } from './campaign-coordinator';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';

describe('campaign work admission', () => {
  afterEach(() => WorkAdmission._resetForTesting());
  it('keeps its first node pending during hold and starts it on release', async () => {
    const admission = getWorkAdmission(); admission.setGlobalPhase('holding');
    const coordinator = new CampaignCoordinator();
    const start = vi.fn(async () => ({ id: 'loop' }));
    coordinator.setLoopStarterForTesting(start);
    const run = await coordinator.startCampaign({ id: 'campaign', title: 'Campaign', nodes: [{ id: 'first',
      loopConfig: { initialPrompt: 'Run checks', workspaceCwd: '/tmp', completion: { verifyCommand: 'npm test' } }, dependsOn: [] }],
      edges: [], policy: { onNodeNeedsReview: 'pause-campaign', maxParallel: 1 }, createdAt: 1 });
    expect(run.nodeRuns.get('first')?.status).toBe('pending');
    expect(start).not.toHaveBeenCalled();
    admission.setGlobalPhase('none');
    await vi.waitFor(() => expect(run.nodeRuns.get('first')?.status).toBe('running'));
    expect(start).toHaveBeenCalledTimes(1);
  });
});
