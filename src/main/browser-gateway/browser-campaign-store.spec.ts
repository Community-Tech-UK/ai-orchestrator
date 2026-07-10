import { describe, expect, it, vi } from 'vitest';
import {
  BrowserCampaignError,
  BrowserCampaignService,
  InMemoryBrowserCampaignStore,
  type BrowserCampaignBudget,
  type CreateBrowserCampaignInput,
} from './browser-campaign-store';

const HOUR = 60 * 60 * 1000;

function budget(overrides: Partial<BrowserCampaignBudget> = {}): BrowserCampaignBudget {
  return {
    maxActions: 100,
    maxSubmits: 50,
    maxNewAccounts: 5,
    maxUploads: 10,
    maxDurationMs: 8 * HOUR,
    ...overrides,
  };
}

function input(overrides: Partial<CreateBrowserCampaignInput> = {}): CreateBrowserCampaignInput {
  return {
    label: 'Overnight invoice run',
    profileId: 'profile-1',
    allowedOrigins: ['https://portal.example.gov.uk'],
    allowedActionClasses: ['click', 'type', 'navigate'],
    budget: budget(),
    ...overrides,
  };
}

function makeService(opts: { start?: number; idFactory?: () => string } = {}) {
  const store = new InMemoryBrowserCampaignStore();
  let clock = opts.start ?? 1_000_000;
  const onStateChange = vi.fn();
  const service = new BrowserCampaignService({
    store,
    now: () => clock,
    idFactory: opts.idFactory ?? (() => 'campaign-1'),
    onStateChange,
  });
  return {
    service,
    store,
    onStateChange,
    advance: (ms: number) => {
      clock += ms;
    },
    setClock: (value: number) => {
      clock = value;
    },
  };
}

describe('BrowserCampaignService.create', () => {
  it('creates an active campaign with zeroed counters and a hashed-approval empty list', () => {
    const { service } = makeService();
    const campaign = service.create(input());

    expect(campaign.id).toBe('campaign-1');
    expect(campaign.status).toBe('active');
    expect(campaign.approvedBy).toBe('user');
    expect(campaign.approvedDeclarationHashes).toEqual([]);
    expect(campaign.expiresAt).toBe(campaign.createdAt + budget().maxDurationMs);
    expect(service.getCounters(campaign.id)).toEqual({
      actions: 0,
      submits: 0,
      newAccounts: 0,
      uploads: 0,
    });
  });

  it('fires onStateChange when a campaign is created', () => {
    const { service, onStateChange } = makeService();
    const campaign = service.create(input());
    expect(onStateChange).toHaveBeenCalledWith(expect.objectContaining({ id: campaign.id }));
  });

  it.each(['credential', 'payment', 'destructive'])(
    "rejects action class '%s' at create",
    (blockedClass) => {
      const { service } = makeService();
      expect(() =>
        service.create(input({ allowedActionClasses: ['click', blockedClass] })),
      ).toThrow(BrowserCampaignError);
      try {
        service.create(input({ allowedActionClasses: [blockedClass] }));
        expect.unreachable('expected create to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(BrowserCampaignError);
        expect((error as BrowserCampaignError).code).toBe('blocked_action_class');
      }
    },
  );

  it('rejects an expiry (via maxDurationMs) greater than 14 hours', () => {
    const { service } = makeService();
    expect(() =>
      service.create(input({ budget: budget({ maxDurationMs: 14 * HOUR + 1 }) })),
    ).toThrow(BrowserCampaignError);
    try {
      service.create(input({ budget: budget({ maxDurationMs: 15 * HOUR }) }));
      expect.unreachable('expected create to throw');
    } catch (error) {
      expect((error as BrowserCampaignError).code).toBe('expiry_too_long');
    }
  });

  it('accepts an expiry of exactly 14 hours', () => {
    const { service } = makeService();
    const campaign = service.create(input({ budget: budget({ maxDurationMs: 14 * HOUR }) }));
    expect(campaign.expiresAt).toBe(campaign.createdAt + 14 * HOUR);
  });
});

describe('BrowserCampaignService.get / list', () => {
  it('returns undefined for an unknown id', () => {
    const { service } = makeService();
    expect(service.get('nope')).toBeUndefined();
  });

  it('lists campaigns and filters by status', () => {
    const { service } = makeService({ idFactory: idSequence() });
    const a = service.create(input({ label: 'A' }));
    const b = service.create(input({ label: 'B' }));
    service.pause(b.id);

    expect(service.list().map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(service.list({ status: 'active' }).map((c) => c.id)).toEqual([a.id]);
    expect(service.list({ status: 'paused' }).map((c) => c.id)).toEqual([b.id]);
  });

  it('reports elapsed active campaigns as expired from get and list', () => {
    const { service, advance, onStateChange } = makeService({ idFactory: idSequence() });
    const expired = service.create(
      input({ label: 'Expired', budget: budget({ maxDurationMs: HOUR }) }),
    );
    const paused = service.create(
      input({ label: 'Paused', budget: budget({ maxDurationMs: HOUR }) }),
    );
    service.pause(paused.id);
    onStateChange.mockClear();
    advance(HOUR + 1);

    expect(service.get(expired.id)?.status).toBe('expired');
    expect(service.get(paused.id)?.status).toBe('paused');
    expect(service.list({ status: 'active' })).toEqual([]);
    expect(service.list({ status: 'expired' }).map((campaign) => campaign.id)).toEqual([
      expired.id,
    ]);
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: expired.id, status: 'expired' }),
    );
  });
});

