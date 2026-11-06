import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  fallbackSpendUsd: 0,
  allowed: true,
  attempts: [] as { capUsd: number; amountUsd: number }[],
  reserved: [] as { amountUsd: number }[],
}));

vi.mock('../core/system/cost-attribution', () => ({
  reserveAuxiliarySpend: vi.fn((reservation: { capUsd: number; amountUsd: number }) => {
    state.attempts.push({ capUsd: reservation.capUsd, amountUsd: reservation.amountUsd });
    const spentUsd = state.reserved.reduce((sum, item) => sum + item.amountUsd, 0);
    const allowed = state.allowed && spentUsd + reservation.amountUsd <= reservation.capUsd;
    if (allowed) state.reserved.push({ amountUsd: reservation.amountUsd });
    return { allowed, spentUsd };
  }),
  getReservedAuxiliarySpendToday: vi.fn(
    () => state.reserved.reduce((sum, item) => sum + item.amountUsd, 0),
  ),
}));
vi.mock('./token-counter', () => ({
  getTokenCounter: () => ({ countTokens: (text: string) => text.length }),
}));

import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import {
  __resetLocalAiAuxiliaryHooksForTesting,
  __setLocalAiAuxiliaryHooksForTesting,
  type LocalAiAuxiliaryHooks,
} from '../local-ai-guard/local-ai-auxiliary-bridge';
import { LocalAiHealthRepository } from '../local-ai-guard/local-ai-health-repository';
import { LocalAiRoutingGuard } from '../local-ai-guard/local-ai-routing-guard';
import { RLM_MIGRATIONS_051_055 } from '../persistence/rlm/rlm-migrations-051-055';
import { AuxiliaryDailySpendCap, type AuxiliarySpendCapRequest } from './auxiliary-daily-spend-cap';

// 1,000 + 1,000 prompt characters count as 2,000 input tokens (mocked counter).
// Haiku is $1 per million input and $5 per million output, so the output budget
// sets the reservation: 100,000 tokens is about $0.50, 60,000 about $0.30.
const request: AuxiliarySpendCapRequest = {
  slot: 'titleGeneration',
  provider: 'anthropic',
  endpointId: 'endpoint-1',
  model: 'claude-haiku-4-6-20260401',
  maxOutputTokens: 100_000,
  systemPrompt: 'a'.repeat(1_000),
  userPrompt: 'b'.repeat(1_000),
  source: 'cheap-cloud',
};

const NOW = Date.UTC(2026, 9, 19, 12);

function hooks(overrides: Partial<LocalAiAuxiliaryHooks> = {}): LocalAiAuxiliaryHooks {
  return {
    findTarget: () => undefined,
    evaluateLocalTarget: async () => ({ eligible: true, reason: 'unmanaged-compatibility' }),
    acquireTarget: () => () => undefined,
    invalidateTarget: () => undefined,
    authorizeFallback: async () => ({
      allowed: true, disposition: 'allowed', policy: 'allow-silently', routingEventId: 'x',
    }),
    markFallbackDispatched: () => undefined,
    recordLocalCompletion: () => undefined,
    fallbackSpendTodayUsd: () => state.fallbackSpendUsd,
    ...overrides,
  };
}

