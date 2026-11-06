import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aggregateKind, parseRolloutSync } from '../codex-helper-trial-report.mjs';
import { costRow, writeCostDir, writeLoopDb, type QueueItemRow } from './codex-helper-trial-fixtures';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const base = Date.parse('2026-09-01T00:00:00Z');
function fixture(mode: 'known' | 'missing' | 'zero' | 'descendant' | 'unknown-outcomes' = 'known', days = 22) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-audit-')); dirs.push(dir);
  const policy = join(dir, 'session-policy'); mkdirSync(policy);
  const state = join(dir, 'state.sqlite'), queue = join(dir, 'loop.sqlite');
  const entries: object[] = [], threads: string[] = [], edges: string[] = [], items: QueueItemRow[] = [];
  const costRows: Record<string, unknown>[] = [];
  function add(id: string, kind: string, arm: string, input: number, count = 3, missing = false) {
    const records: object[] = [];
    const ephemeral = kind === 'plan-queue'; // no rollout and no state-database row, as on the real machine
    for (let i = 0; i < count; i++) {
      const at = base + i * 100;
      records.push({ type: 'event_msg', timestamp: at, payload: { type: 'task_started' } });
      if (!missing) records.push({ type: 'token_usage_record', timestamp: at + 10,
        payload: { thread_token_usage: { input_tokens: input * (i + 1), cached_input_tokens: 0, output_tokens: 0 } } });
      records.push({ type: 'event_msg', timestamp: at + 90, payload: { type: 'task_complete' } });
    }
    const path = join(dir, `${id}.jsonl`);
    if (!ephemeral) {
      writeFileSync(path, records.map(v => JSON.stringify(v)).join('\n'));
      threads.push(`('${id}', '${path}')`);
    }
    if (kind) entries.push({ at: new Date(base).toISOString(), provider: 'codex', threadId: id,
      instanceId: `instance-${id}`, sessionKind: kind, arm, armKey: id,
      level: arm === 'cheaper' ? 'economy' : arm, applied: true });
    return path;
  }
  for (const arm of ['full', 'cheaper']) for (let n = 0; n < 40; n++) {
    const id = `${arm}-${n}`;
    add(id, 'chat', arm, arm === 'full' ? 100 : mode === 'zero' ? 0 : 80, 3, arm === 'cheaper' && mode === 'missing');
    if (arm === 'cheaper' && mode === 'descendant') {
      add(`${id}-helper`, '', '', 0, 1, true); edges.push(`('${id}', '${id}-helper')`);
    }
  }
  for (const arm of ['off', 'full']) for (let n = 0; n < 20; n++) {
    const id = `queue-${arm}-${n}`; add(id, 'plan-queue', arm, arm === 'off' ? 75 : 100, 1);
    items.push({ id, state: 'landed', round: 1, createdAt: base, updatedAt: base + 60_000 });
    costRows.push(costRow({ instanceId: `instance-${id}`, input: arm === 'off' ? 75 : 100, cacheRead: 0, ts: base + 50 }));
  }
  for (const arm of ['off', 'full']) for (let n = 0; n < 10; n++) {
    const id = `child-${arm}-${n}`; add(id, 'child', arm, 100, 1);
    if (mode !== 'unknown-outcomes' || arm !== 'off' || n !== 9) entries.push({ at: new Date(base + 99).toISOString(), provider: 'codex', recordType: 'child-outcome',
      threadId: id, instanceId: `instance-${id}`, parentId: 'parent-placeholder',
      success: arm === 'full' || n < 8, exitCode: arm === 'off' && n === 9 ? 1 : 0 });
  }
  // A provider id or unrelated instance id must never stand in for Harness identity.
  entries.push({ at: new Date(base + 99).toISOString(), provider: 'codex', recordType: 'child-outcome',
    threadId: 'child-off-9', instanceId: 'child-off-9', success: true, exitCode: 0 });
  writeFileSync(join(policy, '2026-09-01.jsonl'), entries.map(v => JSON.stringify(v)).join('\n'));
  execFileSync('sqlite3', [state, `CREATE TABLE threads(id TEXT, rollout_path TEXT);
    CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT);
    INSERT INTO threads VALUES ${threads.join(',')}; ${edges.length ? `INSERT INTO thread_spawn_edges VALUES ${edges.join(',')};` : ''}`]);
  writeLoopDb(queue, items);
  const costDir = join(dir, 'cost-attribution'); writeCostDir(costDir, costRows);
  const args = ['scripts/codex-helper-trial-report.mjs', '--since', '2026-09-01', '--until', new Date(base + days * 86_400_000).toISOString(),
    '--policy-dir', policy, '--state-db', state, '--loop-db', queue, '--cost-dir', costDir, '--rlm-db', join(dir, 'absent.sqlite')];
  const run = (json = true) => {
    const r = spawnSync(process.execPath, [...args, ...(json ? ['--json'] : [])], {
      encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' },
    });
    expect(r.status, r.stderr).toBe(0);
    return json ? JSON.parse(r.stdout) : r.stdout;
  };
  return { run };
}

