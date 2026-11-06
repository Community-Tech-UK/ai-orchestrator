/**
 * Step 7 (A0-H): the one daily helper limit, through the REAL runtime wiring.
 *
 * Every other Step 7 spec builds its own guard with hand-written settings and a
 * hand-written `resolveFallbackModel`, so the four lines that connect the real
 * settings to the real guard were untested. This spec uses the real
 * `initializeLocalAiGuardRuntime` default construction with James's real
 * settings shape (checked read-only, 10 Oct): the fallback budget is empty, the
 * cheap-cloud cap is $2, `defaultCli` is `auto`, and the fallback policy is
 * `notify-and-allow`. Nothing here overrides `resolveFallbackModel`.
 *
 * Each test names the line it guards. Removing that line must fail the test.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeProviderTokenCost } from '../../shared/data/model-pricing';
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types/settings.types';
import type { LocalAiFallbackVerdict } from '../../shared/types/local-ai-guard.types';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabaseWithExport } from '../db/sqlite-wasm-driver';
import { RLM_MIGRATIONS_051_055 } from '../persistence/rlm/rlm-migrations-051-055';
import { RLM_MIGRATIONS_076_080 } from '../persistence/rlm/rlm-migrations-076-080';
import {
  _resetCostAttributionForTesting,
  getCostAttributionFilePath,
  reserveAuxiliarySpend,
} from '../core/system/cost-attribution';
import { getNotificationService, resetNotificationService } from '../notifications/notification-service';
import { AuxiliaryDailySpendCap, type AuxiliarySpendCapRequest } from '../rlm/auxiliary-daily-spend-cap';
import { FALLBACK_HAIKU_MODEL } from './helper-daily-budget';
import { getLocalAiAuxiliaryHooks } from './local-ai-auxiliary-bridge';
import {
  _resetLocalAiGuardRuntimeForTesting,
  initializeLocalAiGuardRuntime,
  type LocalAiGuardRuntime,
  type LocalAiGuardRuntimeOverrides,
} from './local-ai-runtime';

const state = vi.hoisted(() => ({ db: null as unknown as SqliteDriver, settings: {} as AppSettings }));
vi.mock('../persistence/rlm-database', () => ({ getRLMDatabase: () => ({ getRawDb: () => state.db }) }));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => state.settings,
    get: (key: keyof AppSettings) => state.settings[key],
  }),
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/aio-helper-limit-runtime-inert', isPackaged: false },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  Notification: { isSupported: () => false },
  BrowserWindow: { getAllWindows: () => [] },
}));

const LIMIT_NOTICE = 'Helper models: daily limit reached. Paid fallbacks resume tomorrow.';
const NOW = new Date('2026-10-19T12:00:00Z');

/** One million input tokens is $1 at the pinned Haiku rate, so two fit under $2. */
const TITLE_FALLBACK = {
  slot: 'titleGeneration' as const,
  slotAllowsFrontier: true,
  reason: 'helper is down',
  estimatedInputTokens: 1_000_000,
  estimatedOutputTokens: 0,
};
const HAIKU_COST = computeProviderTokenCost('anthropic', FALLBACK_HAIKU_MODEL, {
  inputTokens: TITLE_FALLBACK.estimatedInputTokens,
  outputTokens: TITLE_FALLBACK.estimatedOutputTokens,
}) as number;

const CHEAP_CLOUD_REQUEST: AuxiliarySpendCapRequest = {
  slot: 'compression',
  provider: 'anthropic',
  endpointId: 'endpoint-1',
  model: FALLBACK_HAIKU_MODEL,
  maxOutputTokens: 100_000, // about $0.50
  systemPrompt: 'a'.repeat(400),
  userPrompt: 'b'.repeat(400),
  source: 'cheap-cloud',
};

let directory: string;
let runtime: LocalAiGuardRuntime;

const limitNotices = () => getNotificationService().list().filter((n) => n.body === LIMIT_NOTICE);
const authorize = (): Promise<LocalAiFallbackVerdict> =>
  getLocalAiAuxiliaryHooks().authorizeFallback(TITLE_FALLBACK);
const reasonOf = (verdict: LocalAiFallbackVerdict) =>
  runtime.health.getRoutingEvent(verdict.routingEventId)?.decisionReason;
const costFileLines = () => {
  const file = getCostAttributionFilePath();
  return file && existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
};

