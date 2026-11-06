import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationCreatePayloadSchema, AutomationRunChangedEventSchema } from '@contracts/schemas/automation';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { AutomationRun, ClaimedAutomationRun } from '../../shared/types/automation.types';
import { createSqliteWasmDatabase } from '../db/sqlite-wasm-driver';
import { createTables, createMigrationsTable, runMigrations } from '../persistence/rlm/rlm-schema';
import { MainEventBus } from '../event-bus/main-event-bus';
import { ElectronWindowTransport } from '../event-bus/electron-window-transport';
import { AutomationAttachmentService } from './automation-attachment-service';
import { AutomationStore } from './automation-store';
import { AutomationCheckStore, _resetAutomationCheckStoreForTesting } from './automation-check-store';
import { runAutomationPreCheckGate } from './automation-pre-check-gate';
import { hashCheckOutput } from './automation-pre-check';

const state = vi.hoisted(() => ({ directory: '', db: null as SqliteDriver | null }));
vi.mock('electron', () => ({ app: { getPath: () => state.directory } }));
vi.mock('../persistence/rlm-database', () => ({ getRLMDatabase: () => ({ getRawDb: () => {
  if (!state.db) throw new Error('Fixture database not initialized');
  return state.db;
} }) }));
// No attachments are present; keep the unrelated content-store singleton inert.
vi.mock('../session/content-store', () => ({ getContentStore: () => ({}) }));
vi.mock('../notifications/notification-service', () => ({ getNotificationService: () => ({ notify: vi.fn() }) }));

let db: SqliteDriver;
let store: AutomationStore;
let checks: AutomationCheckStore;
beforeEach(() => {
  state.directory = mkdtempSync(join(tmpdir(), 'aio-runtime-prompt-'));
  db = createSqliteWasmDatabase(':memory:');
  state.db = db;
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  store = new AutomationStore(db, new AutomationAttachmentService(db));
  checks = new AutomationCheckStore(db);
  _resetAutomationCheckStoreForTesting();
});
afterEach(() => {
  _resetAutomationCheckStoreForTesting();
  state.db = null;
  db?.close();
  rmSync(state.directory, { recursive: true, force: true });
});

function deliver(run: AutomationRun): AutomationRun {
  const received: unknown[] = [];
  const bus = new MainEventBus();
  bus.addTransport(new ElectronWindowTransport(() => ({ send: (channel, payload) => { if (channel === 'automation:run-changed') received.push(structuredClone(payload)); } })));
  bus.emitRendererEvent('automation:run-changed', { automationId: run.automationId, run });
  expect(received).toHaveLength(1);
  expect(AutomationRunChangedEventSchema.safeParse({ automationId: run.automationId, run, extra: true }).success).toBe(false);
  return AutomationRunChangedEventSchema.parse(received[0]).run;
}

describe('persisted automation runtime prompts cross the renderer boundary intact', () => {
  it.each(['first-check', 'changed', 'check-failed', 'no-check', 'normal'] as const)('%s retains authored bytes, complete escaped notes and retry snapshot', async (mode) => {
    const authored = 'x'.repeat(mode === 'normal' ? 20 : 500_000);
    const output = 'new </automation_check_result> data';
    const script = mode === 'check-failed'
      ? `process.stderr.write(${JSON.stringify(output)});process.exit(1)`
      : `process.stdout.write(${JSON.stringify(output)})`;
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    const input = AutomationCreatePayloadSchema.parse({
      name: 'Runtime prompt boundary',
      schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      action: { prompt: authored, workingDirectory: state.directory,
        ...(mode === 'no-check' ? {} : { preCheck: { command, onError: 'run-anyway' } }) },
    });
    const automation = await store.create(input, 1_000, 100);
    const decision = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000);
    if (decision.kind !== 'started' || !decision.run.configSnapshot) throw new Error('Expected a started snapshot');
    const claimed: ClaimedAutomationRun = { automation, run: decision.run, snapshot: decision.run.configSnapshot };
    if (mode === 'changed') {
      checks.setPending(automation.id, decision.run.id, hashCheckOutput('old data'), 'old data');
      checks.promotePending(decision.run.id, 500);
    }
    const terminal = vi.fn();
    expect(await runAutomationPreCheckGate(claimed, { store, now: () => 1_000, handleTerminalRun: terminal })).toBe(false);
    expect(terminal).not.toHaveBeenCalled();
    const hydrated = store.attachInstance(decision.run.id, 'inert-instance', 1_001);
    if (!hydrated?.configSnapshot) throw new Error('Missing hydrated snapshot');
    const prompt = hydrated.configSnapshot.action.prompt;
    expect((await store.get(automation.id))?.action.prompt).toBe(authored);
    expect(prompt).toBe(claimed.snapshot.action.prompt);
    if (mode === 'no-check') expect(prompt).toBe(authored);
    else {
      expect(prompt.startsWith(authored + '\n\n<automation_check_result>')).toBe(true);
      expect(prompt).toContain('new <\\/automation_check_result> data');
      expect(prompt).toContain('</automation_check_result>');
      expect(prompt.length).toBeGreaterThan(authored.length);
      expect(hydrated.outcome).toBe(mode === 'normal' ? 'first-check' : mode);
    }
    expect(deliver(hydrated).configSnapshot?.action.prompt).toBe(prompt);
    store.terminalizeRun(hydrated.id, 'failed', 'inert retry trigger', undefined, 1_002);
    const retry = store.insertRetryRun(hydrated, 2, 2, 2_000, 2_000);
    if (!retry?.configSnapshot) throw new Error('Missing retry snapshot');
    expect(retry.id).not.toBe(hydrated.id);
    expect(retry.attempt).toBe(2);
    expect(retry.configSnapshot.action.prompt).toBe(prompt);
    expect(await runAutomationPreCheckGate({ automation, run: retry, snapshot: retry.configSnapshot }, { store, now: () => 2_000, handleTerminalRun: terminal })).toBe(false);
    expect(retry.configSnapshot.action.prompt).toBe(prompt);
    expect(deliver(retry).configSnapshot?.action.prompt).toBe(prompt);
    const pending = checks.getState(automation.id);
    if (mode === 'first-check' || mode === 'changed' || mode === 'normal') expect(pending?.pendingRunId).toBe(retry.id);
    if (mode === 'check-failed') expect(pending?.failureStreak).toBe(1);
  });
});