describe('Codex audit report evidence boundaries', () => {
  it('keeps missing root or descendant receipts unknown after the sample gate, while genuine zero remains measured', () => {
    expect(fixture().run().verdict.chats).toBe('cheaper-justified');
    for (const mode of ['missing', 'descendant'] as const) {
      const report = fixture(mode).run();
      expect(report.verdict.chats).toBe('pending');
      expect(report.unknownChatThreads).toHaveLength(40);
      expect(report.chats.cheaper).toBeUndefined();
    }
    expect(fixture('zero').run().verdict.chats).toBe('cheaper-justified');
    expect(fixture('missing', 36).run().verdict.chats).toBe('pending');
  });
  it('uses actual Harness child outcomes with exact instance joins instead of identical completed rollouts', () => {
    const { run } = fixture(); const report = run();
    expect(report.kindTable.child.off.outcomes).toEqual({ succeeded: 8, failed: 2, decided: 10, unknown: 0 });
    expect(report.kindTable.child.full.outcomes).toEqual({ succeeded: 10, failed: 0, decided: 10, unknown: 0 });
    expect(report.verdict.notes.join(' ')).toContain('"child" completes more than 10 points worse');
    expect(run(false)).toContain('child succeeded/failed/unknown');
    const unknown = fixture('unknown-outcomes').run();
    expect(unknown.kindTable.child.off.outcomes).toEqual({ succeeded: 8, failed: 1, decided: 9, unknown: 1 });
    expect(unknown.verdict.notes.join(' ')).toContain('Child outcome comparison unknown');
  });
  it('counts distinct helper threads per turn and exposes unavailable mail/cache chronology explicitly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-helper-count-')); dirs.push(dir);
    const path = join(dir, 'root.jsonl');
    writeFileSync(path, [
      { type: 'event_msg', timestamp: 0, payload: { type: 'task_started' } },
      { type: 'token_usage_record', timestamp: 5, payload: { thread_token_usage: { input_tokens: 100 } } },
      { type: 'event_msg', timestamp: 100, payload: { type: 'task_complete' } },
    ].map(v => JSON.stringify(v)).join('\n'));
    const root = parseRolloutSync(path);
    const turn = (start: number) => ({ start, end: start + 10, requests: 1, input: 10, cached: 0, output: 0, helperInput: 0, helperThreads: 0 });
    const entries = [{ threadId: 'root', sessionKind: 'chat', arm: 'full', level: 'full', armKey: 'root', applied: true }];
    for (const helpers of [['a'], ['a', 'b']]) {
      const rollouts = new Map([['root', root], ['a', { unknownUsageRecords: 0, turns: [turn(10), turn(30)], compactions: [] }],
        ['b', { unknownUsageRecords: 0, turns: [turn(20)], compactions: [] }]]);
      const report = aggregateKind('chat', entries, { childrenOf: new Map([['root', helpers]]), rolloutPath: new Map() }, rollouts);
      expect(report['full']).toMatchObject({ meanHelperThreadsPerTurn: helpers.length, cacheMissesAfterHelperMail: null });
      expect((report['full'] as { cacheMissesAfterHelperMailReason: string }).cacheMissesAfterHelperMailReason).toContain('mail');
    }
  });
});
