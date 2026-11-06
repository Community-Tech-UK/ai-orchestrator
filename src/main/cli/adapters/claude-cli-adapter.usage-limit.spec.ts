import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceProviderLimitHandler } from '../../instance/instance-provider-limit-handler';
import {
  attachUsageOverageStopGuard,
  configureUsageOverageStop,
  resetUsageOverageStopForTesting,
} from '../../instance/instance-usage-overage-wiring';
import { rememberAdapterAccountRoute } from '../../providers/account-pool/adapter-account-routes';
import type { ResolvedAccountRoute } from '../../../shared/types/provider-account.types';
import { ClaudeCliAdapter } from './claude-cli-adapter';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
// The handler names the account from the saved account list; the adapter names it from the route it was started with.
vi.mock('../../providers/account-pool/provider-account-store', () => ({
  getProviderAccountStore: () => ({ getProfile: (_provider: string, id: string) => (id === 'work-1' ? { label: 'Work' } : null) }),
}));

interface Output { type: string; content: string; metadata?: Record<string, unknown> }
interface Notice { instanceId: string; content: string; metadata: Record<string, unknown> }

const INSTANCE = 'session-1';
const NOON = new Date(2026, 9, 20, 12);
const THURSDAY_NIGHT_SECONDS = Math.floor(new Date(2026, 9, 22, 23).getTime() / 1000);
const rejected = (overrides: Record<string, unknown> = {}) => ({
  type: 'rate_limit_event',
  timestamp: 1,
  rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: THURSDAY_NIGHT_SECONDS, ...overrides },
});

function route(profileId: string, profileLabel?: string): ResolvedAccountRoute {
  return { provider: 'claude', profileId, source: 'explicit', executionNodeId: 'local', ...(profileLabel ? { profileLabel } : {}) } as ResolvedAccountRoute;
}

interface Options {
  guard?: boolean;
  autoResume?: boolean;
  account?: ResolvedAccountRoute;
  failover?: 'switch';
}

function setup(options: Options = {}) {
  const adapter = new ClaudeCliAdapter();
  const outputs: Output[] = [];
  const notices: Notice[] = [];
  const telemetry: unknown[] = [];
  adapter.on('output', (output: Output) => outputs.push(output));
  adapter.on('rate-limit-telemetry', (info: unknown) => telemetry.push(info));
  if (options.account) rememberAdapterAccountRoute(adapter, options.account);
  const feed = (adapter as unknown as { processCliMessage(message: unknown): void }).processCliMessage.bind(adapter);
  (adapter as unknown as { resetResidentTurn(): void }).resetResidentTurn();

  const handler = new InstanceProviderLimitHandler();
  handler.configure({
    isEnabled: () => options.autoResume !== false,
    setWaitReason: () => undefined,
    resendInput: () => undefined,
    getQuotaSnapshot: () => null,
    getWorkspaceCwd: () => '/tmp/workspace',
    getProviderModel: () => ({ provider: 'claude', model: null, accountProfileId: options.account?.profileId ?? 'legacy' }),
    emitSystemMessage: (instanceId, content, metadata) => { notices.push({ instanceId, content, metadata }); },
    scheduleResume: () => () => undefined,
    ...(options.failover === 'switch' ? {
      accountFailover: {
        plan: () => ({ kind: 'switch', toProfileId: 'other' }),
        perform: () => new Promise(() => undefined),
        offer: vi.fn(),
        shouldSwitchPreemptively: () => false,
        release: vi.fn(),
      },
    } as never : {}),
  });
  configureUsageOverageStop({
    getAllowOverageSetting: () => false,
    interruptInstance: () => true,
    holdOnUsageLimit: (instanceId, signal) => {
      handler.maybeParkOnUsageLimit({ instanceId, resetAtHint: signal.resetAtHint, reason: signal.reason });
    },
  });
  const detach = options.guard === false ? () => undefined : attachUsageOverageStopGuard(adapter, INSTANCE);
  return {
    adapter, handler, outputs, notices, telemetry, feed,
    /** Everything the transcript would be told about the limit. */
    messages: () => [...outputs.map(o => o.content), ...notices.map(n => n.content)],
    cleanup: () => { detach(); handler._resetForTesting(); },
  };
}

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOON);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetUsageOverageStopForTesting();
  vi.useRealTimers();
});
const run = (options?: Options) => {
  const harness = setup(options);
  cleanups.push(harness.cleanup);
  return harness;
};

