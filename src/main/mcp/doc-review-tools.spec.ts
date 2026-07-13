import { describe, expect, it, vi } from 'vitest';
import { createDocReviewToolDefinitions } from './doc-review-tools';
import type { DocReviewToolContext } from './doc-review-tools';
import type { DocReviewSession } from '@contracts/schemas/doc-review';

function toolMap(context: DocReviewToolContext) {
  const defs = createDocReviewToolDefinitions(context);
  return new Map(defs.map((d) => [d.name, d]));
}

const decidedSession: DocReviewSession = {
  id: 'dr_1',
  instanceId: 'inst-1',
  workspacePath: '/ws',
  title: 'Plan',
  artifactPath: '/ws/.aio-review/plan.html',
  status: 'approved',
  decisions: [{ itemId: 'a', decision: 'approve' }],
  createdAt: 1,
  decidedAt: 2,
  deliveryAttempts: [{
    id: 'dra_1', state: 'failed', mechanism: 'continuity-revive', error: 'continuity unavailable', at: 3,
  }],
  delivery: {
    status: 'failed', mechanism: 'continuity-revive', attempts: 1, lastError: 'continuity unavailable',
  },
};

describe('doc-review MCP tools', () => {
  it('exposes request_doc_review and get_doc_review_result', () => {
    const tools = toolMap({});
    expect([...tools.keys()].sort()).toEqual(['get_doc_review_result', 'request_doc_review']);
  });

  it('request_doc_review forwards to the injected creator with the caller instance', async () => {
    const requestDocReview = vi.fn(async () => ({ reviewId: 'dr_42' }));
    const tools = toolMap({ instanceId: 'inst-1', requestDocReview });
    const result = (await tools.get('request_doc_review')!.handler({
      artifact_path: '.aio-review/plan.html',
      title: 'My Plan',
      source_path: 'docs/plan.md',
    })) as { reviewId: string; status: string };

    expect(requestDocReview).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      artifactPath: '.aio-review/plan.html',
      title: 'My Plan',
      sourcePath: 'docs/plan.md',
    });
    expect(result.reviewId).toBe('dr_42');
    expect(result.status).toBe('pending');
  });

  it('request_doc_review rejects unknown arg keys', async () => {
    const tools = toolMap({ instanceId: 'inst-1', requestDocReview: async () => ({ reviewId: 'x' }) });
    await expect(
      tools.get('request_doc_review')!.handler({ artifact_path: 'a', title: 'b', bogus: 1 }),
    ).rejects.toThrow();
  });

  it('request_doc_review fails without a calling instance', async () => {
    const tools = toolMap({ requestDocReview: async () => ({ reviewId: 'x' }) });
    await expect(
      tools.get('request_doc_review')!.handler({ artifact_path: 'a', title: 'b' }),
    ).rejects.toThrow(/calling instance/);
  });

  it('request_doc_review fails when the runtime is not wired', async () => {
    const tools = toolMap({ instanceId: 'inst-1' });
    await expect(
      tools.get('request_doc_review')!.handler({ artifact_path: 'a', title: 'b' }),
    ).rejects.toThrow(/not available/);
  });

  it('get_doc_review_result reports not-found for an unknown review', async () => {
    const tools = toolMap({ getDocReviewResult: () => null });
    const result = (await tools.get('get_doc_review_result')!.handler({ review_id: 'dr_x' })) as {
      found: boolean;
    };
    expect(result.found).toBe(false);
  });

  it('get_doc_review_result returns the decided verdict', async () => {
    const tools = toolMap({ getDocReviewResult: () => decidedSession });
    const result = (await tools.get('get_doc_review_result')!.handler({ review_id: 'dr_1' })) as {
      found: boolean;
      decided: boolean;
      overall: string;
      delivery: DocReviewSession['delivery'];
      deliveryAttempts: DocReviewSession['deliveryAttempts'];
    };
    expect(result.found).toBe(true);
    expect(result.decided).toBe(true);
    expect(result.overall).toBe('approved');
    expect(result.delivery).toEqual(decidedSession.delivery);
    expect(result.deliveryAttempts).toEqual(decidedSession.deliveryAttempts);
  });
});
