import { describe, expect, it } from 'vitest';
import { accountFailoverNote } from './account-failover-notes';

describe('accountFailoverNote', () => {
  it('says nothing for a switch or a duplicate report of a re-sent turn', () => {
    expect(accountFailoverNote({ outcome: 'switched', toProfileId: 'max-b', continuity: 'replay' }, false)).toBeNull();
    expect(accountFailoverNote({ outcome: 'already-moved', toProfileId: 'max-b', turnNotSent: false }, false)).toBeNull();
  });

  it('asks the user to resend a turn caught by a concurrent switch', () => {
    expect(accountFailoverNote({ outcome: 'already-moved', toProfileId: 'max-b', turnNotSent: true }, false)?.metadata)
      .toEqual({ accountFailover: true, accountFailoverOutcome: 'turn-not-sent' });
  });

  it('distinguishes a park from a failed or impossible switch', () => {
    const notSwitched = { outcome: 'not-switched' as const, reason: 'no-candidate' as const, considered: [] };
    expect(accountFailoverNote(notSwitched, true)?.content).toMatch(/parked/);
    expect(accountFailoverNote(notSwitched, false)?.content).toMatch(/no other account/);
    expect(accountFailoverNote({ ...notSwitched, reason: 'apply-failed' }, false)?.content).toMatch(/could not be moved/);
    expect(accountFailoverNote({ ...notSwitched, reason: 'busy' }, true)?.content).not.toMatch(/No other account/);
  });

  it('never leaves an offer that arrived mid-switch without a note', () => {
    const offered = { outcome: 'offered' as const, toProfileId: 'max-b' };
    expect(accountFailoverNote(offered, true)?.content).toMatch(/resumes when the limit lifts/);
    expect(accountFailoverNote(offered, false)?.content).toMatch(/send your message again/);
  });
});
