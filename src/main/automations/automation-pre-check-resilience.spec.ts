/**
 * 8b repairs (R4K1): the output comparison stays linear on hostile input, and
 * a state folder that cannot be created ends the run as an ordinary check
 * error (the `onError` policy applies) instead of throwing out of dispatch.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AutomationRun, ClaimedAutomationRun } from '../../shared/types/automation.types';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { AutomationCheckStore } from './automation-check-store';

const state = vi.hoisted(() => ({
  userData: '',
  checks: null as unknown,
  notify: vi.fn(),
}));

vi.mock('electron', () => ({ app: { getPath: () => state.userData } }));
vi.mock('./automation-check-store', async importOriginal => ({
  ...await importOriginal<typeof import('./automation-check-store')>(),
  getAutomationCheckStore: () => state.checks,
}));
vi.mock('../notifications/notification-service', () => ({
  getNotificationService: () => ({ notify: state.notify }),
}));

import { normalizeCheckOutput, runAutomationPreCheck } from './automation-pre-check';
import { runAutomationPreCheckGate } from './automation-pre-check-gate';

/** The pre-repair implementation, kept verbatim as the equivalence oracle. */
function legacyNormalize(output: string): string {
  return output.replace(/[ \t]+$/gm, '');
}

describe('normalizeCheckOutput (8b, linear)', () => {
  it('matches the old regex on fixed edge cases', () => {
    const cases = [
      '',
      ' ',
      '\t',
      'a',
      'a ',
      'a \t \n',
      'a  \nb\t\t\n\n  \n',
      'line one   \r\nline two\t\r\n',
      'cr only  \rnext\t\rend  ',
      'sep  next  end ',
      '   leading kept   \n\t\tindented kept\t',
      'mid  dle stays\tin the line  \n',
      '\n\n\n',
      ' \n \n \n',
      'a   \n', // a non-breaking space is not trailing space/tab
      'no trailing newline   ',
    ];
    for (const input of cases) {
      expect(normalizeCheckOutput(input), JSON.stringify(input)).toBe(legacyNormalize(input));
    }
  });

  it('matches the old regex on 20000 seeded random inputs', () => {
    let seed = 0x2f6e2b1;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    const alphabet = [' ', ' ', '\t', '\n', '\r', '\r\n', ' ', ' ', 'a', 'b', ' '];
    for (let i = 0; i < 20_000; i++) {
      const length = next() % 40;
      let input = '';
      for (let j = 0; j < length; j++) input += alphabet[next() % alphabet.length];
      expect(normalizeCheckOutput(input), JSON.stringify(input)).toBe(legacyNormalize(input));
    }
  });

  it('stays fast on 1 MB of adversarial whitespace', () => {
    const MB = 1024 * 1024;
    const inputs = [
      ' '.repeat(MB - 1) + 'x',
      '\t'.repeat(MB - 1) + 'x',
      ' \t'.repeat(MB / 2 - 1) + 'x\n',
      ('  ' + 'x\n').repeat(MB / 4),
      ' '.repeat(MB),
    ];
    for (const input of inputs) {
      const started = performance.now();
      const result = normalizeCheckOutput(input);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(1_000);
      expect(result.length).toBeLessThanOrEqual(input.length);
    }
    expect(normalizeCheckOutput(' '.repeat(MB - 1) + 'x')).toBe(' '.repeat(MB - 1) + 'x');
    expect(normalizeCheckOutput(' '.repeat(MB))).toBe('');
  });
});

describe('a state folder that cannot be created (8b)', () => {
  let db: SqliteDriver;
  let workDir: string;
  let marker: string;
  const tempRoots: string[] = [];

  afterAll(() => {
    for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // userData is a regular FILE, so mkdir of `<userData>/automation-checks` fails (ENOTDIR).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-pre-check-nofolder-'));
    tempRoots.push(root);
    state.userData = path.join(root, 'userdata-is-a-file');
    fs.writeFileSync(state.userData, 'not a folder');
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-pre-check-cwd-'));
    tempRoots.push(workDir);
    marker = path.join(workDir, 'command-ran');

    db = defaultDriverFactory(':memory:');
    db.pragma('foreign_keys = ON');
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
    db.prepare(`
      INSERT INTO automations
        (id, name, enabled, active, workspace_id, schedule_type, schedule_json, trigger_json,
         missed_run_policy, concurrency_policy, action_json, created_at, updated_at)
      VALUES ('job-1', 'Checked job', 1, 1, '/tmp', 'cron', '{}', '{}', 'notify', 'skip', '{}', 1, 1)
    `).run();
    state.checks = new AutomationCheckStore(db);
  });

  afterEach(() => db.close());

  function claimed(onError: 'run-anyway' | 'stop'): ClaimedAutomationRun {
    const snapshot = {
      name: 'Checked job',
      schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      trigger: { kind: 'schedule' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      destination: { kind: 'newInstance' },
      action: {
        prompt: 'Do the job',
        workingDirectory: workDir,
        preCheck: { command: `touch ${marker}`, onError },
      },
    } as ClaimedAutomationRun['snapshot'];
    const run = {
      id: 'run-1', automationId: 'job-1', trigger: 'scheduled', status: 'running',
      attempt: 1, maxAttempts: 3, configSnapshot: snapshot,
    } as AutomationRun;
    return { run, snapshot, automation: { id: 'job-1' } } as ClaimedAutomationRun;
  }

  function host() {
    const terminalizeRun = vi.fn((_id: string, status: string, error: string) => (
      { id: 'run-1', status, error } as unknown as AutomationRun
    ));
    const handleTerminalRun = vi.fn();
    return {
      terminalizeRun,
      handleTerminalRun,
      host: {
        store: { terminalizeRun, markSeen: vi.fn(), getRun: vi.fn() },
        now: () => 5_000,
        handleTerminalRun,
      },
    };
  }

  it('returns a check error instead of throwing, and never starts the command', async () => {
    const result = await runAutomationPreCheck(
      { command: `touch ${marker}` },
      { cwd: workDir, automationId: 'job-1', store: state.checks as AutomationCheckStore, now: () => 1 },
    );
    expect(result.kind).toBe('error');
    expect(result.hash).toBe('');
    expect(result.error).toMatch(/state folder/);
    expect(result.note).toContain('Do the whole job as described above.');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('onError "stop": the run ends failed (not retried), is notified, and is never left claimed', async () => {
    const h = host();
    await expect(runAutomationPreCheckGate(claimed('stop'), h.host)).resolves.toBe(true);
    expect(h.terminalizeRun).toHaveBeenCalledWith(
      'run-1', 'failed', 'The check could not run, so this run stopped.', undefined, 5_000,
    );
    expect(h.handleTerminalRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }), { retryable: false },
    );
    expect(state.notify).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'automation-check-failed',
      body: expect.stringContaining('the run stopped'),
    }));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('onError "run-anyway": the run proceeds with the error note and the failure is recorded', async () => {
    const h = host();
    const run = claimed('run-anyway');
    await expect(runAutomationPreCheckGate(run, h.host)).resolves.toBe(false);
    expect(h.terminalizeRun).not.toHaveBeenCalled();
    expect(run.snapshot.action.prompt).toContain('The check command stopped with an error');
    expect(state.notify).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'automation-check-failed',
      body: expect.stringContaining('the AI did the full job'),
    }));
    expect((state.checks as AutomationCheckStore).getState('job-1')?.failureStreak).toBe(1);
  });
});
