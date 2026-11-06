import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveTrialArm } from '../../src/main/cli/adapters/codex/codex-thread-policy';
import { costRow, writeCostDir, writeLoopDb, type QueueItemRow } from './codex-helper-trial-fixtures';

let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('Codex report actual CLI with a torn cost tail', () => {
  it('withholds Harness-work decisions and 35-day defaults while keeping independent chats measured', () => {
    root = mkdtempSync(join(tmpdir(), 'codex-torn-cost-'));
    const policy = join(root, 'policy'); const costs = join(root, 'costs'); const sessions = join(root, 'sessions');
    for (const dir of [policy, sessions]) mkdirSync(dir);
    const base = Date.parse('2026-09-01T00:00:00Z');
    const state = join(root, 'state.sqlite'); const loop = join(root, 'loop.sqlite');
    const entries: Record<string, unknown>[] = []; const items: QueueItemRow[] = [];
    const rows: Record<string, unknown>[] = [];
    for (const arm of ['off', 'full'] as const) {
      for (let i = 0; i < 20; i++) {
        let suffix = 0; let key = `${arm}-${i}-${suffix}`;
        while (resolveTrialArm(key, 'trial', true) !== arm) key = `${arm}-${i}-${++suffix}`;
        entries.push({ at: new Date(base).toISOString(), provider: 'codex', sessionKind: 'plan-queue',
          armKey: key, armSource: 'plan-queue-item', threadId: key, instanceId: key, arm, level: arm, applied: true });
        items.push({ id: key, state: 'landed', createdAt: base, updatedAt: base + 30_000 });
        rows.push(costRow({ instanceId: key, input: arm === 'off' ? 75 : 100, cacheRead: 0, ts: base + 1000 }));
      }
    }
    // Enough measured chats to prove that queue cost uncertainty does not hold their independent verdict.
    const threadSql: string[] = [];
    for (const arm of ['cheaper', 'full'] as const) {
      for (let i = 0; i < 40; i++) {
        const key = `chat-${arm}-${i}`; const file = join(sessions, `${key}.jsonl`);
        entries.push({ at: new Date(base).toISOString(), provider: 'codex', sessionKind: 'chat',
          armKey: key, armSource: 'instance', threadId: key, instanceId: key, arm,
          level: arm === 'cheaper' ? 'economy' : 'full', applied: true });
        const rollout: object[] = [];
        for (let turn = 0; turn < 3; turn++) {
          const timestamp = new Date(base + turn * 60_000).toISOString();
          rollout.push({ type: 'event_msg', timestamp, payload: { type: 'task_started' } },
            { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: {
              input_tokens: (turn + 1) * (arm === 'cheaper' ? 80 : 100), cached_input_tokens: 0, output_tokens: turn + 1,
            } } } },
            { type: 'event_msg', timestamp: new Date(base + turn * 60_000 + 30_000).toISOString(), payload: { type: 'task_complete' } });
        }
        writeFileSync(file, rollout.map(row => JSON.stringify(row)).join('\n'));
        threadSql.push(`INSERT INTO threads VALUES ('${key}', '${file}');`);
      }
    }
    execFileSync('sqlite3', [state, `CREATE TABLE threads (id TEXT, rollout_path TEXT);
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT); ${threadSql.join('\n')}`]);
    writeLoopDb(loop, items); writeCostDir(costs, rows);
    writeFileSync(join(policy, 'policy.jsonl'), entries.map(row => JSON.stringify(row)).join('\n'));
    const tail = JSON.stringify(costRow({ instanceId: rows[0]['instanceId'] as string, input: 1500, cacheRead: 0, ts: base + 1000 }));
    const file = join(costs, 'cost-attribution-2026-09-01.jsonl');
    appendFileSync(file, tail.slice(0, -1));
    const run = (until: string) => JSON.parse(execFileSync(process.execPath, [
      join(process.cwd(), 'scripts/codex-helper-trial-report.mjs'), '--json', '--since', '2026-09-01', '--until', until,
      '--policy-dir', policy, '--cost-dir', costs, '--state-db', state, '--loop-db', loop,
      '--sessions-dir', sessions, '--rlm-db', join(root, 'unused.sqlite'),
    ], { encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' } }));
    const torn = run('2026-09-23');
    expect(torn.costRecords.unparsableLines).toBe(1);
    expect(torn.unknownItems).toHaveLength(40);
    expect(torn.verdict.harnessWork).toBe('pending');
    expect(torn.verdict.chats).toBe('cheaper-justified');
    expect(run('2026-10-10').verdict.harnessWork).toBe('pending');
    appendFileSync(file, '}');
    const restored = run('2026-09-23');
    expect(restored.unknownItems).toEqual([]);
    expect(restored.planQueueArms.off.meanInputPerLandedItem).toBe(150);
    expect(restored.verdict.harnessWork).toBe('full-keeps-plan-queue');
    expect(restored.verdict.chats).toBe(torn.verdict.chats);
  });
});
