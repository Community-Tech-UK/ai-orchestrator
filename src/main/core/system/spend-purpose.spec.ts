import { describe, expect, it } from 'vitest';
import { machineSessionReasonOf } from '../../../shared/utils/machine-session';
import { resolveSpendPurpose, SPEND_PURPOSE_LABELS } from './spend-purpose';

describe('resolveSpendPurpose', () => {
  it('honours explicit tags before role and parent markers', () => {
    expect(resolveSpendPurpose({ parentId: 'parent', metadata: {
      spendPurpose: 'repo-job', planQueueRole: 'worker', pingPongReviewer: true,
    } })).toEqual({ purpose: 'repo-job' });
  });

  it('keeps a plan-queue worker with a live parent out of child spend', () => {
    expect(resolveSpendPurpose({ parentId: 'parent', metadata: { planQueueRole: 'worker' } }))
      .toEqual({ purpose: 'plan-queue', purposeDetail: 'worker' });
  });

  it('resolves machine markers, ordinary children and chats', () => {
    expect(resolveSpendPurpose({ metadata: { pingPongReviewer: true } }).purpose).toBe('review');
    expect(resolveSpendPurpose({ metadata: { automationId: 'a' } }).purpose).toBe('automation');
    expect(resolveSpendPurpose({ metadata: { spawnParentInstanceId: 'p' } }).purpose).toBe('remote-node');
    expect(resolveSpendPurpose({ parentId: 'p' }).purpose).toBe('child');
    expect(resolveSpendPurpose({}).purpose).toBe('chat');
  });

  it('rejects inherited names and model-call purposes as explicit instance purpose tags', () => {
    expect(resolveSpendPurpose({ metadata: { spendPurpose: 'toString' } }).purpose).toBe('chat');
    expect(resolveSpendPurpose({ metadata: { spendPurpose: 'helper' } }).purpose).toBe('chat');
  });

  it('agrees with the shared machine classifier for the session markers', () => {
    const sessions = [
      { metadata: { planQueueRole: 'verifier' } },
      { metadata: { automationId: 'a' } },
      { metadata: { pingPongReviewer: true } },
      { metadata: { spawnParentInstanceId: 'p' } },
      { parentId: 'p' },
      {},
    ];
    for (const session of sessions) {
      expect(resolveSpendPurpose(session).purpose !== 'chat')
        .toBe(machineSessionReasonOf(session) !== null);
    }
    expect(SPEND_PURPOSE_LABELS['remote-node']).toBe('Remote machines');
  });
});