describe('Claude usage limit: one message', () => {
  it.each([true, false])('says it once, with the account, allowance and reset day, when the session is held (auto-resume %s)', autoResume => {
    const h = run({ autoResume, account: route('work-1', 'Work') });
    h.feed(rejected());

    expect(h.messages()).toHaveLength(1);
    expect(h.notices).toHaveLength(0);
    const [content] = h.messages();
    expect(content).toContain('Your Work Claude account has used its weekly allowance.');
    expect(content).toContain('It resets on Thursday 22 October at 23:00.');
    expect(content).toContain(autoResume
      ? 'Harness will pick this session up again once the allowance resets.'
      : 'This session is on hold until the allowance resets.');
    expect(content).not.toMatch(/rejected|seven_day|rate limit|Provider limit reached/i);
    expect(h.handler.isParked(INSTANCE)).toBe(true);
  });

  it('keeps the runtime metadata of both old notes on the one message, and the provider\'s words behind Details', () => {
    const h = run({ account: route('work-1', 'Work') });
    h.feed(rejected());

    expect(h.outputs[0].type).toBe('system');
    expect(h.outputs[0].metadata).toMatchObject({
      rateLimit: true,
      status: 'rejected',
      rateLimitType: 'seven_day',
      resetsAt: THURSDAY_NIGHT_SECONDS * 1000,
      providerLimitParked: true,
    });
    const presentation = h.outputs[0].metadata?.['errorPresentation'] as { category: string; rawDetail: string; action: string };
    expect(presentation.category).toBe('quota');
    expect(presentation.action).toBe('switch-account');
    expect(presentation.rawDetail).toContain('rejected');
    expect(presentation.rawDetail).toContain('seven_day');
  });

  it('still emits the raw telemetry event exactly as received', () => {
    const h = run();
    h.feed(rejected());
    expect(h.telemetry).toEqual([{ status: 'rejected', rateLimitType: 'seven_day', resetsAt: THURSDAY_NIGHT_SECONDS }]);
    expect(h.adapter.getLastRateLimitInfo()?.status).toBe('rejected');
  });

  it('does not say it again for the same window, however many times the provider repeats it', () => {
    const h = run({ account: route('work-1', 'Work') });
    h.feed(rejected());
    h.feed({ type: 'rate_limit_event', timestamp: 2, rate_limit_info: { status: 'allowed' } });
    h.feed(rejected());
    h.feed(rejected());
    expect(h.messages()).toHaveLength(1);
    expect(h.telemetry).toHaveLength(4);
  });

  it('writes the one note itself when the handler has to hold the session a second time for a window already announced', () => {
    const h = run({ account: route('work-1', 'Work') });
    h.feed(rejected());
    // The user resumes; the account is still out, so the same window refuses again.
    h.handler.cancel(INSTANCE);
    h.feed(rejected());

    expect(h.outputs).toHaveLength(1);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0].content).toContain('Your Work Claude account has used its current allowance.');
    expect(h.notices[0].content).toContain('Harness will pick this session up again');
    expect(h.notices[0].metadata).toMatchObject({ providerLimitParked: true });
  });

  it('says it once, as a move to another account, when Harness is switching rather than waiting', () => {
    const h = run({ account: route('work-1', 'Work'), failover: 'switch' });
    h.feed(rejected());

    expect(h.messages()).toHaveLength(1);
    const [content] = h.messages();
    expect(content).toContain('Your Work Claude account has used its weekly allowance.');
    expect(content).toContain('No action needed: Harness is moving this conversation to another account.');
    expect(content).not.toContain('What to do:');
    expect(h.outputs[0].metadata).toMatchObject({ rateLimit: true, accountFailover: true });
    expect(h.outputs[0].metadata).not.toHaveProperty('providerLimitParked');
  });

  it('still tells the user, by the adapter alone, when nothing is holding the session', () => {
    const h = run({ guard: false, account: route('work-1', 'Work') });
    h.feed(rejected());

    expect(h.messages()).toHaveLength(1);
    expect(h.messages()[0]).toContain('What to do: Wait for the allowance to reset, or switch account.');
    expect(h.outputs[0].metadata).not.toHaveProperty('providerLimitParked');
  });

  it('leaves out the name of the default account, and out of the sentence the provider\'s window names', () => {
    const h = run({ account: route('legacy', 'Existing Claude account') });
    h.feed(rejected({ rateLimitType: 'five_hour' }));
    expect(h.messages()[0]).toContain('Your Claude account has used its current allowance.');
    expect(h.messages()[0]).not.toMatch(/Existing|five_hour/);
  });

  it('gives a new window its own message', () => {
    const h = run({ guard: false });
    h.feed(rejected());
    h.feed(rejected({ resetsAt: THURSDAY_NIGHT_SECONDS + 7 * 24 * 3600 }));
    expect(h.messages()).toHaveLength(2);
  });

  it('is a calm heads-up, not a limit message, when the account is only close to its allowance', () => {
    const h = run({ account: route('work-1', 'Work') });
    h.feed({ type: 'rate_limit_event', timestamp: 1, rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', resetsAt: THURSDAY_NIGHT_SECONDS } });

    expect(h.messages()).toHaveLength(1);
    expect(h.messages()[0]).toContain('Your Work Claude account is close to its weekly allowance.');
    expect(h.messages()[0]).toContain('No action needed: you can keep working.');
    expect(h.messages()[0]).not.toMatch(/allowed_warning|seven_day|has used/);
    expect(h.outputs[0].metadata).toMatchObject({ rateLimit: true, status: 'allowed_warning' });
    expect(h.outputs[0].metadata).not.toHaveProperty('errorPresentation');
    expect(h.handler.isParked(INSTANCE)).toBe(false);
  });

  it('keeps a window name or status of an unexpected type out of the sentence without failing', () => {
    const h = run({ guard: false });
    expect(() => h.feed(rejected({ rateLimitType: { source: 'PRIVATE_WINDOW' }, status: 'rejected' }))).not.toThrow();
    expect(h.messages()[0]).not.toContain('PRIVATE_WINDOW');
    expect(h.outputs[0].metadata).toMatchObject({ rateLimit: true, rateLimitType: { source: 'PRIVATE_WINDOW' } });
  });

  it('does not invent a reset time when the provider gave none', () => {
    const h = run({ guard: false });
    h.feed({ type: 'rate_limit_event', timestamp: 1, rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day' } });
    expect(h.messages()[0]).toContain('has used its weekly allowance.');
    expect(h.messages()[0]).not.toContain('resets');
  });
});
