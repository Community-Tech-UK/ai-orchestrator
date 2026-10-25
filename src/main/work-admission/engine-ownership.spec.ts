import { afterEach, describe, expect, it } from 'vitest';
import { ownedByEngine } from './engine-ownership';
import { _resetAdapterLoansForTesting, beginAdapterLoan } from '../instance/lifecycle/adapter-loan-registry';

afterEach(() => _resetAdapterLoansForTesting());
describe('engine ownership', () => {
  it.each(['planQueueRole', 'planQueueRunId', 'pingPongReviewer', 'automationRunId', 'repoJobId', 'loopRunId', 'campaignId'])('recognises %s even on a child', marker => {
    expect(ownedByEngine({ id: 'worker', parentId: 'chat', metadata: { [marker]: 'engine' } })).toBe(true);
  });
  it('does not classify ordinary children as engine sessions', () => {
    expect(ownedByEngine({ id: 'helper', parentId: 'chat' })).toBe(false);
  });
  it('recognises a chat whose adapter is currently borrowed by a loop', () => {
    beginAdapterLoan('chat', 'loop');
    expect(ownedByEngine({ id: 'chat' })).toBe(true);
  });
});
