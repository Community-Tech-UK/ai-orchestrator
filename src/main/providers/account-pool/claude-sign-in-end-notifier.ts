/**
 * Warns before a Claude account's sign-in runs out.
 *
 * Every claude.ai sign-in has a fixed end date that token renewal does not
 * move (see `src/shared/claude-sign-in-end.ts`). Without a warning an account
 * simply drops out of the pool on that day, as one did on 18 November
 * 2026. Once an hour this reads each enabled Claude account's end
 * date from the binding check and, a week before the earliest end, notifies
 * once per sign-in. Signing in again (a new end date) or the account no longer
 * being signed in, switched off or removed resolves the notice, whether or
 * not it was shown. A notice held back by quiet hours or cooldown stays in
 * the in-app list and is retried on the next check. Each account has its own
 * cooldown, so two accounts reaching their window together both show.
 */

import {
  CLAUDE_SIGN_IN_ENDING_NOTIFICATION_KIND,
  claudeSignInEndingSoon,
  describeClaudeSignInEnd,
} from '../../../shared/claude-sign-in-end';
import type { AccountBindingStatus, ProviderAccountProfile } from '../../../shared/types/provider-account.types';
import { getNotificationService, type NotificationInput } from '../../notifications/notification-service';
import { wasNotificationShown } from '../../storage/low-disk-space-watcher';
import { getLogger } from '../../logging/logger';
import { getProviderAccountBindingService, LOCAL_ACCOUNT_NODE_ID } from './provider-account-binding-service';
import { getProviderAccountStore } from './provider-account-store';

const logger = getLogger('ClaudeSignInEndNotifier');

const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface ClaudeSignInEndNotifierDeps {
  listProfiles: () => ProviderAccountProfile[];
  /** Never throws: an unreadable account comes back `unavailable`. */
  checkBinding: (profile: ProviderAccountProfile) => Promise<AccountBindingStatus>;
  /** Returns false when the notice was held back (quiet hours, cooldown, duplicate). */
  notify: (input: NotificationInput) => boolean;
  resolve: (resolveKey: string) => void;
  now?: () => number;
}

export function claudeSignInEndResolveKey(profileId: string): string {
  return `${CLAUDE_SIGN_IN_ENDING_NOTIFICATION_KIND}:${profileId}`;
}

export class ClaudeSignInEndNotifier {
  /** Profile id → the end date its notice is about, and whether that notice has been shown. */
  private readonly raised = new Map<string, { latest: number; shown: boolean }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ClaudeSignInEndNotifierDeps) {}

  start(intervalMs = CHECK_INTERVAL_MS): void {
    if (this.timer) return;
    const run = (): void => {
      this.check().catch((error: unknown) => {
        logger.warn('Could not check Claude sign-in end dates', { error: error instanceof Error ? error.message : String(error) });
      });
    };
    run();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<void> {
    const profiles = this.deps.listProfiles().filter((profile) => profile.provider === 'claude' && profile.enabled);
    const statuses = await Promise.all(profiles.map(async (profile) => ({ profile, status: await this.deps.checkBinding(profile) })));
    const now = (this.deps.now ?? Date.now)();
    const current = new Set(profiles.map((profile) => profile.id));
    for (const profileId of [...this.raised.keys()]) {
      if (!current.has(profileId)) this.clear(profileId);
    }
    for (const { profile, status } of statuses) {
      // A failed check says nothing about the sign-in; leave any notice as it is.
      if (status.state === 'unavailable') continue;
      const end = status.state === 'authenticated' ? claudeSignInEndingSoon(status.loginExpiresAt, now) : null;
      const raised = this.raised.get(profile.id);
      if (!end) {
        if (raised) this.clear(profile.id);
        continue;
      }
      if (raised?.latest === end.latest && raised.shown) continue;
      if (raised && raised.latest !== end.latest) this.clear(profile.id);
      const account = status.observedIdentity ? `${profile.label} (${status.observedIdentity})` : profile.label;
      logger.info('Claude sign-in ends soon', { profileId: profile.id, loginExpiresAt: end.latest });
      const shown = this.deps.notify({
        kind: CLAUDE_SIGN_IN_ENDING_NOTIFICATION_KIND,
        title: `Sign in to Claude account ${profile.label} again soon`,
        body: `The sign-in for ${account} ${describeClaudeSignInEnd(end, now)}. `
          + 'Only signing in again moves that date. In Settings, Accounts, click Sign in again on this account.',
        urgency: 'normal',
        fingerprintFields: { profileId: profile.id, loginExpiresAt: end.latest },
        resolveKey: claudeSignInEndResolveKey(profile.id),
        cooldownKey: claudeSignInEndResolveKey(profile.id),
      });
      this.raised.set(profile.id, { latest: end.latest, shown });
    }
  }

  private clear(profileId: string): void {
    this.raised.delete(profileId);
    this.deps.resolve(claudeSignInEndResolveKey(profileId));
  }
}

let instance: ClaudeSignInEndNotifier | null = null;

/** Start the hourly check. Idempotent. */
export function startClaudeSignInEndNotifier(): ClaudeSignInEndNotifier {
  if (!instance) {
    instance = new ClaudeSignInEndNotifier({
      listProfiles: () => getProviderAccountStore().listProfiles('claude'),
      checkBinding: (profile) => getProviderAccountBindingService().checkBinding(profile, LOCAL_ACCOUNT_NODE_ID),
      notify: (input) => wasNotificationShown(getNotificationService().notify(input).delivery),
      resolve: (resolveKey) => getNotificationService().resolve(resolveKey),
    });
    instance.start();
  }
  return instance;
}

export function _resetForTesting(): void {
  instance?.stop();
  instance = null;
}
