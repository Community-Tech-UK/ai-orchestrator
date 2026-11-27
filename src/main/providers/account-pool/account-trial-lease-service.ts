/**
 * Trial account leases: the agent-usable way to reserve provider accounts for a
 * trial and put them back afterwards.
 *
 * `providerAccountProfiles` is operator-only, so an agent has no way to stop
 * automatic routing from picking an account it wants to keep for a trial, or to
 * start a chat on an account whose policy is `disabled`. A lease is the narrow,
 * logged substitute: it saves each named profile's `automationPolicy`, sets it
 * to `manual-only` (the only value this service can write), lets the owning
 * session start ordinary chats on those profiles, and restores the saved
 * policies when the lease ends.
 *
 * A lease ends by explicit release, by the owning session going away, by
 * expiry, or at the next app start. The saved originals are written to disk
 * before any policy changes, so a crash cannot strand a changed policy.
 * A profile is restored only if its policy is still the one the lease set; a
 * hand edit made during the lease is left alone and reported. (A person who deliberately sets `manual-only`
 * during a lease cannot be told apart from the lease's own write, so release puts the saved value back.)
 *
 * Profiles are identified by provider + id: the Claude and Codex legacy
 * profiles both have the id `legacy`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AccountAutomationPolicy,
  PooledProvider,
  ProviderAccountProfile,
} from '../../../shared/types/provider-account.types';
import { isLogicalMiMoModel, isPooledProvider } from '../../../shared/types/provider-account.types';
import {
  ACCOUNT_TRIAL_DEFAULT_TTL_MINUTES,
  ACCOUNT_TRIAL_MAX_PROFILES,
  ACCOUNT_TRIAL_MAX_SESSIONS,
  ACCOUNT_TRIAL_MAX_TTL_MINUTES,
  ACCOUNT_TRIAL_POLICY,
  type AccountTrialOperations,
  type AccountTrialProfileRef,
  type AccountTrialReleaseReason,
  type AccountTrialReleaseReceipt,
  type AccountTrialReserveReceipt,
  type AccountTrialStartSessionInput,
  type AccountTrialStatus,
} from '../../../shared/types/account-trial.types';
import { getLogger } from '../../logging/logger';

const logger = getLogger('AccountTrialLease');

export interface AccountTrialProfileStore {
  getProfile(provider: PooledProvider, profileId: string): ProviderAccountProfile | null;
  updateProfile(
    provider: PooledProvider,
    profileId: string,
    input: { automationPolicy: AccountAutomationPolicy },
  ): unknown;
}

export interface AccountTrialLeaseDeps {
  store: AccountTrialProfileStore;
  /** JSON file holding the live leases. Its folder must already exist. */
  filePath: string;
  /** Whether the session that owns a lease is still running. */
  isInstanceLive(instanceId: string): boolean;
  /** Starts an ordinary chat session on the named account and returns its id. Throws when the route is refused. */
  startSession(request: {
    ownerInstanceId: string;
    provider: PooledProvider;
    profileId: string;
    prompt: string;
    model?: string;
    workingDirectory?: string;
    name?: string;
  }): Promise<{ instanceId: string }>;
  /** Stops a session this service started. Must do nothing for a session that has already ended. */
  terminateSession(instanceId: string): Promise<void>;
  now?: () => number;
  newLeaseId?: () => string;
}

interface LeaseProfile extends AccountTrialProfileRef {
  label: string;
  originalPolicy: AccountAutomationPolicy;
}

interface Lease {
  id: string;
  ownerInstanceId: string;
  createdAt: number;
  expiresAt: number;
  profiles: LeaseProfile[];
  sessionIds: string[];
}

const POLICIES: readonly AccountAutomationPolicy[] = ['allow-routed', 'manual-only', 'disabled'];

/** A stored lease is trusted to write a policy back, so every field that decides what gets written is checked. */
function parseLease(candidate: unknown): [string, Lease] {
  const lease = candidate as Partial<Lease> | null;
  const valid = lease !== null && typeof lease === 'object'
    && typeof lease.id === 'string' && lease.id.length > 0
    && typeof lease.ownerInstanceId === 'string'
    && typeof lease.createdAt === 'number' && typeof lease.expiresAt === 'number'
    && Array.isArray(lease.sessionIds) && lease.sessionIds.every((id) => typeof id === 'string')
    && Array.isArray(lease.profiles) && lease.profiles.every((entry) => entry !== null && typeof entry === 'object'
      && isPooledProvider(entry.provider) && typeof entry.profileId === 'string' && typeof entry.label === 'string'
      && POLICIES.includes(entry.originalPolicy));
  if (!valid) throw new Error('malformed lease');
  return [lease.id!, lease as Lease];
}

