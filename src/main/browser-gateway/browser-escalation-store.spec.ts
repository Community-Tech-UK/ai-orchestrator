import { describe, expect, it, vi } from 'vitest';
import {
  BrowserEscalationError,
  BrowserEscalationService,
  InMemoryEscalationRecordStore,
  type BrowserEscalation,
} from './browser-escalation-store';

function makeService(overrides: { now?: () => number; notify?: (e: BrowserEscalation) => void } = {}) {
  let clock = 1_000;
  const store = new InMemoryEscalationRecordStore();
  const service = new BrowserEscalationService({
    store,
    now: overrides.now ?? (() => clock),
    notify: overrides.notify,
  });
  return {
    service,
    store,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('BrowserEscalationService.raise', () => {
  it('returns parked:true and stores a pending escalation with the given fields', () => {
    const { service, store } = makeService();

    const result = service.raise({
      campaignId: 'camp-1',
      profileId: 'profile-1',
      targetId: 'target-1',
      kind: 'captcha',
      reason: 'Cloudflare challenge could not be solved',
      url: 'https://portal.example.gov.uk/login',
      screenshotArtifactId: 'artifact-1',
    });

    expect(result.parked).toBe(true);
    expect(result.escalationId).toBeTruthy();

    const stored = store.get(result.escalationId);
    expect(stored).toMatchObject({
      id: result.escalationId,
      campaignId: 'camp-1',
      profileId: 'profile-1',
      targetId: 'target-1',
      kind: 'captcha',
      reason: 'Cloudflare challenge could not be solved',
      url: 'https://portal.example.gov.uk/login',
      screenshotArtifactId: 'artifact-1',
      status: 'pending',
      createdAt: 1_000,
    });
    expect(stored?.resolvedAt).toBeUndefined();
  });

  it('assigns distinct ids to successive escalations via the default counter', () => {
    const { service } = makeService();
    const first = service.raise({ profileId: 'p1', kind: 'payment', reason: 'checkout form unfamiliar' });
    const second = service.raise({ profileId: 'p1', kind: 'payment', reason: 'checkout form unfamiliar' });
    expect(first.escalationId).not.toBe(second.escalationId);
  });

  it('supports an injected idFactory for fully deterministic tests', () => {
    const store = new InMemoryEscalationRecordStore();
    let n = 0;
    const service = new BrowserEscalationService({
      store,
      now: () => 5_000,
      idFactory: () => `fixed-${++n}`,
    });
    const result = service.raise({ profileId: 'p1', kind: 'unknown_challenge', reason: 'unrecognised UI' });
    expect(result.escalationId).toBe('fixed-1');
  });

  it('invokes the notify hook synchronously with the created escalation', () => {
    const notify = vi.fn();
    const { service } = makeService({ notify });

    const result = service.raise({
      profileId: 'p1',
      kind: 'two_factor_unavailable',
      reason: 'no SMS code received',
    });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ id: result.escalationId, status: 'pending' }));
  });

  it('does not throw when no notify hook is configured', () => {
    const { service } = makeService();
    expect(() =>
      service.raise({ profileId: 'p1', kind: 'legal_declaration', reason: 'unfamiliar terms clause' }),
    ).not.toThrow();
  });
});

