import { describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import Database from 'better-sqlite3';
import type { SqliteDriver } from '../db/sqlite-driver';
import { ProviderLimitLedger, createProviderLimitLedgerSchema } from '../core/system/provider-limit-ledger';
import { InstanceProviderLimitHandler, ASSUMED_ACCOUNT_LIMIT_MS } from './instance-provider-limit-handler';
import { snapshotShowsLimitLifted } from './provider-limit-lift';
import type { ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';
import type { AccountFailoverOutcome, AccountFailoverParams, AccountFailoverPlan } from '../providers/account-pool/account-failover-coordinator';

function setup(plan: AccountFailoverPlan, outcome: AccountFailoverOutcome, parkEnabled = true) {
  const db = new Database(':memory:') as unknown as SqliteDriver;
  createProviderLimitLedgerSchema(db);
  const ledger = new ProviderLimitLedger(db);
  const handler = new InstanceProviderLimitHandler();
  const performed: AccountFailoverParams[] = [];
  const offered: string[] = [];
  const released: string[] = [];
  const messages: string[] = [];
  const waitReasons = new Map<string, unknown>();
  let resolvePerform!: () => void;
  const performDone = new Promise<void>((resolve) => { resolvePerform = resolve; });
  handler.configure({
    isEnabled: () => parkEnabled,
    setWaitReason: (id, reason) => waitReasons.set(id, reason),
    resendInput: vi.fn(),
    getQuotaSnapshot: () => null,
    getWorkspaceCwd: () => '/tmp/w',
    scheduleResume: () => () => undefined,
    providerLimitLedger: ledger,
    accountFailover: {
      plan: () => plan,
      perform: async (params) => {
        performed.push(params);
        resolvePerform();
        return outcome;
      },
      offer: (_params, to) => offered.push(to),
      shouldSwitchPreemptively: () => false,
      release: (id) => released.push(id),
    },
    emitSystemMessage: (_id, content) => messages.push(content),
  });
  return { handler, ledger, performed, offered, released, messages, waitReasons, performDone, db };
}

const base = {
  instanceId: 'i1',
  provider: 'claude' as const,
  model: null,
  reason: 'limit',
  resumePrompt: 'continue',
  accountProfileId: 'max-a',
};

describe('InstanceProviderLimitHandler account failover', () => {
  it('records the limit against the exhausted profile and switches instead of parking', async () => {
    const h = setup({ kind: 'switch' }, { outcome: 'switched', toProfileId: 'max-b', continuity: 'replay' });
    const resetAt = Date.now() + 60_000;
    expect(h.handler.maybePark({ ...base, resetAtHint: resetAt })).toBe('switching-account');
    await h.performDone;
    expect(h.performed[0]).toMatchObject({ exhaustedProfileId: 'max-a', resumePrompt: 'continue', resumeAt: resetAt });
    expect(h.ledger.getActive({ provider: 'claude', model: null, accountProfileId: 'max-a' })).not.toBeNull();
    expect(h.ledger.getActive({ provider: 'claude', model: null, accountProfileId: 'max-b' })).toBeNull();
    expect(h.handler.isParked('i1')).toBe(false);
    h.db.close();
  });

  it('benches the profile for an hour when no reset time is known', () => {
    const h = setup({ kind: 'switch' }, { outcome: 'switched', toProfileId: 'max-b', continuity: 'replay' });
    const before = Date.now();
    expect(h.handler.maybePark({ ...base, resetAtHint: null })).toBe('switching-account');
    const row = h.ledger.getActive({ provider: 'claude', model: null, accountProfileId: 'max-a' });
    expect(row?.resumeAt).toBeGreaterThanOrEqual(before + ASSUMED_ACCOUNT_LIMIT_MS);
    expect(row?.source).toBe('provider-limit-assumed');
    h.db.close();
  });

  it('falls back to parking when no account can take over', async () => {
    const h = setup({ kind: 'switch' }, { outcome: 'not-switched', reason: 'no-candidate', considered: [] });
    h.handler.maybePark({ ...base, resetAtHint: Date.now() + 60_000 });
    await h.performDone;
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.handler.isParked('i1')).toBe(true);
    expect(h.messages.join(' ')).toMatch(/parked/);
    h.db.close();
  });

  it('parks and explains when the pool switched to asking while the switch waited', async () => {
    const h = setup({ kind: 'switch' }, { outcome: 'offered', toProfileId: 'max-b' });
    h.handler.maybePark({ ...base, resetAtHint: Date.now() + 60_000 });
    await h.performDone;
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.handler.isParked('i1')).toBe(true);
    expect(h.messages.join(' ')).toMatch(/Another account is available/);
    h.db.close();
  });

  it('asks the user to resend when the pool switched to asking and parking is off', async () => {
    const h = setup({ kind: 'switch' }, { outcome: 'offered', toProfileId: 'max-b' }, false);
    h.handler.maybePark({ ...base, resetAtHint: Date.now() + 60_000 });
    await h.performDone;
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.handler.isParked('i1')).toBe(false);
    expect(h.messages.join(' ')).toMatch(/send your message again/);
    h.db.close();
  });

  it('neither parks nor re-sends a turn caught by a concurrent switch, and asks the user to send it again', async () => {
    const h = setup({ kind: 'switch' }, { outcome: 'already-moved', toProfileId: 'max-b', turnNotSent: true });
    h.handler.maybePark({ ...base, resetAtHint: Date.now() + 60_000 });
    await h.performDone;
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.handler.isParked('i1')).toBe(false);
    expect(h.messages).toEqual(['This message was not sent because the session was moving to another account at the same time. Send it again.']);
    h.db.close();
  });

  it('tells the user when the switch failed and parking is off', async () => {
    const h = setup({ kind: 'switch' }, { outcome: 'not-switched', reason: 'apply-failed', considered: [] }, false);
    h.handler.maybePark({ ...base, resetAtHint: Date.now() + 60_000 });
    await h.performDone;
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.handler.isParked('i1')).toBe(false);
    expect(h.messages.join(' ')).toMatch(/could not be moved/);
    h.db.close();
  });

  it('parks and offers in ask mode', () => {
    const h = setup({ kind: 'offer', toProfileId: 'max-b' }, { outcome: 'offered', toProfileId: 'max-b' });
    expect(h.handler.maybePark({ ...base, resetAtHint: Date.now() + 60_000 })).toBe('parked');
    expect(h.offered).toEqual(['max-b']);
    h.db.close();
  });

  it('switches before sending when the session account is already known-limited', async () => {
    const h = setup({ kind: 'switch' }, { outcome: 'switched', toProfileId: 'max-b', continuity: 'replay' });
    h.ledger.record({ provider: 'claude', model: null, accountProfileId: 'max-a', detectedAt: Date.now(), resumeAt: Date.now() + 60_000, source: 't', instanceId: null });
    expect(h.handler.maybeParkKnown(base)).toBe('switching-account');
    await h.performDone;
    expect(h.performed).toHaveLength(1);
    // Another account's known limit does not gate this session at all.
    const other = setup({ kind: 'switch' }, { outcome: 'switched', toProfileId: 'max-b', continuity: 'replay' });
    other.ledger.record({ provider: 'claude', model: null, accountProfileId: 'max-z', detectedAt: Date.now(), resumeAt: Date.now() + 60_000, source: 't', instanceId: null });
    expect(other.handler.maybeParkKnown(base)).toBe('skipped');
    h.db.close();
    other.db.close();
  });

  it('drops the coordinator switch state when the instance is released', () => {
    const h = setup({ kind: 'switch' }, { outcome: 'switched', toProfileId: 'max-b', continuity: 'replay' });
    h.handler.release('i1');
    expect(h.released).toEqual(['i1']);
    h.db.close();
  });
});

