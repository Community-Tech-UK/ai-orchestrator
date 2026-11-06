import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aggregateKind, parseRolloutSync } from '../codex-helper-trial-report.mjs';
import { costRow, writeCostDir, writeLoopDb, type QueueItemRow } from './codex-helper-trial-fixtures';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const base = Date.parse('2026-09-01T00:00:00Z');
const event = (type: string, timestamp: number) => JSON.stringify({
  type: 'event_msg', timestamp, payload: { type },
});
const usage = (input: number, timestamp: number) => JSON.stringify({
  type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 0 },
  } },
});

function fixture(descendant: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-torn-rollout-')); dirs.push(dir);
  const policy = join(dir, 'policy'); const sessions = join(dir, 'sessions');
  mkdirSync(policy); mkdirSync(sessions);
  const state = join(dir, 'state.sqlite'); const loop = join(dir, 'loop.sqlite');
  const costs = join(dir, 'costs');
  const entries: object[] = []; const threads: string[] = []; const edges: string[] = [];
  const repair = new Map<string, string>();
  for (const arm of ['cheaper', 'full'] as const) for (let i = 0; i < 40; i++) {
    const id = `chat-${arm}-${i}`; const path = join(sessions, `${id}.jsonl`);
    entries.push({ at: new Date(base).toISOString(), provider: 'codex', sessionKind: 'chat',
      threadId: id, instanceId: id, armKey: id, arm, level: arm === 'cheaper' ? 'economy' : 'full', applied: true });
    threads.push(`('${id}', '${path}')`);
    const lines: string[] = [];
    for (let turn = 0; turn < 3; turn++) {
      const at = base + turn * 60_000;
      lines.push(event('task_started', at), usage((turn + 1) * (arm === 'cheaper' ? 25 : 100), at + 1000));
      if (arm === 'cheaper' && turn === 2 && !descendant) {
        lines.push(usage(450, at + 2000).slice(0, -1));
      }
      lines.push(event('task_complete', at + 30_000));
    }
    writeFileSync(path, lines.join('\n'));
    if (arm === 'cheaper' && !descendant) {
      const repaired = [...lines];
      repaired[repaired.length - 2] += '}';
      repair.set(path, repaired.join('\n'));
    }
    if (arm === 'cheaper' && descendant) {
      const child = `${id}-helper`; const childPath = join(sessions, `${child}.jsonl`);
      threads.push(`('${child}', '${childPath}')`); edges.push(`('${id}', '${child}')`);
      const childLines = [event('task_started', base + 121_000), usage(25, base + 122_000),
        usage(375, base + 123_000), event('task_complete', base + 124_000)];
      repair.set(childPath, childLines.join('\n'));
      childLines[2] = childLines[2].slice(0, -1);
      writeFileSync(childPath, childLines.join('\n'));
    }
  }
  const items: QueueItemRow[] = []; const rows: Record<string, unknown>[] = [];
  for (const arm of ['off', 'full']) for (let i = 0; i < 20; i++) {
    const id = `queue-${arm}-${i}`;
    entries.push({ at: new Date(base).toISOString(), provider: 'codex', sessionKind: 'plan-queue',
      threadId: id, instanceId: id, armKey: id, arm, level: arm, applied: true });
    items.push({ id, state: 'landed', createdAt: base, updatedAt: base + 30_000 });
    rows.push(costRow({ instanceId: id, input: arm === 'off' ? 75 : 100, cacheRead: 0, ts: base + 1000 }));
  }
  writeLoopDb(loop, items); writeCostDir(costs, rows);
  writeFileSync(join(policy, 'policy.jsonl'), entries.map(row => JSON.stringify(row)).join('\n'));
  execFileSync('sqlite3', [state, `CREATE TABLE threads(id TEXT, rollout_path TEXT);
    CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT);
    INSERT INTO threads VALUES ${threads.join(',')};
    ${edges.length ? `INSERT INTO thread_spawn_edges VALUES ${edges.join(',')};` : ''}`]);
  const run = (until = '2026-09-24', json = true) => {
    const result = spawnSync(process.execPath, ['scripts/codex-helper-trial-report.mjs',
      '--since', '2026-09-01', '--until', until, '--userdata', dir, '--policy-dir', policy,
      '--state-db', state, '--sessions-dir', sessions, '--loop-db', loop, '--cost-dir', costs,
      '--rlm-db', join(dir, 'absent.sqlite'), ...(json ? ['--json'] : [])], {
      encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' },
    });
    expect(result.status, result.stderr).toBe(0);
    return json ? JSON.parse(result.stdout) : result.stdout;
  };
  return { run, restore: () => { for (const [path, text] of repair) writeFileSync(path, text); } };
}

