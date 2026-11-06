import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceProviderLimitHandler, ASSUMED_ACCOUNT_LIMIT_MS, type InstanceProviderLimitHandlerDeps } from './instance-provider-limit-handler';
import { collectUsageLimitHandling, dispatchRateLimitTelemetry } from '../cli/usage-limit-dispatch';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('../providers/account-pool/provider-account-store', () => ({
  getProviderAccountStore: () => ({ getProfile: (_provider: string, id: string) => (id === 'work-1' ? { label: 'Work' } : null) }),
}));

const NOON = new Date(2026, 9, 20, 12);
const THURSDAY_NIGHT = new Date(2026, 9, 22, 23).getTime();

interface Notice { instanceId: string; content: string; metadata: Record<string, unknown> }

function setup(overrides: Partial<InstanceProviderLimitHandlerDeps> = {}, options: { account?: string; autoResume?: boolean; knownLimit?: { source: string; resumeAt: number } } = {}) {
  const notices: Notice[] = [];
  const handler = new InstanceProviderLimitHandler();
  handler.configure({
    isEnabled: () => options.autoResume !== false,
    setWaitReason: () => undefined,
    resendInput: () => undefined,
    getQuotaSnapshot: () => null,
    getWorkspaceCwd: () => '/tmp/workspace',
    getProviderModel: () => ({ provider: 'claude', model: null, accountProfileId: options.account ?? 'legacy' }),
    emitSystemMessage: (instanceId, content, metadata) => { notices.push({ instanceId, content, metadata }); },
    scheduleResume: () => () => undefined,
    providerLimitLedger: {
      record: vi.fn(),
      getActive: vi.fn(() => options.knownLimit ?? null),
      clearActive: vi.fn(() => 0),
    } as unknown as InstanceProviderLimitHandlerDeps['providerLimitLedger'],
    ...overrides,
  });
  return { handler, notices };
}

const held = (extra: Record<string, unknown> = {}) => ({
  instanceId: 'i1', provider: 'claude' as const, model: null, reason: 'Known active provider limit; holding the turn until the provider reset time',
  resumePrompt: null as string | null, ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOON);
});
afterEach(() => vi.useRealTimers());

