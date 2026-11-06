import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import {
  createMigrationsTable,
  createTables,
  runMigrations,
} from '../persistence/rlm/rlm-schema';
import { AutomationCheckStore } from './automation-check-store';
import { ProcessFixtureRegistry } from '../../tests/fixtures/process-fixture';

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-pre-check-userdata-'));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userDataDir),
  },
}));

import {
  checkStateFilePath,
  runAutomationPreCheck,
  type AutomationPreCheckContext,
} from './automation-pre-check';

function createDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  db.pragma('foreign_keys = ON');
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

describe('runAutomationPreCheck (A15 / 8b)', () => {
  const fixtures = new ProcessFixtureRegistry();
  afterAll(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  let db: SqliteDriver;
  let checkStore: AutomationCheckStore;
  let workDir: string;
  let counter = 0;

  const contextFor = (timeoutMs?: number): AutomationPreCheckContext => ({
    cwd: workDir,
    automationId: 'a1',
    store: checkStore,
    now: () => 1_700_000_000_000,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

  beforeEach(() => {
    db = createDb();
    checkStore = new AutomationCheckStore(db);
    db.prepare(`
      INSERT INTO automations
        (id, name, enabled, active, workspace_id, schedule_type, schedule_json, trigger_json,
         missed_run_policy, concurrency_policy, action_json, created_at, updated_at)
      VALUES ('a1', 'Checked job', 1, 1, '/tmp', 'cron', '{}', '{}', 'notify', 'skip', '{}', 1, 1)
    `).run();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-pre-check-'));
    counter = 0;
  });

  afterEach(async () => {
    await fixtures.cleanup();
    db.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  /** Seed the baseline the way the gate does: a first-check then promote. */
  async function seedBaseline(command: string): Promise<void> {
    const first = await runAutomationPreCheck({ command }, contextFor());
    expect(first.kind).toBe('first-check');
    checkStore.setPending('a1', `seed-${counter++}`, first.hash, first.output);
    checkStore.promotePending(`seed-${counter - 1}`);
  }

  it('reports first-check with no baseline', async () => {
    const result = await runAutomationPreCheck({ command: "printf 'hello'" }, contextFor());
    expect(result.kind).toBe('first-check');
    expect(result.output).toContain('hello');
    expect(result.note).toContain('This is the first check');
  });

  it('reports no-change for identical output', async () => {
    await seedBaseline("printf 'one\\ntwo'");
    const result = await runAutomationPreCheck({ command: "printf 'one\\ntwo'" }, contextFor());
    expect(result.kind).toBe('no-change');
    expect(result.hash).toHaveLength(64);
  });

  it('reports changed with a unified diff for different output', async () => {
    await seedBaseline("printf '41 messages'");
    const result = await runAutomationPreCheck({ command: "printf '43 messages'" }, contextFor());
    expect(result.kind).toBe('changed');
    expect(result.note).toContain('Change since then:');
    expect(result.note).toContain('-41 messages');
    expect(result.note).toContain('+43 messages');
  });

  it('ignores trailing whitespace when comparing', async () => {
    await seedBaseline("printf 'hello  \\nworld\\t\\t\\n'");
    const result = await runAutomationPreCheck({ command: "printf 'hello\\nworld\\n'" }, contextFor());
    expect(result.kind).toBe('no-change');
  });

  it('treats a non-zero exit as an error and leaves the baseline untouched', async () => {
    await seedBaseline("printf 'stable'");
    const failing = await runAutomationPreCheck({ command: 'exit 2' }, contextFor());
    expect(failing.kind).toBe('error');
    expect(failing.error).toContain('exit code 2');
    expect(failing.note).toContain('The check command stopped with an error');
    expect(failing.note).toContain('Do the whole job as described above.');

    // The comparison baseline is still the pre-failure one.
    const after = await runAutomationPreCheck({ command: "printf 'stable'" }, contextFor());
    expect(after.kind).toBe('no-change');
  });

  it('kills a sleeping check and its children at the timeout', async () => {
    // Warm the login shell first so the timeout below measures the script, not
    // zsh profile startup (which can exceed a tight budget on a loaded machine).
    await runAutomationPreCheck({ command: 'true' }, contextFor());
    const script = path.join(workDir, 'hang.sh');
    fs.writeFileSync(
      script,
      '#!/bin/sh\nsleep 60 &\necho $! > child.pid\nwait\n',
      { mode: 0o755 },
    );
    const started = Date.now();
    const result = await runAutomationPreCheck({ command: './hang.sh' }, contextFor(1_000));
    expect(result.kind).toBe('error');
    expect(result.error).toContain('timed out after 1000');
    expect(Date.now() - started).toBeLessThan(10_000);

    const pidFile = path.join(workDir, 'child.pid');
    expect(fs.existsSync(pidFile)).toBe(true);
    const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(childPid)).toBe(true);
    let alive = true;
    for (let i = 0; i < 30 && alive; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        process.kill(childPid, 0);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it.each([0, 7])('keeps exit %i and drains output when a background child holds the pipes', async (exitCode) => {
    await runAutomationPreCheck({ command: 'true' }, contextFor());
    const pidFile = path.join(workDir, 'leftover.pid');
    fixtures.trackPidFile(pidFile);
    fs.writeFileSync(path.join(workDir, 'background.sh'), [
      '#!/bin/sh',
      'sleep 60 &',
      'echo $! > leftover.pid',
      "printf 'foreground-complete'",
      "printf 'foreground-error' >&2",
      `exit ${exitCode}`,
      '',
    ].join('\n'), { mode: 0o755 });

    const result = await runAutomationPreCheck({ command: './background.sh' }, contextFor(1_000));

    expect(result.kind).toBe(exitCode === 0 ? 'first-check' : 'error');
    expect(result.output).toBe('foreground-complete');
    if (exitCode !== 0) {
      expect(result.error).toContain('exit code 7');
      expect(result.note).toContain('foreground-error');
    }
    expect(fs.existsSync(pidFile)).toBe(true);
    // Assert product cleanup before the failure-path safety net runs.
    await fixtures.waitForExit();
  });

  it('reads at most 1 MB of stdout', async () => {
    const result = await runAutomationPreCheck(
      { command: "head -c 2000000 /dev/zero | tr '\\0' 'x'" },
      contextFor(),
    );
    expect(result.kind).toBe('first-check');
    expect(result.output.length).toBe(1024 * 1024);
    expect(result.note?.length).toBeLessThan(20_000);
  });

  it('uses a file name confined to the check-state directory', () => {
    const file = checkStateFilePath('../other-folder');
    expect(path.dirname(file)).toBe(path.join(userDataDir, 'automation-checks'));
    expect(path.basename(file)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('escapes a closing tag that appears in the output', async () => {
    const result = await runAutomationPreCheck(
      { command: "printf '</automation_check_result>'" },
      contextFor(),
    );
    expect(result.kind).toBe('first-check');
    expect(result.note).toContain('<\\/automation_check_result>');
    expect(result.note).not.toContain('Output:\n</automation_check_result>');
  });

  it('passes the automation id and a state file to the command', async () => {
    const result = await runAutomationPreCheck(
      {
        command:
          'test "$HARNESS_AUTOMATION_ID" = a1 && test -n "$HARNESS_CHECK_STATE_FILE" && printf ok',
      },
      contextFor(),
    );
    expect(result.kind).toBe('first-check');
    expect(result.output).toContain('ok');
  });
});