/** James's stored shape: no fallback budget, a $2 helper cap, defaultCli auto. */
function useJamesSettings(overrides: Partial<AppSettings> = {}): void {
  state.settings = {
    ...DEFAULT_SETTINGS,
    defaultCli: 'auto',
    localAiGuardDefaultFallbackPolicy: 'notify-and-allow',
    localAiGuardDailyFallbackBudgetUsd: null,
    auxiliaryLlmDailySpendCapUsd: 2,
    localAiGuardConfirmAboveInputTokens: null,
    ...overrides,
  };
  runtime = initializeLocalAiGuardRuntime({
    workers: new EventEmitter() as unknown as NonNullable<LocalAiGuardRuntimeOverrides['workers']>,
    registerCleanup: () => () => undefined,
  });
}

async function waitForPendingApproval() {
  for (let i = 0; i < 20 && runtime.approvals.listPending().length === 0; i += 1) {
    await Promise.resolve();
  }
  const [request] = runtime.approvals.listPending();
  expect(request).toBeDefined();
  return request!;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  directory = mkdtempSync(join(tmpdir(), 'aio-helper-limit-'));
  vi.stubEnv('AIO_COST_ATTRIBUTION', '1');
  vi.stubEnv('AIO_COST_ATTRIBUTION_DIR', directory);
  // No keys, so only the slot decides the price (a title is Haiku class either way).
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', '');
  _resetCostAttributionForTesting();
  state.db = createSqliteWasmDatabaseWithExport().driver;
  state.db.exec(RLM_MIGRATIONS_051_055.find((m) => m.name === '054_local_ai_guard')!.up);
  state.db.exec('ALTER TABLE local_ai_incidents ADD COLUMN unpriced_dispatch_count INTEGER NOT NULL DEFAULT 0;');
  state.db.exec(RLM_MIGRATIONS_076_080.find((m) => m.name === '080_helper_budget_notice_day')!.up);
});

afterEach(() => {
  _resetLocalAiGuardRuntimeForTesting();
  resetNotificationService();
  state.db?.close();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  _resetCostAttributionForTesting();
  vi.useRealTimers();
});

describe('one daily helper limit through the real runtime (Step 7, A0-H)', () => {
  it('the Haiku rate used below is the $1 per million the other tests assume', () => {
    expect(HAIKU_COST).toBeCloseTo(1, 10);
  });

  it('with defaultCli auto a title fallback is priced as Haiku, not left to the chat model [local-ai-runtime resolveFallbackModel]', async () => {
    useJamesSettings();

    const verdict = await authorize();

    expect(verdict).toMatchObject({ allowed: true, disposition: 'allowed' });
    expect(runtime.health.getRoutingEvent(verdict.routingEventId)).toMatchObject({
      provider: 'anthropic',
      model: FALLBACK_HAIKU_MODEL,
      estimatedCostUsd: HAIKU_COST,
    });
  });

  it('blocks the third $1 fallback once $2 is used, with one notice and the chip [settings() auxiliaryLlmDailySpendCapUsd]', async () => {
    useJamesSettings();

    const first = await authorize();
    const second = await authorize();
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(limitNotices()).toHaveLength(0);

    const third = await authorize();
    expect(third).toMatchObject({ allowed: false, disposition: 'blocked', policy: 'block-paid-fallback' });
    expect(reasonOf(third)).toBe('daily-budget');
    expect(limitNotices()).toHaveLength(1);
    expect(runtime.helperBudget).toMatchObject({ resetsAt: Date.parse('2026-10-20T00:00:00Z') });

    await authorize();
    expect(limitNotices()).toHaveLength(1);
  });

  it('an explicit fallback budget still wins over the $2 cap', async () => {
    useJamesSettings({ localAiGuardDailyFallbackBudgetUsd: 1 });

    expect((await authorize()).allowed).toBe(true);
    expect((await authorize()).allowed).toBe(false);
  });

  it('with no fallback budget and no cap nothing is limited', async () => {
    useJamesSettings({ auxiliaryLlmDailySpendCapUsd: null });

    for (let i = 0; i < 4; i += 1) expect((await authorize()).allowed).toBe(true);
    expect(limitNotices()).toHaveLength(0);
  });

  it('cheap-cloud reservations shrink the fallback ceiling through the real cost file [globalDailyBudgetUsd, routing guard sharedFallbackLimit]', async () => {
    useJamesSettings();
    expect(reserveAuxiliarySpend({
      capUsd: 2, amountUsd: 1.5, slot: 'compression', provider: 'anthropic', model: FALLBACK_HAIKU_MODEL,
    }).allowed).toBe(true);

    // $1.50 reserved leaves $0.50 of the $2: a $1 fallback no longer fits.
    const verdict = await authorize();

    expect(verdict).toMatchObject({ allowed: false, disposition: 'blocked' });
    expect(reasonOf(verdict)).toBe('daily-budget');
    expect(limitNotices()).toHaveLength(1);
  });

  it('a confirmation approved after cheap-cloud spend filled the limit is refused at approval time [local-ai-runtime globalDailyBudgetUsd]', async () => {
    useJamesSettings({ localAiGuardDefaultFallbackPolicy: 'require-confirmation' });
    const pending = authorize();
    const request = await waitForPendingApproval();

    // The limit is filled while the question is on screen.
    expect(reserveAuxiliarySpend({
      capUsd: 2, amountUsd: 1.5, slot: 'compression', provider: 'anthropic', model: FALLBACK_HAIKU_MODEL,
    }).allowed).toBe(true);
    runtime.approvals.resolve(request.id, 'allow-once');

    const verdict = await pending;
    expect(verdict).toMatchObject({ allowed: false, disposition: 'blocked' });
    expect(reasonOf(verdict)).toBe('daily-budget');
    expect(limitNotices()).toHaveLength(1);
  });
});