describe('the limit handler\'s own note (no adapter event in progress)', () => {
  it('names the account and the reset day for a message held before it was sent, and says what happens to the message', () => {
    const { handler, notices } = setup({}, { account: 'work-1', knownLimit: { source: 'provider-limit-signal', resumeAt: THURSDAY_NIGHT } });
    expect(handler.maybeParkKnown(held({ resumePrompt: 'send this', accountProfileId: 'work-1' }))).toBe('parked');

    expect(notices).toHaveLength(1);
    const [{ content, metadata }] = notices;
    expect(content).toContain('Your Work Claude account has used its current allowance.');
    expect(content).toContain('It resets on Thursday 22 October at 23:00.');
    expect(content).toContain('Your message will be sent again automatically once the allowance resets.');
    expect(content).not.toMatch(/Provider limit reached|quota window|parked/i);
    expect(metadata).toMatchObject({ providerLimitParked: true });
    expect((metadata['errorPresentation'] as { category: string }).category).toBe('quota');
  });

  it('tells the user a held message was not sent when nothing will send it again', () => {
    const { handler, notices } = setup({}, { autoResume: false, knownLimit: { source: 'provider-limit-signal', resumeAt: THURSDAY_NIGHT } });
    handler.maybeParkKnown(held({ resumePrompt: 'send this' }));
    expect(notices[0].content).toContain('Your message was not sent. Press Resume, or send it again once the allowance resets.');
  });

  it('says nothing is promised when there is no message to send and no automatic resume', () => {
    const { handler, notices } = setup({}, { autoResume: false, knownLimit: { source: 'provider-limit-signal', resumeAt: THURSDAY_NIGHT } });
    handler.maybeParkKnown(held());
    expect(notices[0].content).toContain('This session is on hold until the allowance resets.');
  });

  it('does not name the default account', () => {
    const { handler, notices } = setup({}, { account: 'legacy', knownLimit: { source: 'provider-limit-signal', resumeAt: THURSDAY_NIGHT } });
    handler.maybeParkKnown(held({ accountProfileId: 'legacy' }));
    expect(notices[0].content).toContain('Your Claude account has used its current allowance.');
  });

  it('does not name an account the saved list does not know', () => {
    const { handler, notices } = setup({}, { account: 'gone-9', knownLimit: { source: 'provider-limit-signal', resumeAt: THURSDAY_NIGHT } });
    handler.maybeParkKnown(held({ accountProfileId: 'gone-9' }));
    expect(notices[0].content).toContain('Your Claude account has used');
  });

  it('never presents a reset time that was only assumed', () => {
    const { handler, notices } = setup({}, { knownLimit: { source: 'provider-limit-assumed', resumeAt: NOON.getTime() + ASSUMED_ACCOUNT_LIMIT_MS } });
    handler.maybeParkKnown(held());
    expect(notices[0].content).toContain('has used its current allowance.');
    expect(notices[0].content).not.toMatch(/It resets/);
  });

  it('shows the reset the provider gave on a usage-limit stop, but not the hour it guessed when none was given', () => {
    const given = setup();
    given.handler.maybeParkOnUsageLimit({ instanceId: 'i1', resetAtHint: THURSDAY_NIGHT, reason: 'provider refused its usage window (seven_day) and paid overage is not allowed — stopping' });
    expect(given.notices).toHaveLength(1);
    expect(given.notices[0].content).toContain('It resets on Thursday 22 October at 23:00.');
    expect((given.notices[0].metadata['errorPresentation'] as { rawDetail: string }).rawDetail).toContain('seven_day');
    expect(given.notices[0].content).not.toContain('seven_day');

    const guessed = setup();
    guessed.handler.maybeParkOnUsageLimit({ instanceId: 'i1', resetAtHint: null, reason: 'provider is billing paid overage on this session — stopping' });
    expect(guessed.notices[0].content).toContain('has used its current allowance.');
    expect(guessed.notices[0].content).not.toMatch(/It resets/);
  });

  it('says in one note that it is moving the conversation when it switches account', () => {
    const { handler, notices } = setup({
      accountFailover: {
        plan: () => ({ kind: 'switch', toProfileId: 'other' }),
        perform: () => new Promise(() => undefined),
        offer: vi.fn(),
        shouldSwitchPreemptively: () => false,
        release: vi.fn(),
      } as unknown as InstanceProviderLimitHandlerDeps['accountFailover'],
    }, { account: 'work-1' });
    expect(handler.maybeParkOnUsageLimit({ instanceId: 'i1', resetAtHint: THURSDAY_NIGHT, reason: 'overage' })).toBe('switching-account');

    expect(notices).toHaveLength(1);
    expect(notices[0].content).toContain('Your Work Claude account has used its current allowance.');
    expect(notices[0].content).toContain('No action needed: Harness is moving this conversation to another account.');
    expect(notices[0].metadata).toMatchObject({ accountFailover: true });
  });

  it('does not repeat itself when a switch fails: the failover note that follows is what explains the hold', async () => {
    const { handler, notices } = setup({
      accountFailover: {
        plan: () => ({ kind: 'switch', toProfileId: 'other' }),
        perform: async () => ({ outcome: 'not-switched', reason: 'no-candidate', considered: [] }),
        offer: vi.fn(),
        shouldSwitchPreemptively: () => false,
        release: vi.fn(),
      } as unknown as InstanceProviderLimitHandlerDeps['accountFailover'],
    }, { account: 'work-1' });
    handler.maybeParkOnUsageLimit({ instanceId: 'i1', resetAtHint: THURSDAY_NIGHT, reason: 'overage' });
    await vi.advanceTimersByTimeAsync(0);

    expect(handler.isParked('i1')).toBe(true);
    expect(notices.map(notice => notice.content)).toEqual([
      expect.stringContaining('No action needed: Harness is moving this conversation to another account.'),
      'No other account in this pool is available, so this session is parked and will resume when the limit lifts.',
    ]);
    expect(notices[1].metadata).toMatchObject({ providerLimitParked: true, accountFailover: true });
  });

  it('stays quiet and lets the adapter\'s one note carry the hold when an adapter event is in progress', () => {
    const { handler, notices } = setup();
    const handling = dispatchRateLimitTelemetry('claude', true, () => {
      handler.maybeParkOnUsageLimit({ instanceId: 'i1', resetAtHint: THURSDAY_NIGHT, reason: 'overage' });
    });
    expect(notices).toHaveLength(0);
    expect(handling).toMatchObject({ kind: 'parked', autoResume: true, heldMessage: false, metadata: { providerLimitParked: true } });
  });

  it('speaks for itself when the adapter will not announce the event in progress', () => {
    const { handler, notices } = setup();
    dispatchRateLimitTelemetry('claude', false, () => {
      handler.maybeParkOnUsageLimit({ instanceId: 'i1', resetAtHint: THURSDAY_NIGHT, reason: 'overage' });
    });
    expect(notices).toHaveLength(1);
  });

  it('tells the caller what a failed turn\'s park did, and writes nothing itself: the caller writes the one note about that turn', () => {
    const { handler, notices } = setup();
    const collected = collectUsageLimitHandling('claude', () => handler.maybePark({
      instanceId: 'i1', provider: 'claude', resetAtHint: THURSDAY_NIGHT, reason: 'provider limit on turn: stream closed', resumePrompt: 'send this',
    }));

    expect(collected.result).toBe('parked');
    expect(collected.handling).toMatchObject({ kind: 'parked', autoResume: true, heldMessage: true, metadata: { providerLimitParked: true } });
    expect(notices).toHaveLength(0);
    expect(handler.isParked('i1')).toBe(true);
  });

  it('reports that a park only holds when automatic resume is off but the stop must hold anyway', () => {
    const { handler, notices } = setup({}, { autoResume: false });
    const collected = collectUsageLimitHandling('claude', () => handler.maybePark({
      instanceId: 'i1', provider: 'claude', resetAtHint: THURSDAY_NIGHT, reason: 'overage', resumePrompt: null, allowCredits: false,
    }));

    expect(collected.result).toBe('parked');
    expect(collected.handling).toMatchObject({ kind: 'parked', autoResume: false, heldMessage: false });
    expect(notices).toHaveLength(0);
  });

  it('reports the actual scheduled park when its optional options are absent', () => {
    const { handler, notices } = setup();
    // Exercise the default options contract: a swallowed presentation exception must
    // not leave a caller claiming a hold-only park when a resume was scheduled.
    const park = handler as unknown as { park: (params: ReturnType<typeof held>, provider: 'claude', resumeAt: number) => string };
    const collected = collectUsageLimitHandling('claude', () => park.park(held(), 'claude', THURSDAY_NIGHT));
    expect(collected.result).toBe('parked');
    expect(handler.isParked('i1')).toBe(true);
    expect(collected.handling).toMatchObject({ kind: 'parked', autoResume: true, heldMessage: false });
    expect(notices).toHaveLength(0);
  });

  it('stays silent for a park nobody is waiting to announce (an orchestration response refused by the limit)', () => {
    const { handler, notices } = setup();
    expect(handler.maybePark({
      instanceId: 'i1', provider: 'claude', resetAtHint: THURSDAY_NIGHT, reason: 'provider limit on turn: stream closed', resumePrompt: null,
    })).toBe('parked');
    expect(notices).toHaveLength(0);
  });

  it('holds the session even if writing the note fails', () => {
    const { handler } = setup({ emitSystemMessage: () => { throw new Error('transcript unavailable'); } });
    expect(handler.maybeParkOnUsageLimit({ instanceId: 'i1', resetAtHint: THURSDAY_NIGHT, reason: 'overage' })).toBe('parked');
    expect(handler.isParked('i1')).toBe(true);
  });

  it('holds the session without a note when there is nowhere to write one', () => {
    const { handler } = setup({ emitSystemMessage: undefined });
    expect(handler.maybeParkOnUsageLimit({ instanceId: 'i1', resetAtHint: THURSDAY_NIGHT, reason: 'overage' })).toBe('parked');
  });
});
