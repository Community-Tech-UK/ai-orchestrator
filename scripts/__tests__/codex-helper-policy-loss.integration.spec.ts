import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  root = mkdtempSync(join(tmpdir(), 'codex-policy-loss-'));
  const policy = join(root, 'policy'), cost = join(root, 'cost'), state = join(root, 'state.sqlite');
  const loop = join(root, 'loop.sqlite'), rlm = join(root, 'rlm.sqlite');
  for (const dir of [policy, cost]) mkdirSync(dir);
  const at = '2026-09-01T00:00:00Z', ts = Date.parse(at);
  execFileSync('sqlite3', [state, 'CREATE TABLE threads (id TEXT, rollout_path TEXT, created_at_ms INTEGER, created_at INTEGER); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);']);
  execFileSync('sqlite3', [loop, 'CREATE TABLE plan_queue_items (id TEXT, state TEXT, round INTEGER, created_at INTEGER, updated_at INTEGER);']);
  execFileSync('sqlite3', [rlm, 'CREATE TABLE automation_runs (id TEXT, automation_id TEXT, instance_id TEXT, status TEXT, started_at INTEGER, finished_at INTEGER);']);
  const entries: Record<string, unknown>[] = [], costs: object[] = [], sql: string[] = [];
  for (const arm of ['off', 'full']) for (let i = 0; i < 20; i++) {
    const id = `${arm}-${i}`;
    entries.push({ at, provider: 'codex', sessionKind: 'plan-queue', armKey: id, armSource: 'plan-queue-item',
      threadId: id, instanceId: id, arm, level: arm, applied: true });
    costs.push({ ts: ts + 1_000, source: 'instance-turn', instanceId: id, usage: { inputTokens: arm === 'off' ? 75 : 100, cacheReadTokens: 0 } });
    sql.push(`INSERT INTO plan_queue_items VALUES ('${id}', 'landed', 1, ${ts}, ${ts + 30_000});`);
  }
  execFileSync('sqlite3', [loop, sql.join('\n')]);
  writeFileSync(join(cost, 'cost-attribution-2026-09-01.jsonl'), costs.map(row => JSON.stringify(row)).join('\n'));
  const writePolicy = (extra: (object | string)[] = []) => writeFileSync(join(policy, 'policy.jsonl'),
    [...entries, ...extra].map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n'));
  writePolicy();
  const args = ['scripts/codex-helper-trial-report.mjs', '--since', '2026-09-01', '--until', '2026-10-10',
    '--policy-dir', policy, '--cost-dir', cost, '--state-db', state, '--loop-db', loop, '--rlm-db', rlm,
    '--sessions-dir', join(root, 'sessions')];
  const run = (json = true) => execFileSync(process.execPath, [...args, ...(json ? ['--json'] : [])],
    { encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' } });
  return { at, ts, policy, rlm, loop, entries, writePolicy, run, report: () => JSON.parse(run()) };
}

describe.skipIf(spawnSync('sqlite3', ['--version']).status !== 0)('actual Codex trial CLI retains lost policy and run evidence as unknown', () => {
  it.each(['helper', 'resume'] as const)('withholds verdicts and defaults for a torn %s record', kind => {
    const f = fixture();
    expect(f.report().verdict.harnessWork).toBe('off-justified');
    const record = kind === 'helper'
      ? { at: f.at, provider: 'codex', recordType: 'helper-count', threadId: 'off-0', helperThreads: 1 }
      : { ...f.entries[0], applied: false };
    f.writePolicy([JSON.stringify(record).slice(0, -1)]);
    const torn = f.report();
    expect(torn.policyRecords).toEqual({ complete: false, unparsableLines: 1 });
    expect(torn.verdict.harnessWork).toBe('pending');
    expect(torn.verdict.chats).toBe('pending');
    expect(f.run(false)).toContain('Policy evidence UNKNOWN');
    f.writePolicy([record]);
    const intact = f.report();
    expect(intact.policyRecords.complete).toBe(true);
    // A valid rejected resume excludes its item; the existing 35-day short-sample default still applies.
    expect(intact.verdict.harnessWork).toBe(kind === 'helper' ? 'pending' : 'apply-defaults');
    if (kind === 'helper') expect(intact.offGraphBreaches).toEqual(['off-0']);
    else expect(intact.ineligibleThreads).toBe(1);
    f.writePolicy();
    expect(f.report().verdict.harnessWork).toBe('off-justified');
  });

  it('counts invalid policy times and helper counters but excludes damaged future-day files', () => {
    const f = fixture();
    writeFileSync(join(f.policy, '2026-10-11.jsonl'), '{"unfinished":');
    expect(f.report().verdict.harnessWork).toBe('off-justified');
    for (const record of [
      { ...f.entries[0], at: 'unreadable' },
      { at: f.at, provider: 'codex', recordType: 'helper-count', threadId: 'off-0', helperThreads: -1 },
    ]) {
      f.writePolicy([record]);
      expect(f.report().policyRecords).toEqual({ complete: false, unparsableLines: 1 });
      expect(f.report().verdict.harnessWork).toBe('pending');
    }
  });

  it.each(['missing', 'corrupt'] as const)('marks a %s automation database unknown, preserving independent queue evidence', mode => {
    const f = fixture();
    const automations = ['off', 'full'].map(arm => ({ at: f.at, provider: 'codex', sessionKind: 'automation',
      armKey: `auto-${arm}`, threadId: `auto-${arm}`, instanceId: `auto-${arm}`, arm, level: arm, applied: true }));
    f.writePolicy(automations);
    execFileSync('sqlite3', [f.rlm, automations.map(e => `INSERT INTO automation_runs VALUES ('run-${e.arm}', '${e.armKey}', '${e.instanceId}', '${e.arm === 'off' ? 'failed' : 'succeeded'}', ${f.ts}, ${f.ts + 30_000});`).join('\n')]);
    const known = f.report();
    expect(known.automationDbReadable).toBe(true);
    expect(known.kindTable.automation.off.runs.failed).toBe(1);
    expect(known.verdict.notes.join(' ')).toContain('"automation" completes more than 10 points worse');
    rmSync(f.rlm);
    if (mode === 'corrupt') writeFileSync(f.rlm, 'invalid database');
    const unknown = f.report();
    expect(unknown.automationDbReadable).toBe(false);
    for (const arm of ['off', 'full']) expect(unknown.kindTable.automation[arm].runs).toEqual({
      succeeded: null, failed: null, decided: null, unknown: 1, settledAfterWindow: null,
    });
    expect(unknown.verdict.harnessWork).toBe(known.verdict.harnessWork);
    expect(unknown.verdict.notes.join(' ')).toContain('Automation outcome comparison unknown');
    expect(unknown.verdict.notes.join(' ')).toContain('Do not change the automation helper setting');
    execFileSync('sqlite3', [f.loop, "UPDATE plan_queue_items SET state = 'verifying' WHERE id IN ('off-0', 'full-0');"]);
    const fallback = f.report();
    expect(fallback.verdict.harnessWork).toBe('apply-defaults');
    expect(fallback.verdict.notes.join(' ')).toContain('Do not change the automation helper setting');
    expect(fallback.verdict.notes.join(' ')).toContain('and their outcomes hold');
    expect(f.run(false)).toContain('unknown/unknown/1');
  });
});