describe('BrowserCampaignService.recordAction', () => {
  it('increments the action counter and does not pause under budget', () => {
    const { service } = makeService();
    const campaign = service.create(input({ budget: budget({ maxActions: 5 }) }));

    const result = service.recordAction(campaign.id, 'action');

    expect(result).toEqual({ paused: false });
    expect(service.getCounters(campaign.id)?.actions).toBe(1);
    expect(service.get(campaign.id)?.status).toBe('active');
  });

  it('pauses the campaign once the matching budget is exhausted', () => {
    const { service, onStateChange } = makeService();
    const campaign = service.create(input({ budget: budget({ maxActions: 1 }) }));

    const first = service.recordAction(campaign.id, 'action');
    expect(first.paused).toBe(true);
    expect(first.reason).toMatch(/action/);
    expect(service.getCounters(campaign.id)?.actions).toBe(1);
    expect(service.get(campaign.id)?.status).toBe('paused');
    expect(onStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: campaign.id, status: 'paused' }),
    );
  });

  it('pauses immediately when the matching budget reaches its limit', () => {
    const { service } = makeService();
    const campaign = service.create(input({ budget: budget({ maxActions: 2 }) }));

    expect(service.recordAction(campaign.id, 'action')).toEqual({ paused: false });
    const second = service.recordAction(campaign.id, 'action');

    expect(second.paused).toBe(true);
    expect(second.reason).toMatch(/action/);
    expect(service.getCounters(campaign.id)?.actions).toBe(2);
    expect(service.get(campaign.id)?.status).toBe('paused');
    expect(service.canProceed(campaign.id).ok).toBe(false);
  });

  it('counts a submit as both a submit and an action, and pauses on whichever budget trips first', () => {
    const { service } = makeService();
    const campaign = service.create(
      input({ budget: budget({ maxActions: 100, maxSubmits: 2 }) }),
    );

    const first = service.recordAction(campaign.id, 'submit');
    expect(first).toEqual({ paused: false });
    expect(service.getCounters(campaign.id)).toMatchObject({ actions: 1, submits: 1 });

    const second = service.recordAction(campaign.id, 'submit');
    expect(second.paused).toBe(true);
    expect(second.reason).toMatch(/submit/);
    expect(service.getCounters(campaign.id)).toMatchObject({ actions: 2, submits: 2 });
  });

  it('increments newAccount and upload counters independently of actions', () => {
    const { service } = makeService();
    const campaign = service.create(input());

    service.recordAction(campaign.id, 'newAccount');
    service.recordAction(campaign.id, 'upload');

    expect(service.getCounters(campaign.id)).toMatchObject({
      actions: 0,
      submits: 0,
      newAccounts: 1,
      uploads: 1,
    });
  });

  it('throws not_found for an unknown campaign id', () => {
    const { service } = makeService();
    expect(() => service.recordAction('missing', 'action')).toThrow(BrowserCampaignError);
    try {
      service.recordAction('missing', 'action');
      expect.unreachable('expected to throw');
    } catch (error) {
      expect((error as BrowserCampaignError).code).toBe('not_found');
    }
  });
});