describe('BrowserEscalationService.list', () => {
  it('filters by campaignId', () => {
    const { service } = makeService();
    service.raise({ campaignId: 'camp-a', profileId: 'p1', kind: 'captcha', reason: 'r' });
    service.raise({ campaignId: 'camp-b', profileId: 'p1', kind: 'captcha', reason: 'r' });

    const filtered = service.list({ campaignId: 'camp-a' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.campaignId).toBe('camp-a');
  });

  it('filters by profileId', () => {
    const { service } = makeService();
    service.raise({ profileId: 'profile-x', kind: 'captcha', reason: 'r' });
    service.raise({ profileId: 'profile-y', kind: 'captcha', reason: 'r' });

    const filtered = service.list({ profileId: 'profile-y' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.profileId).toBe('profile-y');
  });

  it('filters by status', () => {
    const { service } = makeService();
    const raised = service.raise({ profileId: 'p1', kind: 'relogin_failed', reason: 'login loop' });
    service.raise({ profileId: 'p1', kind: 'relogin_failed', reason: 'login loop' });
    service.resolve(raised.escalationId);

    expect(service.list({ status: 'resolved' })).toHaveLength(1);
    expect(service.list({ status: 'pending' })).toHaveLength(1);
  });

  it('combines filters and returns everything when no filter is given', () => {
    const { service } = makeService();
    service.raise({ campaignId: 'camp-a', profileId: 'p1', kind: 'verify_diff', reason: 'r' });
    service.raise({ campaignId: 'camp-a', profileId: 'p2', kind: 'verify_diff', reason: 'r' });
    service.raise({ campaignId: 'camp-b', profileId: 'p1', kind: 'verify_diff', reason: 'r' });

    expect(service.list()).toHaveLength(3);
    expect(service.list({ campaignId: 'camp-a', profileId: 'p1' })).toHaveLength(1);
  });
});

describe('BrowserEscalationService.resolve / skip', () => {
  it('resolve transitions status, stamps resolvedAt and stores the note', () => {
    let clock = 1_000;
    const store = new InMemoryEscalationRecordStore();
    const service = new BrowserEscalationService({ store, now: () => clock });
    const raised = service.raise({ profileId: 'p1', kind: 'captcha', reason: 'blocked' });

    clock = 2_500;
    const resolved = service.resolve(raised.escalationId, 'Solved manually, retried fine');

    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedAt).toBe(2_500);
    expect(resolved.resolutionNote).toBe('Solved manually, retried fine');
    expect(store.get(raised.escalationId)?.status).toBe('resolved');
  });

  it('resolve works without a note', () => {
    const { service } = makeService();
    const raised = service.raise({ profileId: 'p1', kind: 'payment', reason: 'unfamiliar checkout' });
    const resolved = service.resolve(raised.escalationId);
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolutionNote).toBeUndefined();
  });

  it('skip transitions status, stamps resolvedAt and stores the note', () => {
    const { service } = makeService();
    const raised = service.raise({ profileId: 'p1', kind: 'unknown_challenge', reason: 'odd modal' });
    const skipped = service.skip(raised.escalationId, 'Not worth pursuing, target deprecated');

    expect(skipped.status).toBe('skipped');
    expect(skipped.resolutionNote).toBe('Not worth pursuing, target deprecated');
    expect(skipped.resolvedAt).toBeDefined();
  });

  it('throws a typed error when resolving an unknown id', () => {
    const { service } = makeService();
    expect(() => service.resolve('does-not-exist')).toThrow(BrowserEscalationError);
    try {
      service.resolve('does-not-exist');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserEscalationError);
      expect((error as BrowserEscalationError).code).toBe('escalation_not_found');
    }
  });

  it('throws a typed error when skipping an unknown id', () => {
    const { service } = makeService();
    expect(() => service.skip('does-not-exist')).toThrow(BrowserEscalationError);
  });

  it('throws when resolving an already-resolved escalation', () => {
    const { service } = makeService();
    const raised = service.raise({ profileId: 'p1', kind: 'captcha', reason: 'r' });
    service.resolve(raised.escalationId);
    expect(() => service.resolve(raised.escalationId)).toThrow(
      expect.objectContaining({ code: 'already_resolved' }),
    );
  });

  it('throws when skipping an already-skipped escalation', () => {
    const { service } = makeService();
    const raised = service.raise({ profileId: 'p1', kind: 'captcha', reason: 'r' });
    service.skip(raised.escalationId);
    expect(() => service.skip(raised.escalationId)).toThrow(
      expect.objectContaining({ code: 'already_skipped' }),
    );
  });
});

describe('BrowserEscalationService.pending', () => {
  it('counts only pending escalations across all campaigns by default', () => {
    const { service } = makeService();
    const a = service.raise({ campaignId: 'camp-a', profileId: 'p1', kind: 'captcha', reason: 'r' });
    service.raise({ campaignId: 'camp-b', profileId: 'p1', kind: 'captcha', reason: 'r' });
    service.resolve(a.escalationId);

    expect(service.pending()).toBe(1);
  });

  it('scopes the count to a single campaign when given', () => {
    const { service } = makeService();
    service.raise({ campaignId: 'camp-a', profileId: 'p1', kind: 'captcha', reason: 'r' });
    service.raise({ campaignId: 'camp-a', profileId: 'p2', kind: 'captcha', reason: 'r' });
    service.raise({ campaignId: 'camp-b', profileId: 'p1', kind: 'captcha', reason: 'r' });

    expect(service.pending('camp-a')).toBe(2);
    expect(service.pending('camp-b')).toBe(1);
    expect(service.pending('camp-c')).toBe(0);
  });

  it('returns 0 for a brand new service', () => {
    const { service } = makeService();
    expect(service.pending()).toBe(0);
  });
});

describe('InMemoryEscalationRecordStore', () => {
  it('returns defensive copies so external mutation cannot corrupt stored state', () => {
    const store = new InMemoryEscalationRecordStore();
    const record: BrowserEscalation = {
      id: 'e1',
      profileId: 'p1',
      kind: 'captcha',
      reason: 'r',
      status: 'pending',
      createdAt: 1,
    };
    store.insert(record);

    const fetched = store.get('e1');
    if (fetched) {
      fetched.reason = 'tampered';
    }
    expect(store.get('e1')?.reason).toBe('r');
  });

  it('update is a no-op for an id that was never inserted', () => {
    const store = new InMemoryEscalationRecordStore();
    store.update({
      id: 'ghost',
      profileId: 'p1',
      kind: 'captcha',
      reason: 'r',
      status: 'resolved',
      createdAt: 1,
    });
    expect(store.get('ghost')).toBeUndefined();
  });
});