describe('manual compaction through runtime confirmation', () => {
  const manual = { ...TITLE_FALLBACK, slot: 'compression' as const, userInitiated: true,
    intendedProvider: 'anthropic', intendedModel: FALLBACK_HAIKU_MODEL };

  it.each([0, 2])('retains the explicit-action exemption after consent with a $%s cap', async cap => {
    useJamesSettings({ auxiliaryLlmDailySpendCapUsd: cap, localAiGuardDefaultFallbackPolicy: 'require-confirmation' });
    const pending = getLocalAiAuxiliaryHooks().authorizeFallback(manual);
    const request = await waitForPendingApproval();
    expect(runtime.approvals.resolve(request.id, 'allow-once').resolution).toBe('allow-once');
    const verdict = await pending;
    expect(verdict).toMatchObject({ allowed: true, disposition: 'allowed' });
    expect(runtime.health.getRoutingEvent(verdict.routingEventId)).toMatchObject({ estimatedCostUsd: HAIKU_COST });
    expect(limitNotices()).toHaveLength(0);
  });

  it('still requires consent and honors a refusal at a zero helper cap', async () => {
    useJamesSettings({ auxiliaryLlmDailySpendCapUsd: 0, localAiGuardDefaultFallbackPolicy: 'require-confirmation' });
    const pending = getLocalAiAuxiliaryHooks().authorizeFallback(manual);
    const request = await waitForPendingApproval();
    runtime.approvals.resolve(request.id, 'block');
    expect(await pending).toMatchObject({ allowed: false, disposition: 'blocked' });
  });

  it('automatic compression still stops at a zero helper cap without asking', async () => {
    useJamesSettings({ auxiliaryLlmDailySpendCapUsd: 0, localAiGuardDefaultFallbackPolicy: 'require-confirmation' });
    expect(await getLocalAiAuxiliaryHooks().authorizeFallback({ ...manual, userInitiated: false }))
      .toMatchObject({ allowed: false, disposition: 'blocked' });
    expect(runtime.approvals.listPending()).toEqual([]);
  });

  it.each(['dailyFallbackBudgetUsd', 'incidentFallbackBudgetUsd'] as const)(
    'rechecks the %s limit after manual confirmation', async limit => {
      useJamesSettings({ auxiliaryLlmDailySpendCapUsd: 0, localAiGuardDefaultFallbackPolicy: 'require-confirmation' });
      const target = runtime.targets.create({
        lifecycle: 'paused', location: { type: 'coordinator' }, provider: 'ollama', endpointId: 'fixture',
        baseUrl: 'http://127.0.0.1:11434', expectedModels: [{ modelId: 'fixture', required: true }],
        canary: { model: 'fixture', timeoutMs: 30000, intervalMs: 600000 }, endpointCheckIntervalMs: 60000,
        freshnessLimitMs: 120000, warningLatencyMs: 2000, routingRoles: ['compression'],
        fallbackPolicy: 'require-confirmation', slotFallbackPolicies: {}, [limit]: 2,
        recovery: { automatic: false, maxAttempts: 2, cooldownMs: 60000 },
      });
      if (limit === 'incidentFallbackBudgetUsd') runtime.health.upsertIncident({ kind: 'open-or-update', incident: {
        id: 'fixture-incident', targetId: target.id, state: 'open', severity: 'warning', failureCode: 'connection-refused',
        affectedLayers: ['endpoint'], affectedRoles: ['compression'], openedAt: Date.now(), updatedAt: Date.now(),
        fallbackCount: 0, knownCostUsd: 0, estimatedCostUsd: 0, unpricedDispatchCount: 0,
      } });
      const pending = getLocalAiAuxiliaryHooks().authorizeFallback({ ...manual, intendedTargetId: target.id });
      const request = await waitForPendingApproval();
      runtime.targets.update(target.id, { [limit]: 0 });
      expect(runtime.approvals.resolve(request.id, 'allow-once').resolution).toBe('block');
      expect(await pending).toMatchObject({ allowed: false, disposition: 'blocked' });
    },
  );

  it('a manual action cannot override the slot prohibition on paid models', async () => {
    useJamesSettings({ auxiliaryLlmDailySpendCapUsd: 0, localAiGuardDefaultFallbackPolicy: 'require-confirmation' });
    expect(await getLocalAiAuxiliaryHooks().authorizeFallback({ ...manual, slotAllowsFrontier: false }))
      .toMatchObject({ allowed: false, disposition: 'blocked' });
    expect(runtime.approvals.listPending()).toEqual([]);
  });
});