describe('BrowserCampaignService.canProceed', () => {
  it('is ok for a fresh active campaign', () => {
    const { service } = makeService();
    const campaign = service.create(input());
    expect(service.canProceed(campaign.id)).toEqual({ ok: true });
  });

  it('is false and does not auto-transition when the campaign is paused', () => {
    const { service } = makeService();
    const campaign = service.create(input());
    service.pause(campaign.id);

    const result = service.canProceed(campaign.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/paused/);
    expect(service.get(campaign.id)?.status).toBe('paused');
  });

  it('auto-transitions an active campaign to expired once past its expiry', () => {
    const { service, advance } = makeService();
    const campaign = service.create(input({ budget: budget({ maxDurationMs: HOUR }) }));
    advance(HOUR + 1);

    const result = service.canProceed(campaign.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/expired/);
    expect(service.get(campaign.id)?.status).toBe('expired');
  });

  it('returns false when a budget is already exhausted while status is still active', () => {
    const { service, store } = makeService();
    const campaign = service.create(input({ budget: budget({ maxActions: 1 }) }));
    // Simulate a counter reaching the budget ceiling without going through
    // recordAction's own auto-pause, to exercise canProceed's own budget check.
    store.putCounters(campaign.id, { actions: 1, submits: 0, newAccounts: 0, uploads: 0 });

    const result = service.canProceed(campaign.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Budget exhausted for 'action'/);
    expect(service.get(campaign.id)?.status).toBe('active');
  });

  it('accepts an explicit now override', () => {
    const { service } = makeService({ start: 0 });
    const campaign = service.create(input({ budget: budget({ maxDurationMs: HOUR }) }));
    expect(service.canProceed(campaign.id, HOUR - 1).ok).toBe(true);
    expect(service.canProceed(campaign.id, HOUR + 1).ok).toBe(false);
  });
});

describe('BrowserCampaignService state machine', () => {
  it('pause -> resume returns to active', () => {
    const { service } = makeService();
    const campaign = service.create(input());
    service.pause(campaign.id);
    expect(service.get(campaign.id)?.status).toBe('paused');
    const resumed = service.resume(campaign.id);
    expect(resumed.status).toBe('active');
  });

  it('rejects pausing a non-active campaign', () => {
    const { service } = makeService();
    const campaign = service.create(input());
    service.kill(campaign.id);
    expect(() => service.pause(campaign.id)).toThrow(BrowserCampaignError);
  });

  it('rejects resuming a campaign that is not paused', () => {
    const { service } = makeService();
    const campaign = service.create(input());
    expect(() => service.resume(campaign.id)).toThrow(BrowserCampaignError);
  });

  it('rejects resuming an expired campaign', () => {
    const { service, advance } = makeService();
    const campaign = service.create(input({ budget: budget({ maxDurationMs: HOUR }) }));
    service.pause(campaign.id);
    advance(HOUR + 1);
    expect(() => service.resume(campaign.id)).toThrow(BrowserCampaignError);
  });

  it('rejects resuming a campaign with an exhausted budget', () => {
    const { service } = makeService();
    const campaign = service.create(input({ budget: budget({ maxActions: 1 }) }));
    service.recordAction(campaign.id, 'action'); // 1/1, now paused
    expect(service.get(campaign.id)?.status).toBe('paused');
    expect(() => service.resume(campaign.id)).toThrow(BrowserCampaignError);
  });

  it('kill is terminal and works from active or paused', () => {
    const { service } = makeService({ idFactory: idSequence() });
    const active = service.create(input());
    const killed = service.kill(active.id);
    expect(killed.status).toBe('killed');

    const paused = service.create(input());
    service.pause(paused.id);
    expect(service.kill(paused.id).status).toBe('killed');
  });

  it('rejects killing an already-terminal campaign', () => {
    const { service } = makeService();
    const campaign = service.create(input());
    service.kill(campaign.id);
    expect(() => service.kill(campaign.id)).toThrow(BrowserCampaignError);
  });

  it('complete is terminal and rejects being called twice', () => {
    const { service } = makeService();
    const campaign = service.create(input());
    const completed = service.complete(campaign.id);
    expect(completed.status).toBe('completed');
    expect(() => service.complete(campaign.id)).toThrow(BrowserCampaignError);
  });

  it('rejects completing an already-killed campaign', () => {
    const { service } = makeService();
    const campaign = service.create(input());
    service.kill(campaign.id);
    expect(() => service.complete(campaign.id)).toThrow(BrowserCampaignError);
  });
});

describe('BrowserCampaignService declaration hashes', () => {
  it('approves a hash and reports it as approved thereafter', () => {
    const { service } = makeService();
    const campaign = service.create(input());
    expect(service.isDeclarationApproved(campaign.id, 'hash-1')).toBe(false);

    service.approveDeclarationHash(campaign.id, 'hash-1');

    expect(service.isDeclarationApproved(campaign.id, 'hash-1')).toBe(true);
    expect(service.get(campaign.id)?.approvedDeclarationHashes).toEqual(['hash-1']);
  });

  it('is idempotent for the same hash approved twice', () => {
    const { service, onStateChange } = makeService();
    const campaign = service.create(input());
    service.approveDeclarationHash(campaign.id, 'hash-1');
    onStateChange.mockClear();
    service.approveDeclarationHash(campaign.id, 'hash-1');

    expect(service.get(campaign.id)?.approvedDeclarationHashes).toEqual(['hash-1']);
    expect(onStateChange).not.toHaveBeenCalled();
  });
});

function idSequence(): () => string {
  let n = 0;
  return () => `campaign-${++n}`;
}