describe('Codex report damaged rollout evidence', () => {
  it.each([false, true])('withholds chat recommendations for damaged usage (descendant: %s), preserving queue evidence', descendant => {
    const { run, restore } = fixture(descendant);
    const torn = run();
    expect(torn.unknownChatThreads).toHaveLength(40);
    expect(torn.chats.cheaper).toBeUndefined();
    expect(torn.verdict.chats).toBe('pending');
    expect(torn.verdict.harnessWork).toBe('off-justified');
    expect(run('2026-10-10').verdict.chats).toBe('pending');
    expect(torn.damagedRollouts).toHaveLength(40);
    expect(run('2026-09-24', false)).toContain('Rollouts with damaged or unattributable usage (excluded, never zero-filled): 40.');
    restore();
    const restored = run();
    expect(restored.unknownChatThreads).toEqual([]);
    expect(restored.damagedRollouts).toEqual([]);
    expect(restored.chats.cheaper).toMatchObject({ threads: 40, turns: 120, meanInputPerTurn: 150 });
    expect(restored.chats.full.meanInputPerTurn).toBe(100);
    expect(restored.verdict.chats).toBe('full-stays');
    expect(restored.verdict.harnessWork).toBe(torn.verdict.harnessWork);
  });

  it.each(['missing-input', 'missing-timestamp', 'negative-input'])('rejects %s in a usage record despite earlier measured requests', mode => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-invalid-rollout-')); dirs.push(dir);
    const path = join(dir, 'rollout.jsonl');
    const invalid = JSON.parse(usage(450, base + 2000));
    if (mode === 'missing-input') delete invalid.payload.info.total_token_usage.input_tokens;
    if (mode === 'missing-timestamp') delete invalid.timestamp;
    if (mode === 'negative-input') invalid.payload.info.total_token_usage.input_tokens = -1;
    writeFileSync(path, [event('task_started', base), usage(25, base + 1000),
      JSON.stringify(invalid), event('task_complete', base + 30_000)].join('\n'));
    const parsed = parseRolloutSync(path);
    expect(aggregateKind('chat', [{ threadId: 'root', sessionKind: 'chat', arm: 'cheaper',
      level: 'economy', armKey: 'root', applied: true }], { childrenOf: new Map(), rolloutPath: new Map() },
    new Map([['root', parsed]]))).toEqual({});
  });

  it('preserves recorded zero and ignores timestamped invalid usage after the exclusive cutoff', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-rollout-cutoff-')); dirs.push(dir);
    const path = join(dir, 'rollout.jsonl');
    writeFileSync(path, [event('task_started', base), usage(0, base + 1000),
      event('task_complete', base + 30_000), usage(-1, base + 60_000)].join('\n'));
    const parsed = parseRolloutSync(path, base, base + 60_000);
    expect(aggregateKind('chat', [{ threadId: 'root', sessionKind: 'chat', arm: 'cheaper',
      level: 'economy', armKey: 'root', applied: true }], { childrenOf: new Map(), rolloutPath: new Map() },
    new Map([['root', parsed]]))).toMatchObject({ cheaper: { threads: 1, meanInputPerTurn: 0 } });
  });

  it('does not treat a protocol rate-limit-only event as damaged usage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-rollout-rate-only-')); dirs.push(dir);
    const path = join(dir, 'rollout.jsonl');
    writeFileSync(path, [event('task_started', base), usage(100, base + 1000),
      JSON.stringify({ type: 'event_msg', timestamp: base + 2000, payload: {
        type: 'token_count', info: null, rate_limits: { primary: { used_percent: 10 } },
      } }), event('task_complete', base + 30_000)].join('\n'));
    const parsed = parseRolloutSync(path);
    expect(parsed.unknownUsageRecords).toBe(0);
    expect(aggregateKind('chat', [{ threadId: 'root', sessionKind: 'chat', arm: 'full',
      level: 'full', armKey: 'root', applied: true }], { childrenOf: new Map(), rolloutPath: new Map() },
    new Map([['root', parsed]]))).toMatchObject({ full: { threads: 1, meanInputPerTurn: 100 } });
  });
});
