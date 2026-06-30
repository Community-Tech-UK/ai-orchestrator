import { describe, expect, it } from 'vitest';
import { CampaignSpecSchema } from '../campaign.schemas';

function baseSpec() {
  return {
    id: 'campaign-1',
    title: 'Campaign',
    nodes: [
      { id: 'a', loopConfig: { initialPrompt: 'A', workspaceCwd: '/tmp' }, dependsOn: [] },
      { id: 'b', loopConfig: { initialPrompt: 'B', workspaceCwd: '/tmp' }, dependsOn: [] },
    ],
    edges: [{ from: 'a', to: 'b' }],
    policy: { onNodeNeedsReview: 'pause-campaign', maxParallel: 2 },
    createdAt: 1,
  };
}

describe('CampaignSpecSchema', () => {
  it('rejects edge predicates with invalid terminal statuses', () => {
    const result = CampaignSpecSchema.safeParse({
      ...baseSpec(),
      edges: [{ from: 'a', to: 'b', when: { type: 'is', status: 'unknown-status' } }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects interrupted edge predicates because campaign nodes cannot reach that status', () => {
    const result = CampaignSpecSchema.safeParse({
      ...baseSpec(),
      edges: [{ from: 'a', to: 'b', when: { type: 'is', status: 'interrupted' } }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects provider-limit edge predicates because provider-limit nodes are resumable', () => {
    const result = CampaignSpecSchema.safeParse({
      ...baseSpec(),
      edges: [{ from: 'a', to: 'b', when: { type: 'is', status: 'provider-limit' } }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects edge predicates with an empty status list', () => {
    const result = CampaignSpecSchema.safeParse({
      ...baseSpec(),
      edges: [{ from: 'a', to: 'b', when: { type: 'in', statuses: [] } }],
    });

    expect(result.success).toBe(false);
  });
});