describe('InstanceProviderLimitHandler stale known-limit gate', () => {
  function gated(snapshot: ProviderQuotaSnapshot | null) {
    const db = new Database(':memory:') as unknown as SqliteDriver;
    createProviderLimitLedgerSchema(db);
    const ledger = new ProviderLimitLedger(db);
    const handler = new InstanceProviderLimitHandler();
    const perform = vi.fn();
    handler.configure({
      isEnabled: () => true,
      setWaitReason: vi.fn(),
      resendInput: vi.fn(),
      getQuotaSnapshot: () => snapshot,
      getWorkspaceCwd: () => '/w',
      scheduleResume: () => () => undefined,
      providerLimitLedger: ledger,
      accountFailover: {
        plan: () => ({ kind: 'none', reason: 'no-candidate' }),
        perform,
        offer: vi.fn(),
        release: vi.fn(),
        shouldSwitchPreemptively: () => false,
      },
    });
    return { handler, ledger, db };
  }

  const codex = { ...base, provider: 'codex' as const, accountProfileId: 'legacy' };
  const toppedUp = (takenAt: number): ProviderQuotaSnapshot => ({
    provider: 'codex', takenAt, source: 'admin-api', ok: true,
    windows: [{ kind: 'rolling-window', id: 'codex.weekly', label: 'Weekly', unit: 'percent', used: 100, limit: 100, remaining: 0, resetsAt: null }],
    usageAccess: { ordinaryUsageAllowed: false, creditsAvailable: true },
  });

  it('sends instead of parking when credits were seen after the limit was recorded, and clears the gate', () => {
    const recordedAt = Date.now() - 10_000;
    const h = gated(toppedUp(recordedAt + 5_000));
    h.ledger.record({ provider: 'codex', model: null, accountProfileId: 'legacy', detectedAt: recordedAt, resumeAt: Date.now() + 86_400_000, source: 't', instanceId: null });
    expect(h.handler.maybeParkKnown(codex)).toBe('skipped');
    expect(h.handler.isParked('i1')).toBe(false);
    expect(h.ledger.getActive({ provider: 'codex', model: null, accountProfileId: 'legacy' })).toBeNull();
    h.db.close();
  });

  it('does not clear a newer model limit that the credits evidence predates', () => {
    const now = Date.now();
    const h = gated(toppedUp(now - 5_000));
    h.ledger.record({ provider: 'codex', model: null, accountProfileId: 'legacy', detectedAt: now - 10_000, resumeAt: now + 86_400_000, source: 't', instanceId: null });
    h.ledger.record({ provider: 'codex', model: 'gpt-6-astra', accountProfileId: 'legacy', detectedAt: now - 1_000, resumeAt: now + 86_400_000, source: 't', instanceId: null });
    expect(h.handler.maybeParkKnown(codex)).toBe('parked');
    expect(h.ledger.getActive({ provider: 'codex', model: 'gpt-6-astra', accountProfileId: 'legacy' })).not.toBeNull();
    h.db.close();
  });

  it('keeps parking when the credits evidence predates the recorded limit', () => {
    const recordedAt = Date.now() - 10_000;
    const h = gated(toppedUp(recordedAt - 1));
    h.ledger.record({ provider: 'codex', model: null, accountProfileId: 'legacy', detectedAt: recordedAt, resumeAt: Date.now() + 86_400_000, source: 't', instanceId: null });
    expect(h.handler.maybeParkKnown(codex)).toBe('parked');
    expect(h.ledger.getActive({ provider: 'codex', model: null, accountProfileId: 'legacy' })).not.toBeNull();
    h.db.close();
  });
});