const keyOf = (ref: AccountTrialProfileRef): string => `${ref.provider}:${ref.profileId}`;

export class AccountTrialLeaseService implements AccountTrialOperations {
  private readonly leases = new Map<string, Lease>();
  /** Leases whose release has started. They accept no new sessions, even if a restore failed and the lease is kept for retry. */
  private readonly ending = new Set<string>();
  /** Sessions being started per lease. They count toward the session limit before they have an id. */
  private readonly starting = new Map<string, number>();

  constructor(private readonly deps: AccountTrialLeaseDeps) {
    this.load();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  reserve(
    ownerInstanceId: string,
    input: { profiles: AccountTrialProfileRef[]; ttlMinutes?: number },
  ): AccountTrialReserveReceipt {
    const refs = input.profiles;
    if (refs.length < 1 || refs.length > ACCOUNT_TRIAL_MAX_PROFILES) {
      throw new Error(`Reserve between 1 and ${ACCOUNT_TRIAL_MAX_PROFILES} accounts.`);
    }
    if (new Set(refs.map(keyOf)).size !== refs.length) {
      throw new Error('Each account can be listed only once.');
    }
    const ttlMinutes = input.ttlMinutes ?? ACCOUNT_TRIAL_DEFAULT_TTL_MINUTES;
    if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > ACCOUNT_TRIAL_MAX_TTL_MINUTES) {
      throw new Error(`ttlMinutes must be a whole number from 1 to ${ACCOUNT_TRIAL_MAX_TTL_MINUTES}.`);
    }

    const reserved = new Set([...this.leases.values()].flatMap((lease) => lease.profiles.map(keyOf)));
    const profiles: LeaseProfile[] = refs.map((ref) => {
      if (!isPooledProvider(ref.provider)) throw new Error(`Unknown provider "${String(ref.provider)}".`);
      const profile = this.deps.store.getProfile(ref.provider, ref.profileId);
      if (!profile) throw new Error(`No ${ref.provider} account "${ref.profileId}" (profile-missing).`);
      if (reserved.has(keyOf(ref))) {
        throw new Error(`The ${profile.label} account is already reserved by another trial lease.`);
      }
      return { provider: ref.provider, profileId: ref.profileId, label: profile.label, originalPolicy: profile.automationPolicy };
    });

    const now = this.now();
    const lease: Lease = {
      id: this.deps.newLeaseId?.() ?? randomUUID(),
      ownerInstanceId,
      createdAt: now,
      expiresAt: now + ttlMinutes * 60_000,
      profiles,
      sessionIds: [],
    };

    // Write-ahead: the saved originals reach disk before any policy changes.
    this.leases.set(lease.id, lease);
    try {
      this.persist();
    } catch (error) {
      this.leases.delete(lease.id);
      throw error;
    }

    try {
      for (const entry of profiles) {
        if (entry.originalPolicy !== ACCOUNT_TRIAL_POLICY) {
          this.deps.store.updateProfile(entry.provider, entry.profileId, { automationPolicy: ACCOUNT_TRIAL_POLICY });
        }
      }
    } catch (error) {
      const rollback = this.restoreProfiles(lease);
      if (rollback.every((entry) => entry.outcome !== 'restore-failed')) {
        this.leases.delete(lease.id);
        this.persist();
      }
      throw new Error(
        `Could not reserve the accounts, so the policies were put back: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    logger.info('account_trial reserved', {
      leaseId: lease.id,
      ownerInstanceId,
      expiresAt: lease.expiresAt,
      profiles: profiles.map((entry) => ({
        provider: entry.provider,
        profileId: entry.profileId,
        from: entry.originalPolicy,
        to: ACCOUNT_TRIAL_POLICY,
      })),
    });
    return {
      leaseId: lease.id,
      expiresAt: lease.expiresAt,
      profiles: profiles.map((entry) => ({
        provider: entry.provider,
        profileId: entry.profileId,
        label: entry.label,
        previousPolicy: entry.originalPolicy,
        policy: ACCOUNT_TRIAL_POLICY,
      })),
    };
  }

  async startSession(
    ownerInstanceId: string,
    input: AccountTrialStartSessionInput,
  ): Promise<{ instanceId: string; leaseId: string }> {
    const lease = this.requireOwnedLease(ownerInstanceId, input.leaseId);
    if (this.ending.has(lease.id)) {
      throw new Error('This trial lease is being released. Reserve the accounts again.');
    }
    if (lease.expiresAt <= this.now()) {
      throw new Error('This trial lease has expired. Reserve the accounts again.');
    }
    if (!lease.profiles.some((entry) => keyOf(entry) === keyOf(input))) {
      throw new Error(`The ${input.provider} account "${input.profileId}" is not part of this lease.`);
    }
    // Without a logical MiMo model OpenCode ignores the account and uses its own sign-in, which would
    // run the arm on the wrong account without any error.
    if (input.provider === 'opencode' && !isLogicalMiMoModel(input.model)) {
      throw new Error('A MiMo account needs a Token Plan model, for example "xiaomi-token-plan-ams/<model>". Pass model.');
    }
    const inFlight = this.starting.get(lease.id) ?? 0;
    if (lease.sessionIds.length + inFlight >= ACCOUNT_TRIAL_MAX_SESSIONS) {
      throw new Error(`A lease can start at most ${ACCOUNT_TRIAL_MAX_SESSIONS} sessions.`);
    }

    // Claimed before the first await, so simultaneous calls cannot all pass the limit check.
    this.starting.set(lease.id, inFlight + 1);
    let instanceId: string;
    try {
      ({ instanceId } = await this.deps.startSession({
        ownerInstanceId,
        provider: input.provider,
        profileId: input.profileId,
        prompt: input.prompt,
        ...(input.model ? { model: input.model } : {}),
        ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
        ...(input.name ? { name: input.name } : {}),
      }));
    } finally {
      const remaining = (this.starting.get(lease.id) ?? 1) - 1;
      if (remaining > 0) this.starting.set(lease.id, remaining);
      else this.starting.delete(lease.id);
    }

    // The lease may have ended while the session was starting (release, owner exit, expiry).
    if (this.leases.get(lease.id) !== lease) {
      await this.deps.terminateSession(instanceId);
      throw new Error('The lease ended while the session was starting; the new session was stopped.');
    }
    lease.sessionIds.push(instanceId);
    this.persist();
    logger.info('account_trial session started', {
      leaseId: lease.id,
      ownerInstanceId,
      provider: input.provider,
      profileId: input.profileId,
      instanceId,
    });
    return { instanceId, leaseId: lease.id };
  }

  async release(ownerInstanceId: string, leaseId: string): Promise<AccountTrialReleaseReceipt> {
    const lease = this.requireOwnedLease(ownerInstanceId, leaseId);
    return this.endLease(lease, 'released');
  }

  status(ownerInstanceId: string): AccountTrialStatus {
    const own = [...this.leases.values()].filter((lease) => lease.ownerInstanceId === ownerInstanceId);
    return {
      leases: own.map((lease) => ({
        leaseId: lease.id,
        expiresAt: lease.expiresAt,
        profiles: lease.profiles.map((entry) => ({
          provider: entry.provider,
          profileId: entry.profileId,
          label: entry.label,
          restoreTo: entry.originalPolicy,
          currentPolicy: this.deps.store.getProfile(entry.provider, entry.profileId)?.automationPolicy ?? null,
        })),
        sessionIds: [...lease.sessionIds],
      })),
      otherActiveLeases: this.leases.size - own.length,
    };
  }

  /** Ends every lease that has expired or whose owning session is gone. Run on a timer. */
  async sweep(): Promise<number> {
    const now = this.now();
    let ended = 0;
    for (const lease of [...this.leases.values()]) {
      const reason: AccountTrialReleaseReason | null = lease.expiresAt <= now
        ? 'expired'
        : (this.deps.isInstanceLive(lease.ownerInstanceId) ? null : 'owner-gone');
      if (!reason) continue;
      try {
        await this.endLease(lease, reason);
        ended += 1;
      } catch (error) {
        logger.warn('account_trial sweep could not end a lease', {
          leaseId: lease.id,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return ended;
  }

  /** At app start nothing a lease owned is running any more, so every leftover lease is ended. */
  async recover(): Promise<number> {
    let ended = 0;
    for (const lease of [...this.leases.values()]) {
      try {
        await this.endLease(lease, 'startup');
        ended += 1;
      } catch (error) {
        logger.warn('account_trial startup recovery could not end a lease', {
          leaseId: lease.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return ended;
  }

  private requireOwnedLease(ownerInstanceId: string, leaseId: string): Lease {
    const lease = this.leases.get(leaseId);
    // Same answer for "no such lease" and "someone else's lease" so ids cannot be probed.
    if (!lease || lease.ownerInstanceId !== ownerInstanceId) {
      throw new Error(`No active trial lease "${leaseId}" for this session.`);
    }
    return lease;
  }

  private async endLease(lease: Lease, reason: AccountTrialReleaseReason): Promise<AccountTrialReleaseReceipt> {
    // Everything up to the first await is synchronous, so two callers cannot both end the same lease.
    this.ending.add(lease.id);
    const profiles = this.restoreProfiles(lease);
    const complete = profiles.every((entry) => entry.outcome !== 'restore-failed');
    const sessionIds = [...lease.sessionIds];
    if (complete) {
      this.leases.delete(lease.id);
      this.ending.delete(lease.id);
      try {
        this.persist();
      } catch (error) {
        // The policies are already back, and a stale file only means "already-original" at the next start.
        // The sessions must still be stopped, so do not let this escape.
        logger.error('account_trial could not update the lease file after a release', error instanceof Error ? error : new Error(String(error)), { leaseId: lease.id });
      }
    }

    const sessions: AccountTrialReleaseReceipt['sessions'] = [];
    if (complete) {
      for (const instanceId of sessionIds) {
        try {
          await this.deps.terminateSession(instanceId);
          sessions.push({ instanceId, stopped: true });
        } catch (error) {
          sessions.push({ instanceId, stopped: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    logger.info('account_trial ended', {
      leaseId: lease.id,
      ownerInstanceId: lease.ownerInstanceId,
      reason,
      complete,
      profiles: profiles.map((entry) => ({
        provider: entry.provider,
        profileId: entry.profileId,
        outcome: entry.outcome,
        ...(entry.restoredTo ? { restoredTo: entry.restoredTo } : {}),
      })),
      sessions: sessions.length,
    });
    return { leaseId: lease.id, reason, complete, profiles, sessions };
  }

  private restoreProfiles(lease: Lease): AccountTrialReleaseReceipt['profiles'] {
    return lease.profiles.map((entry): AccountTrialReleaseReceipt['profiles'][number] => {
      const ref = { provider: entry.provider, profileId: entry.profileId };
      try {
        const current = this.deps.store.getProfile(entry.provider, entry.profileId);
        if (!current) return { ...ref, outcome: 'profile-removed' };
        if (current.automationPolicy === entry.originalPolicy) return { ...ref, outcome: 'already-original' };
        if (current.automationPolicy !== ACCOUNT_TRIAL_POLICY) {
          return { ...ref, outcome: 'left-changed-by-someone-else', currentPolicy: current.automationPolicy };
        }
        this.deps.store.updateProfile(entry.provider, entry.profileId, { automationPolicy: entry.originalPolicy });
        return { ...ref, outcome: 'restored', restoredTo: entry.originalPolicy };
      } catch (error) {
        return { ...ref, outcome: 'restore-failed', error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  private persist(): void {
    const body = JSON.stringify({ version: 1, leases: [...this.leases.values()] }, null, 2);
    const tmp = `${this.deps.filePath}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.deps.filePath), { recursive: true });
    fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.deps.filePath);
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.deps.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as { leases?: unknown };
      if (!Array.isArray(parsed.leases)) throw new Error('leases is not a list');
      for (const candidate of parsed.leases) {
        this.leases.set(...parseLease(candidate));
      }
    } catch (error) {
      // The saved originals cannot be trusted, and guessing at them could write a wrong policy.
      // Keep the file for a person to read and start empty.
      const aside = `${this.deps.filePath}.corrupt-${this.now()}`;
      fs.renameSync(this.deps.filePath, aside);
      this.leases.clear();
      logger.error('account_trial lease file was unreadable and was set aside', error instanceof Error ? error : new Error(String(error)), { aside });
    }
  }
}