describe('AuxiliaryDailySpendCap shared daily limit (Step 7, A0-H)', () => {
  beforeEach(() => {
    state.fallbackSpendUsd = 0;
    state.allowed = true;
    state.attempts = [];
    state.reserved = [];
    __setLocalAiAuxiliaryHooksForTesting(hooks());
  });

  afterEach(() => {
    __resetLocalAiAuxiliaryHooksForTesting();
  });

  it('a cheap-cloud reservation is denied once fallback spend has used the limit', () => {
    const exceeded = vi.fn();
    __setLocalAiAuxiliaryHooksForTesting(hooks({ helperBudgetExceeded: exceeded }));
    const cap = new AuxiliaryDailySpendCap();
    cap.configure(2);
    state.fallbackSpendUsd = 2;

    const reason = cap.reserve(request);

    expect(reason).toContain('daily spend cap');
    expect(state.attempts[0]?.capUsd).toBe(0);
    expect(state.reserved).toHaveLength(0);
    expect(exceeded).toHaveBeenCalledTimes(1);
  });

  it('fallback spend reduces the cheap-cloud ceiling but does not block below the limit', () => {
    const cap = new AuxiliaryDailySpendCap();
    cap.configure(2);
    state.fallbackSpendUsd = 1.5;

    // The reservation is about $0.40, which fits in the $0.50 left of $2 after $1.50.
    expect(cap.reserve({ ...request, maxOutputTokens: 80_000 })).toBeNull();
    expect(state.attempts[0]?.capUsd).toBeCloseTo(0.5, 10);
    // The same call again is denied: $0.40 plus the $0.40 already reserved is over $0.50.
    expect(cap.reserve({ ...request, maxOutputTokens: 80_000 })).toContain('daily spend cap');
  });

  it('never reserves against a negative ceiling when fallback spend passed the limit', () => {
    const cap = new AuxiliaryDailySpendCap();
    cap.configure(2);
    state.fallbackSpendUsd = 5;

    expect(cap.reserve(request)).toContain('daily spend cap');
    expect(state.attempts[0]?.capUsd).toBe(0);
  });

  it('fallback spend does not matter when no cap is set', () => {
    const cap = new AuxiliaryDailySpendCap();
    state.fallbackSpendUsd = 99;

    expect(cap.reserve(request)).toBeNull();
    expect(state.attempts).toHaveLength(0);
  });

  it('local calls are never capped', () => {
    const cap = new AuxiliaryDailySpendCap();
    cap.configure(0);

    expect(cap.reserve({ ...request, source: 'local' })).toBeNull();
    expect(state.attempts).toHaveLength(0);
  });

  it('Step 7 item 5: a user-initiated cheap-cloud call is not refused at the limit, and its reservation is still recorded', () => {
    const exceeded = vi.fn();
    __setLocalAiAuxiliaryHooksForTesting(hooks({ helperBudgetExceeded: exceeded }));
    const cap = new AuxiliaryDailySpendCap();
    cap.configure(2);
    state.fallbackSpendUsd = 2;

    expect(cap.reserve({ ...request, userInitiated: true })).toBeNull();
    // The day's spend stays truthful: the call is recorded, just never refused.
    expect(state.reserved).toHaveLength(1);
    expect(state.reserved[0]!.amountUsd).toBeGreaterThan(0.4);
    expect(exceeded).not.toHaveBeenCalled();
    // An automatic call right after still sees the limit as used up.
    expect(cap.reserve(request)).toContain('daily spend cap');
    expect(state.reserved).toHaveLength(1);
  });

  it('Step 7 item 5: a user-initiated call to a model with no known price is allowed rather than refused', () => {
    const cap = new AuxiliaryDailySpendCap();
    cap.configure(2);

    expect(cap.reserve({ ...request, model: 'private-model', userInitiated: true })).toBeNull();
    expect(cap.reserve({ ...request, model: 'private-model' })).toContain('no known price');
  });

  it('a refused reservation store alone does not claim the shared limit was reached', () => {
    const exceeded = vi.fn();
    __setLocalAiAuxiliaryHooksForTesting(hooks({ helperBudgetExceeded: exceeded }));
    const cap = new AuxiliaryDailySpendCap();
    cap.configure(100);
    state.allowed = false;

    expect(cap.reserve(request)).toContain('daily spend cap');
    expect(exceeded).not.toHaveBeenCalled();
  });

  it('an unreadable fallback ledger refuses the call without claiming the limit was reached', () => {
    const exceeded = vi.fn();
    __setLocalAiAuxiliaryHooksForTesting(hooks({ helperBudgetExceeded: exceeded }));
    const cap = new AuxiliaryDailySpendCap();
    cap.configure(100);
    state.fallbackSpendUsd = Number.POSITIVE_INFINITY;

    expect(cap.reserve(request)).toContain('could not be read');
    expect(state.attempts).toHaveLength(0);
    expect(exceeded).not.toHaveBeenCalled();
  });
});