describe('snapshotShowsLimitLifted', () => {
  const snap = (used: number, usageAccess?: ProviderQuotaSnapshot['usageAccess']): ProviderQuotaSnapshot => ({
    provider: 'codex', takenAt: 1, source: 'admin-api', ok: true,
    windows: [{ kind: 'rolling-window', id: 'codex.weekly', label: 'Weekly', unit: 'percent', used, limit: 100, remaining: 100 - used, resetsAt: null }],
    ...(usageAccess ? { usageAccess } : {}),
  });

  it('lifts on purchased credits only when the caller accepts credits', () => {
    const toppedUp = snap(100, { ordinaryUsageAllowed: false, creditsAvailable: true });
    expect(snapshotShowsLimitLifted(toppedUp)).toBe(false);
    expect(snapshotShowsLimitLifted(toppedUp, { acceptCredits: true })).toBe(true);
  });

  it('follows the provider\'s included-usage verdict over the window numbers', () => {
    expect(snapshotShowsLimitLifted(snap(20, { ordinaryUsageAllowed: false, creditsAvailable: false }))).toBe(false);
    expect(snapshotShowsLimitLifted(snap(100, { ordinaryUsageAllowed: true, creditsAvailable: null }))).toBe(true);
    expect(snapshotShowsLimitLifted(snap(20))).toBe(true);
    expect(snapshotShowsLimitLifted(snap(100))).toBe(false);
  });
});

describe('InstanceProviderLimitHandler pre-emptive live-session switch', () => {
  it('switches before sending when the coordinator says the account is near its limit, and sends once if it cannot', async () => {
    const db = new Database(':memory:') as unknown as SqliteDriver;
    createProviderLimitLedgerSchema(db);
    const handler = new InstanceProviderLimitHandler();
    const resend = vi.fn();
    let resolvePerform!: () => void;
    const performed = new Promise<void>((resolve) => { resolvePerform = resolve; });
    handler.configure({
      isEnabled: () => true,
      setWaitReason: vi.fn(),
      resendInput: resend,
      getQuotaSnapshot: () => null,
      getWorkspaceCwd: () => '/w',
      providerLimitLedger: new ProviderLimitLedger(db),
      accountFailover: {
        plan: () => ({ kind: 'none', reason: 'no-candidate' }),
        perform: async () => {
          resolvePerform();
          return { outcome: 'not-switched', reason: 'busy', considered: [] };
        },
        offer: vi.fn(),
        release: vi.fn(),
        shouldSwitchPreemptively: () => true,
      },
    });
    expect(handler.maybeParkKnown(base)).toBe('switching-account');
    await performed;
    await new Promise((resolve) => setImmediate(resolve));
    expect(resend).toHaveBeenCalledWith('i1', 'continue');
    // The re-sent turn is not held for another pre-emptive attempt.
    expect(handler.maybeParkKnown(base)).toBe('skipped');
    db.close();
  });
});
