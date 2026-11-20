import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountBindingStatus, ProviderAccountProfile } from '../../../shared/types/provider-account.types';
import type { NotificationInput } from '../../notifications/notification-service';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../notifications/notification-service', () => ({ getNotificationService: vi.fn() }));
vi.mock('./provider-account-binding-service', () => ({ LOCAL_ACCOUNT_NODE_ID: 'local', getProviderAccountBindingService: vi.fn() }));
vi.mock('./provider-account-store', () => ({ getProviderAccountStore: vi.fn() }));

import { ClaudeSignInEndNotifier, claudeSignInEndResolveKey } from './claude-sign-in-end-notifier';

const DAY = 24 * 60 * 60 * 1000;
/** Local midday, so the dates in the text do not depend on the time zone. */
const LATEST = new Date(2026, 10, 27, 12, 0).getTime();

function profile(id: string, overrides: Partial<ProviderAccountProfile> = {}): ProviderAccountProfile {
  return {
    id, provider: 'claude', label: `Account ${id}`, expectedIdentity: null, expectedAccountKey: null, planLabel: null,
    priority: 1, enabled: true, automationPolicy: 'allow-routed', isLegacy: false, createdAt: 1, updatedAt: 1, ...overrides,
  };
}

let profiles: ProviderAccountProfile[];
let statuses: Record<string, Partial<AccountBindingStatus>>;
let now: number;
let shown: boolean;
const notify = vi.fn((_input: NotificationInput) => shown);
const resolve = vi.fn((_key: string) => undefined);

function notifier(): ClaudeSignInEndNotifier {
  return new ClaudeSignInEndNotifier({
    listProfiles: () => profiles,
    checkBinding: async (entry) => ({
      provider: entry.provider, profileId: entry.id, nodeId: 'local', state: 'authenticated', checkedAt: now, ...statuses[entry.id],
    }),
    notify,
    resolve,
    now: () => now,
  });
}

beforeEach(() => {
  profiles = [profile('it'), profile('one')];
  statuses = {
    it: { loginExpiresAt: LATEST, observedIdentity: 'it@example.com' },
    one: { loginExpiresAt: LATEST + 20 * DAY },
  };
  now = LATEST - 6 * DAY;
  shown = true;
  notify.mockClear();
  resolve.mockClear();
});

describe('ClaudeSignInEndNotifier', () => {
  it('notifies once for an account whose sign-in ends within the warning window', async () => {
    const watcher = notifier();
    await watcher.check();
    await watcher.check();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({
      kind: 'claude-sign-in-ending',
      title: 'Sign in to Claude account Account it again soon',
      body: expect.stringContaining('The sign-in for Account it (it@example.com) ends between 24 and 27 November.'),
      resolveKey: claudeSignInEndResolveKey('it'),
      cooldownKey: claudeSignInEndResolveKey('it'),
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('tries again on the next check when the notice was held back', async () => {
    const watcher = notifier();
    shown = false;
    await watcher.check();
    shown = true;
    await watcher.check();
    await watcher.check();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('resolves a held-back notice when the account is signed in again or removed before it was shown', async () => {
    const watcher = notifier();
    shown = false;
    await watcher.check();
    statuses['it'] = { loginExpiresAt: LATEST + 28 * DAY };
    await watcher.check();
    expect(resolve).toHaveBeenCalledWith(claudeSignInEndResolveKey('it'));

    statuses['it'] = { loginExpiresAt: LATEST };
    await watcher.check();
    profiles = [profile('one')];
    await watcher.check();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('resolves the notice once the account is signed in again', async () => {
    const watcher = notifier();
    await watcher.check();
    statuses['it'] = { loginExpiresAt: LATEST + 28 * DAY };
    await watcher.check();
    expect(resolve).toHaveBeenCalledWith(claudeSignInEndResolveKey('it'));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('keeps the notice through a failed check and resolves it when the account signs out or is removed', async () => {
    const watcher = notifier();
    await watcher.check();
    statuses['it'] = { state: 'unavailable' };
    await watcher.check();
    expect(resolve).not.toHaveBeenCalled();
    statuses['it'] = { state: 'unauthenticated' };
    await watcher.check();
    expect(resolve).toHaveBeenCalledTimes(1);

    statuses['it'] = { loginExpiresAt: LATEST };
    await watcher.check();
    profiles = [profile('one')];
    await watcher.check();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('leaves switched-off and non-Claude accounts alone', async () => {
    profiles = [profile('it', { enabled: false }), profile('codex', { provider: 'codex' })];
    statuses['codex'] = { loginExpiresAt: LATEST };
    await notifier().check();
    expect(notify).not.toHaveBeenCalled();
  });
});