describe('the two helper ledgers subtract each other (Step 7, A0-H)', () => {
  const dbs: SqliteDriver[] = [];

  function guardWithFallbackRows(limitUsd: number, fallbackRung: { fixedCostUsd: number }) {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    db.exec('PRAGMA foreign_keys = ON;');
    const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
    if (!migration) throw new Error('Missing migration 054_local_ai_guard');
    db.exec(migration.up);
    db.exec('ALTER TABLE local_ai_incidents ADD COLUMN unpriced_dispatch_count INTEGER NOT NULL DEFAULT 0;');
    const health = new LocalAiHealthRepository(db, undefined, () => NOW);
    let id = 0;
    const guard = new LocalAiRoutingGuard({
      targets: { get: () => undefined },
      scheduler: { getStatus: () => undefined, ensureFresh: async () => { throw new Error('unused'); } },
      health,
      approvals: { request: async () => 'block', listPending: () => [] } as never,
      settings: () => ({
        localAiGuardDefaultFallbackPolicy: 'allow-silently',
        localAiGuardDailyFallbackBudgetUsd: null,
        auxiliaryLlmDailySpendCapUsd: limitUsd,
        localAiGuardConfirmAboveInputTokens: null,
      }),
      resolveFallbackModel: () => ({ provider: 'test', model: 'fixed', ...fallbackRung }),
      now: () => NOW,
      createId: () => `routing-${id += 1}`,
    });
    return { guard, health };
  }

  function recordPaidFallback(health: LocalAiHealthRepository, knownCostUsd: number): void {
    health.appendRoutingEvent({
      id: 'paid-fallback-1',
      slot: 'compression',
      intendedRoute: 'local',
      actualRoute: 'frontier',
      policy: 'allow-silently',
      disposition: 'allowed',
      decisionReason: 'policy',
      inputTokens: 1_000,
      outputTokens: 100,
      knownCostUsd,
      createdAt: NOW - 60_000,
      completedAt: NOW - 59_000,
    });
  }

  const fallbackInput = {
    slot: 'compression' as const,
    reason: 'helper is down',
    estimatedInputTokens: 1_000,
    estimatedOutputTokens: 100,
    slotAllowsFrontier: true,
  };

  beforeEach(() => {
    state.fallbackSpendUsd = 0;
    state.allowed = true;
    state.attempts = [];
    state.reserved = [];
  });

  afterEach(() => {
    __resetLocalAiAuxiliaryHooksForTesting();
    for (const db of dbs.splice(0)) db.close();
  });

  it('cheap-cloud reservations shrink the fallback ceiling and fallback spend shrinks the cheap-cloud cap', async () => {
    // One $1 limit shared by both ledgers.
    const { guard, health } = guardWithFallbackRows(1, { fixedCostUsd: 0.2 });
    __setLocalAiAuxiliaryHooksForTesting(hooks({ fallbackSpendTodayUsd: () => guard.fallbackSpendTodayUsd() }));
    const cap = new AuxiliaryDailySpendCap();
    cap.configure(1);

    // $0.60 already spent on paid fallbacks: the cheap-cloud side sees $0.40.
    recordPaidFallback(health, 0.6);
    expect(guard.fallbackSpendTodayUsd()).toBeCloseTo(0.6, 10);
    expect(cap.reserve(request)).toContain('daily spend cap'); // about $0.50 > $0.40
    expect(state.attempts[0]?.capUsd).toBeCloseTo(0.4, 10);
    expect(cap.reserve({ ...request, maxOutputTokens: 60_000 })).toBeNull(); // about $0.30
    expect(state.reserved).toHaveLength(1);

    // $0.30 is now reserved on the cheap-cloud side. The fallback side sees
    // $1 - $0.30 = $0.70, and already holds $0.60, so a $0.20 estimate would
    // reach $0.80 and is refused.
    const blocked = await guard.authorizeFallback(fallbackInput);
    expect(blocked).toMatchObject({ allowed: false, disposition: 'blocked' });
    expect(health.getRoutingEvent(blocked.routingEventId)).toMatchObject({
      decisionReason: 'daily-budget',
    });
  });

  it('a fallback that still fits under the shared limit is allowed', async () => {
    const { guard, health } = guardWithFallbackRows(1, { fixedCostUsd: 0.05 });
    __setLocalAiAuxiliaryHooksForTesting(hooks({ fallbackSpendTodayUsd: () => guard.fallbackSpendTodayUsd() }));
    const cap = new AuxiliaryDailySpendCap();
    cap.configure(1);
    recordPaidFallback(health, 0.6);
    expect(cap.reserve({ ...request, maxOutputTokens: 60_000 })).toBeNull(); // about $0.30

    // $0.60 + $0.30 + $0.05 is $0.95, under the $1 limit.
    await expect(guard.authorizeFallback(fallbackInput)).resolves.toMatchObject({
      allowed: true, disposition: 'allowed',
    });
  });
});
