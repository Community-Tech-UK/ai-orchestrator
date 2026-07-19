import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import {
  createMigrationsTable,
  createTables,
  runMigrations,
} from '../persistence/rlm/rlm-schema';
import { AutomationStore } from './automation-store';
import type { AutomationAttachmentService } from './automation-attachment-service';
import {
  createAutomationToolImplementations,
  type AutomationToolImplDeps,
  type AutomationToolImplementations,
} from './automation-tool-impl';
import type { Automation, CreateAutomationInput } from '../../shared/types/automation.types';

function createDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  db.pragma('foreign_keys = ON');
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

function fakeAttachmentService(): AutomationAttachmentService {
  return {
    prepare: async () => [],
    replacePrepared: () => undefined,
    listForAutomation: async () => [],
  } as unknown as AutomationAttachmentService;
}

const NOW = 1_700_000_000_000; // fixed clock for deterministic scheduling
const HOUR = 3_600_000;
const MINUTE = 60_000;

describe('createAutomationToolImplementations', () => {
  let db: SqliteDriver;
  let store: AutomationStore;
  let scheduler: { schedule: ReturnType<typeof vi.fn>; deactivate: ReturnType<typeof vi.fn> };
  let runner: { untrackInstances: ReturnType<typeof vi.fn> };
  let events: { emitChanged: ReturnType<typeof vi.fn> };
  let handlePastOneTime: ReturnType<typeof vi.fn>;
  let createWithScheduling: ReturnType<typeof vi.fn>;
  let impls: AutomationToolImplementations;

  function makeImpls(overrides: Partial<AutomationToolImplDeps> = {}): AutomationToolImplementations {
    return createAutomationToolImplementations({
      store,
      scheduler,
      runner,
      events,
      createWithScheduling,
      handlePastOneTime,
      resolveWorkingDirectory: () => '/repo',
      resolveTimezone: () => 'UTC',
      now: () => NOW,
      ...overrides,
    });
  }

  async function seed(
    partial: Partial<CreateAutomationInput> & { nextFireAt?: number | null } = {},
  ): Promise<Automation> {
    const { nextFireAt, ...input } = partial;
    return store.create(
      {
        name: input.name ?? 'Daily check',
        description: input.description,
        enabled: input.enabled ?? true,
        schedule: input.schedule ?? { type: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
        missedRunPolicy: input.missedRunPolicy ?? 'notify',
        concurrencyPolicy: input.concurrencyPolicy ?? 'skip',
        action: input.action ?? { prompt: 'Check status', workingDirectory: '/repo' },
      },
      nextFireAt ?? NOW + HOUR,
      NOW,
    );
  }

  beforeEach(() => {
    db = createDb();
    store = new AutomationStore(db, fakeAttachmentService());
    scheduler = { schedule: vi.fn(), deactivate: vi.fn() };
    runner = { untrackInstances: vi.fn() };
    events = { emitChanged: vi.fn() };
    handlePastOneTime = vi.fn(async () => undefined);
    createWithScheduling = vi.fn(async (input: CreateAutomationInput) =>
      store.create(input, NOW + HOUR, NOW),
    );
    impls = makeImpls();
  });

  afterEach(() => {
    db.close();
  });

  describe('deleteAutomation', () => {
    it('removes the automation and tears down its schedule', async () => {
      const automation = await seed({ name: 'Nightly sweep' });

      const result = await impls.deleteAutomation({ id: automation.id });

      expect(result).toEqual({
        id: automation.id,
        name: 'Nightly sweep',
        deleted: true,
        detachedInstanceIds: [],
      });
      expect(await store.get(automation.id)).toBeNull();
      expect(scheduler.deactivate).toHaveBeenCalledWith(automation.id);
      expect(runner.untrackInstances).toHaveBeenCalledWith([]);
      expect(events.emitChanged).toHaveBeenCalledWith({
        automation: null,
        automationId: automation.id,
        type: 'deleted',
      });
    });

    it('throws when the automation does not exist', async () => {
      await expect(impls.deleteAutomation({ id: 'missing' })).rejects.toThrow(/not found/);
      expect(scheduler.deactivate).not.toHaveBeenCalled();
    });
  });

  describe('updateAutomation', () => {
    it('disables an automation and clears its next fire time', async () => {
      const automation = await seed();

      const result = await impls.updateAutomation({ id: automation.id, enabled: false });

      const persisted = await store.get(automation.id);
      expect(persisted?.enabled).toBe(false);
      expect(persisted?.nextFireAt).toBeNull();
      expect(result.enabled).toBe(false);
      expect(scheduler.schedule).toHaveBeenCalledOnce();
      expect(events.emitChanged).toHaveBeenCalledWith(
        expect.objectContaining({ automationId: automation.id, type: 'updated' }),
      );
    });

    it('persists prompt, provider, model, reasoningEffort, yoloMode and policy changes', async () => {
      const automation = await seed();

      await impls.updateAutomation({
        id: automation.id,
        prompt: 'New prompt',
        provider: 'codex',
        model: 'gpt-5.5',
        reasoningEffort: 'high',
        yoloMode: true,
        missedRunPolicy: 'runOnce',
        concurrencyPolicy: 'queue',
      });

      const persisted = await store.get(automation.id);
      expect(persisted?.action).toMatchObject({
        prompt: 'New prompt',
        provider: 'codex',
        model: 'gpt-5.5',
        reasoningEffort: 'high',
        yoloMode: true,
      });
      expect(persisted?.missedRunPolicy).toBe('runOnce');
      expect(persisted?.concurrencyPolicy).toBe('queue');
      // Working directory was untouched.
      expect(persisted?.action.workingDirectory).toBe('/repo');
    });

    it('recomputes the next fire time when the cron schedule changes', async () => {
      const automation = await seed({ nextFireAt: NOW + HOUR });

      await impls.updateAutomation({ id: automation.id, cron: '*/15 * * * *' });

      const persisted = await store.get(automation.id);
      expect(persisted?.schedule).toMatchObject({ type: 'cron', expression: '*/15 * * * *' });
      expect(persisted?.nextFireAt).not.toBeNull();
      expect(persisted!.nextFireAt!).toBeGreaterThan(NOW);
    });

    it('settles a now-past one-time schedule via handlePastOneTime', async () => {
      const automation = await seed({
        schedule: { type: 'oneTime', runAt: NOW + HOUR, timezone: 'UTC' },
      });

      await impls.updateAutomation({ id: automation.id, prompt: 'tweak' });

      expect(handlePastOneTime).toHaveBeenCalledOnce();
    });

    it('throws when the automation does not exist', async () => {
      await expect(
        impls.updateAutomation({ id: 'missing', enabled: false }),
      ).rejects.toThrow(/not found/);
    });
  });

  describe('postponeAutomation', () => {
    it('pushes a recurring automation forward by delayMinutes without changing its cron', async () => {
      const automation = await seed({ nextFireAt: NOW + HOUR });

      const result = await impls.postponeAutomation({ id: automation.id, delayMinutes: 30 });

      const persisted = await store.get(automation.id);
      expect(persisted?.nextFireAt).toBe(NOW + HOUR + 30 * MINUTE);
      expect(persisted?.schedule).toMatchObject({ type: 'cron', expression: '0 9 * * *' });
      expect(result.nextRunAt).toBe(NOW + HOUR + 30 * MINUTE);
      expect(scheduler.schedule).toHaveBeenCalledOnce();
      expect(events.emitChanged).toHaveBeenCalledWith(
        expect.objectContaining({ automationId: automation.id, type: 'updated' }),
      );
    });

    it('reschedules a one-time automation to an absolute untilIso time', async () => {
      const automation = await seed({
        schedule: { type: 'oneTime', runAt: NOW + HOUR, timezone: 'UTC' },
        nextFireAt: NOW + HOUR,
      });
      const until = new Date(NOW + 5 * HOUR).toISOString();

      await impls.postponeAutomation({ id: automation.id, untilIso: until });

      const persisted = await store.get(automation.id);
      expect(persisted?.schedule).toMatchObject({ type: 'oneTime', runAt: NOW + 5 * HOUR });
      expect(persisted?.nextFireAt).toBe(NOW + 5 * HOUR);
    });

    it('rejects postponing a disabled automation', async () => {
      const automation = await seed({ enabled: false, nextFireAt: null });

      await expect(
        impls.postponeAutomation({ id: automation.id, delayMinutes: 30 }),
      ).rejects.toThrow(/disabled\/inactive/);
      expect(scheduler.schedule).not.toHaveBeenCalled();
    });

    it('rejects an untilIso in the past', async () => {
      const automation = await seed();
      const past = new Date(NOW - HOUR).toISOString();

      await expect(
        impls.postponeAutomation({ id: automation.id, untilIso: past }),
      ).rejects.toThrow(/future/);
    });
  });

  describe('createAutomation', () => {
    it('builds a cron schedule and routes through the create+schedule service', async () => {
      const result = await impls.createAutomation(
        { name: 'PR sweep', prompt: 'Review PRs', cron: '0 9 * * 1-5' },
        { callerInstanceId: 'chat-1' },
      );

      expect(createWithScheduling).toHaveBeenCalledOnce();
      const input = createWithScheduling.mock.calls[0]?.[0] as CreateAutomationInput;
      expect(input.schedule).toMatchObject({ type: 'cron', expression: '0 9 * * 1-5' });
      expect(input.action.workingDirectory).toBe('/repo');
      expect(result).toMatchObject({ name: 'PR sweep', workingDirectory: '/repo' });
    });

    it('rejects when no working directory can be resolved', async () => {
      const noCwd = makeImpls({ resolveWorkingDirectory: () => undefined });

      await expect(
        noCwd.createAutomation({ name: 'X', prompt: 'do', cron: '0 9 * * *' }, undefined),
      ).rejects.toThrow(/workingDirectory/);
    });

    it('reuses an equivalent active automation instead of creating a duplicate', async () => {
      const first = await impls.createAutomation(
        { name: 'Realer server hourly watch', prompt: 'Check server', cron: '0 * * * *' },
        { callerInstanceId: 'chat-1' },
      );
      createWithScheduling.mockClear();

      // Same workspace + schedule + prompt, only the name reworded.
      const second = await impls.createAutomation(
        { name: 'Realer Minecraft hourly server watch', prompt: 'Check server', cron: '0 * * * *' },
        { callerInstanceId: 'chat-1' },
      );

      expect(second.id).toBe(first.id);
      expect(second.reused).toBe(true);
      expect(createWithScheduling).not.toHaveBeenCalled();
      expect((await store.list()).length).toBe(1);
    });

    it('creates a distinct automation when the prompt differs', async () => {
      await impls.createAutomation(
        { name: 'A', prompt: 'Check server', cron: '0 * * * *' },
        { callerInstanceId: 'chat-1' },
      );
      createWithScheduling.mockClear();

      const second = await impls.createAutomation(
        { name: 'B', prompt: 'A genuinely different task', cron: '0 * * * *' },
        { callerInstanceId: 'chat-1' },
      );

      expect(second.reused).toBeUndefined();
      expect(createWithScheduling).toHaveBeenCalledOnce();
      expect((await store.list()).length).toBe(2);
    });

    it('creates a distinct automation when the provider differs', async () => {
      await impls.createAutomation(
        { name: 'A', prompt: 'Check server', cron: '0 * * * *' },
        { callerInstanceId: 'chat-1' },
      );
      createWithScheduling.mockClear();

      const second = await impls.createAutomation(
        { name: 'A', prompt: 'Check server', cron: '0 * * * *', provider: 'codex' },
        { callerInstanceId: 'chat-1' },
      );

      expect(second.reused).toBeUndefined();
      expect(createWithScheduling).toHaveBeenCalledOnce();
      expect((await store.list()).length).toBe(2);
    });
  });

  describe('listAutomations', () => {
    it('summarizes stored automations', async () => {
      await seed({ name: 'A' });
      await seed({ name: 'B', schedule: { type: 'oneTime', runAt: NOW + HOUR, timezone: 'UTC' } });

      const result = await impls.listAutomations();

      expect(result.count).toBe(2);
      expect(result.automations.map((a) => a.name).sort()).toEqual(['A', 'B']);
    });
  });
});
