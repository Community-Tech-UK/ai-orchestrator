import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteWasmDatabase } from '../../../db/sqlite-wasm-driver';
import { readChildRolloutUsage } from './child-rollout-usage';

describe('readChildRolloutUsage', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('reads only proven descendants and uses each rollout cumulative once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-child-usage-'));
    dirs.push(dir);
    const dbPath = join(dir, 'state_5.sqlite');
    writeFileSync(dbPath, 'test database marker');
    const db = createSqliteWasmDatabase(dbPath);
    const close = db.close.bind(db);
    db.close = () => { /* Keep the injected in-memory fixture open across both reads. */ };
    db.exec('CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT); CREATE TABLE threads (id TEXT, rollout_path TEXT)');
    const sessionsDir = join(dir, 'sessions');
    mkdirSync(sessionsDir);
    const childPath = join(sessionsDir, 'rollout-child.jsonl');
    const eventChildPath = join(sessionsDir, 'rollout-event-child.jsonl');
    const foreignPath = join(sessionsDir, 'rollout-foreign.jsonl');
    const usage = (input: number, output: number) => ({ input_tokens: input, cached_input_tokens: 10, output_tokens: output, reasoning_output_tokens: 2, total_tokens: input + output });
    const now = Date.now();
    writeFileSync(childPath, [
      { type: 'session_meta', payload: { id: 'child', parent_thread_id: 'root' } },
      { type: 'token_usage_record', payload: { root_turn_id: 'old-root-turn', thread_token_usage: usage(100, 20) } },
      { timestamp: new Date(now - 1_000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(100, 20) } } },
      { type: 'token_usage_record', payload: { root_turn_id: 'current-root-turn', thread_token_usage: usage(150, 30) } },
      { timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(150, 30) } } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    writeFileSync(eventChildPath, [
      { timestamp: new Date(now - 1_100).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'earlier-child-turn' } },
      { timestamp: new Date(now - 1_000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(100, 20), last_token_usage: usage(100, 20) } } },
      { timestamp: new Date(now - 100).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'current-child-turn' } },
      { timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(150, 30), last_token_usage: usage(50, 10) } } },
      { timestamp: new Date(now + 1_000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(200, 40), last_token_usage: usage(50, 10) } } },
      { timestamp: new Date(now + 1_500).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'next-child-turn' } },
      { timestamp: new Date(now + 2_000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(250, 50), last_token_usage: usage(50, 10) } } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    writeFileSync(foreignPath, JSON.stringify({ type: 'token_usage_record', payload: { thread_token_usage: usage(999, 9) } }) + '\n');
    db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?)').run('root', 'child');
    db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?)').run('root', 'event-child');
    db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?)').run('foreign-root', 'foreign');
    db.prepare('INSERT INTO threads VALUES (?, ?)').run('child', childPath);
    db.prepare('INSERT INTO threads VALUES (?, ?)').run('event-child', eventChildPath);
    db.prepare('INSERT INTO threads VALUES (?, ?)').run('foreign', foreignPath);
    const options = { dbPath, driverFactory: () => db, startedAtMs: now - 500, endedAtMs: now + 500 };
    const result = await readChildRolloutUsage('root', 'current-root-turn', options);
    expect(result).toEqual(expect.arrayContaining([
      { threadId: 'child', baseline: usage(100, 20), usage: usage(150, 30) },
      { threadId: 'event-child', baseline: usage(100, 20), usage: usage(150, 30) },
    ]));
    expect(result).toHaveLength(2);
    const late = await readChildRolloutUsage('root', 'current-root-turn', { ...options, observedAtMs: now + 2_500 });
    expect(late).toEqual(expect.arrayContaining([
      { threadId: 'event-child', baseline: usage(100, 20), usage: usage(200, 40) },
    ]));
    expect(await readChildRolloutUsage('root', 'unrelated-root-turn', { ...options, startedAtMs: now + 2_000, endedAtMs: now + 3_000 })).toEqual([]);
    close();
  });
});