describe('fallback spend binds the cheap-cloud cap through the installed hook (Step 7, A0-H)', () => {
  it('a cheap-cloud reservation is refused once paid fallbacks used the limit [local-ai-auxiliary-bridge fallbackSpendTodayUsd]', async () => {
    useJamesSettings();
    const hooks = getLocalAiAuxiliaryHooks();
    expect(hooks.fallbackSpendTodayUsd?.()).toBe(0);
    await authorize();
    await authorize();
    expect(hooks.fallbackSpendTodayUsd?.()).toBeCloseTo(2, 10);
    const cap = new AuxiliaryDailySpendCap();
    cap.configure(2);

    const reason = cap.reserve(CHEAP_CLOUD_REQUEST);

    expect(reason).toContain('daily spend cap');
    expect(costFileLines()).toHaveLength(0);
    expect(limitNotices()).toHaveLength(1);
  });

  it('the same reservation is allowed when no paid fallback has been used (control)', () => {
    useJamesSettings();
    const cap = new AuxiliaryDailySpendCap();
    cap.configure(2);

    expect(cap.reserve(CHEAP_CLOUD_REQUEST)).toBeNull();
    expect(costFileLines()).toHaveLength(1);
    expect(limitNotices()).toHaveLength(0);
  });
});

describe('an unreadable reservation file is unknown spend (Step 7, A0-H; round 4 V3)', () => {
  /** A directory where today's file should be: it exists, but cannot be read. */
  function makeReservationFileUnreadable(): void {
    mkdirSync(getCostAttributionFilePath()!);
  }

  it('refuses a paid fallback and does not claim the limit was reached', async () => {
    useJamesSettings();
    makeReservationFileUnreadable();

    const verdict = await authorize();

    expect(verdict).toMatchObject({ allowed: false, disposition: 'blocked' });
    expect(limitNotices()).toHaveLength(0);
    expect(runtime.helperBudget).toBeUndefined();
  });

  it('gives no extra headroom to a confirmation approved while the file is unreadable', async () => {
    useJamesSettings({ localAiGuardDefaultFallbackPolicy: 'require-confirmation' });
    const pending = authorize();
    const request = await waitForPendingApproval();
    makeReservationFileUnreadable();

    runtime.approvals.resolve(request.id, 'allow-once');

    expect(await pending).toMatchObject({ allowed: false, disposition: 'blocked' });
    expect(limitNotices()).toHaveLength(0);
  });

  it('still refuses a cheap-cloud reservation without a limit notice', () => {
    useJamesSettings();
    makeReservationFileUnreadable();
    const cap = new AuxiliaryDailySpendCap();
    cap.configure(2);

    expect(cap.reserve(CHEAP_CLOUD_REQUEST)).toContain('daily spend cap');
    expect(limitNotices()).toHaveLength(0);
  });

  it('recovers the moment the file is readable again', async () => {
    useJamesSettings();
    makeReservationFileUnreadable();
    expect((await authorize()).allowed).toBe(false);
    rmSync(getCostAttributionFilePath()!, { recursive: true });

    expect((await authorize()).allowed).toBe(true);
  });
});
