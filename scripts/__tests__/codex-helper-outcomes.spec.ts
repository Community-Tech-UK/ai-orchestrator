import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { costRow, writeCostDir, writeLoopDb, type QueueItemRow } from './codex-helper-trial-fixtures';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const base = Date.parse('2026-09-01T00:00:00Z');
type Rollout = 'complete' | 'no-final' | 'no-usage' | 'crashed' | 'missing' | 'unreadable';
type Control = 'exact' | 'success' | 'missing' | 'conflicting' | 'foreign-instance' | 'foreign-thread'
  | 'foreign-provider' | 'nonzero-exit' | 'unknown-success' | 'conflicting-reversed' | 'mixed-arm' | 'mixed-key' | 'unapplied' | 'off-breach' | 'legacy' | 'duplicate';
let receipt = 0;

function fixture(options: { rollout?: Rollout; control?: Control; onlyFailures?: boolean; sample?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-outcome-')); dirs.push(dir);
  const policy = join(dir, 'policy'); mkdirSync(policy);
  const state = join(dir, 'state.sqlite');
  const queue = join(dir, 'queue.sqlite');
  const entries: Record<string, unknown>[] = [], threads: string[] = [], items: QueueItemRow[] = [];
  const costRows: Record<string, unknown>[] = [];
  const edges: string[] = [];
  function add(id: string, kind: string, arm: string, input = 100, turns = 1, rollout: Rollout = 'complete') {
    const path = join(dir, `${id}.jsonl`);
    const records: object[] = [];
    for (let i = 0; i < turns; i++) {
      const at = base + i * 100;
      records.push({ type: 'event_msg', timestamp: at, payload: { type: 'task_started' } });
      if (!['no-usage', 'crashed'].includes(rollout)) records.push({ type: 'token_usage_record', timestamp: at + 10,
        payload: { thread_token_usage: { input_tokens: input * (i + 1), cached_input_tokens: 0, output_tokens: 1 } } });
      if (!['no-final', 'crashed'].includes(rollout)) records.push({ type: 'event_msg', timestamp: at + 90, payload: { type: 'task_complete' } });
    }
    if (rollout === 'unreadable') mkdirSync(path);
    else if (rollout !== 'missing') writeFileSync(path, records.map(r => JSON.stringify(r)).join('\n')
      + (rollout === 'crashed' ? '\n{"type":' : ''));
    if (kind === 'plan-queue') rmSync(path, { recursive: true, force: true }); // ephemeral: no rollout, no state row
    else threads.push(`('${id}', '${path}')`);
    const entry: Record<string, unknown> = { at: new Date(base).toISOString(), provider: 'codex', threadId: id,
      instanceId: `instance-${id}`, sessionKind: kind, arm, level: arm === 'cheaper' ? 'economy' : arm,
      armKey: `key-${id}`, armSource: 'parent', applied: true };
    entries.push(entry);
    return entry;
  }
  if (options.sample) {
    for (const arm of ['full', 'cheaper']) for (let n = 0; n < 40; n++) add(`chat-${arm}-${n}`, 'chat', arm, arm === 'full' ? 100 : 80, 3);
    for (const arm of ['off', 'full']) for (let n = 0; n < 20; n++) {
      const id = `queue-${arm}-${n}`;
      const entry = add(id, 'plan-queue', arm, arm === 'off' ? 75 : 100);
      entry['armKey'] = id;
      items.push({ id, state: 'landed', round: 1, createdAt: base, updatedAt: base + 60_000 });
      costRows.push(costRow({ instanceId: `instance-${id}`, input: arm === 'off' ? 75 : 100, cacheRead: 0, ts: base + 50 }));
    }
  }
  for (const arm of ['off', 'full']) for (let n = 0; n < (options.onlyFailures && arm === 'off' ? 2 : 10); n++) {
    const target = arm === 'off' && (options.onlyFailures || n >= 8);
    const id = `child-${arm}-${n}`;
    const entry = add(id, 'child', arm, 100, 1, target ? options.rollout : 'complete');
    const control = target ? options.control ?? 'exact' : 'exact';
    if (control === 'legacy') delete entry['instanceId'];
    if (control === 'unapplied') entry['applied'] = false;
    if (control === 'mixed-arm') entries.push({ ...entry, arm: 'full', level: 'full' });
    if (control === 'mixed-key') entries.push({ ...entry, armKey: 'foreign-key' });
    if (control === 'off-breach') {
      add(`${id}-helper`, 'child', 'full'); edges.push(`('${id}', '${id}-helper')`);
    }
    const outcome = { at: new Date(base + 99).toISOString(), provider: control === 'foreign-provider' ? 'claude' : 'codex',
      recordType: 'child-outcome', threadId: control === 'foreign-thread' ? 'foreign-thread' : id,
      instanceId: control === 'foreign-instance' ? id : `instance-${id}`, parentId: 'parent-placeholder',
      success: control === 'unknown-success' ? null : !target || ['success', 'nonzero-exit'].includes(control),
      exitCode: control === 'nonzero-exit' || target && n % 2 === 1 && !['success', 'unknown-success'].includes(control) ? 1 : 0 };
    if (control === 'conflicting-reversed') entries.push({ ...outcome, success: true, exitCode: 0 });
    if (control !== 'missing') entries.push(outcome);
    if (control === 'duplicate') entries.push({ ...outcome });
    if (control === 'conflicting') entries.push({ ...outcome, success: true, exitCode: 0 });
  }
  writeFileSync(join(policy, 'policy.jsonl'), entries.map(r => JSON.stringify(r)).join('\n'));
  execFileSync('sqlite3', [state, `CREATE TABLE threads(id TEXT, rollout_path TEXT);
    CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT);
    INSERT INTO threads VALUES ${threads.join(',')}; ${edges.length ? `INSERT INTO thread_spawn_edges VALUES ${edges.join(',')};` : ''}`]);
  writeLoopDb(queue, items);
  const costDir = join(dir, 'cost-attribution'); writeCostDir(costDir, costRows);
  const run = (json = true) => {
    const args = ['scripts/codex-helper-trial-report.mjs', '--since', '2026-09-01', '--until', '2026-09-23',
      '--policy-dir', policy, '--state-db', state, '--sessions-dir', dir, '--loop-db', queue, '--cost-dir', costDir,
      '--rlm-db', join(dir, 'absent.sqlite'), ...(json ? ['--json'] : [])];
    const result = spawnSync(process.execPath, args, {
      encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' },
    });
    // Optional local evidence retains each real report process, including its exit signal.
    const evidenceDir = process.env['AIO_CODEX_OUTCOME_RECEIPTS_DIR'];
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      const stem = join(evidenceDir, `cli-${++receipt}`);
      writeFileSync(`${stem}.stdout`, result.stdout ?? '');
      writeFileSync(`${stem}.stderr`, result.stderr ?? '');
      writeFileSync(`${stem}.json`, JSON.stringify({ options, json, command: [process.execPath, ...args],
        status: result.status, signal: result.signal, error: result.error?.message }, null, 2));
    }
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(options.rollout === 'unreadable' ? 1 : 0);
    return json ? JSON.parse(result.stdout) : result.stdout;
  };
  return { run };
}

const failedCounts = { succeeded: 8, failed: 2, decided: 10, unknown: 0 };

describe('Harness child quality independent of billed-rollout eligibility', () => {
  it.each<Rollout>(['complete', 'no-final', 'no-usage', 'crashed', 'missing', 'unreadable'])(
    'retains identical authoritative failure counts with %s rollout evidence', rollout => {
      const { run } = fixture({ rollout, sample: true });
      const report = run();
      expect(report.kindTable.child.off.outcomes).toEqual(failedCounts);
      expect(report.kindTable.child.full.outcomes).toEqual({ succeeded: 10, failed: 0, decided: 10, unknown: 0 });
      expect(report.kindTable.child.off.threads).toBe(rollout === 'complete' ? 10 : 8);
      expect(report.kindTable.child.off.threadIds).toHaveLength(rollout === 'complete' ? 10 : 8);
      expect(report.kindTable.child.off.unmeasuredThreadIds).toEqual(rollout === 'complete' ? [] : ['child-off-8', 'child-off-9']);
      // Rollout-measured Harness work: the child threads only. The plan queue is measured from Harness records.
      expect(report.harnessWorkArms.off.threads).toBe(rollout === 'complete' ? 10 : 8);
      if (rollout === 'unreadable') {
        expect(report.verdict.harnessWork).toBe('pending');
        expect(report.verdict.chats).toBe('pending');
        expect(report.verdict.notes.join(' ')).toContain('unreadable rollout');
      } else {
        expect(report.verdict.notes.join(' ')).toContain('"child" completes more than 10 points worse');
      }
    });

  it.each<Rollout>(['no-final', 'no-usage', 'crashed', 'missing'])(
    'prints known failures with unknown token measures when the entire Off arm is %s', rollout => {
      const { run } = fixture({ rollout, onlyFailures: true });
      const report = run();
      expect(report.kindTable.child.off).toMatchObject({ threads: 0, turns: 0, threadIds: [],
        meanInputPerTurn: null, meanUncachedInputPerTurn: null, meanOutputPerTurn: null,
        meanRequestsPerTurn: null, medianWallClockMs: null, totalInput: null,
        helperInputShare: null, compactionsPerTurn: null,
        outcomes: { succeeded: 0, failed: 2, decided: 2, unknown: 0 } });
      expect(report.harnessWorkArms.off).toBeUndefined();
      expect(report.verdict.harnessWork).toBe('no-data');
      expect(report.verdict.chats).toBe('no-data');
      expect(run(false)).toContain('| child | off | 0 | 0 | — | 0/0 | — | 0/2/0 |');
    });

  it.each<Control>(['success', 'missing', 'conflicting', 'foreign-instance', 'foreign-thread', 'foreign-provider', 'legacy', 'duplicate', 'nonzero-exit', 'unknown-success', 'conflicting-reversed'])(
    'preserves exact identity and outcome authority for %s records without usage', control => {
      const report = fixture({ rollout: 'crashed', control, sample: true }).run();
      expect(report.kindTable.child.off.outcomes).toEqual(control === 'success'
        ? { succeeded: 10, failed: 0, decided: 10, unknown: 0 }
        : ['duplicate', 'nonzero-exit'].includes(control) ? failedCounts
          : { succeeded: 8, failed: 0, decided: 8, unknown: 2 });
      if (!['success', 'duplicate', 'nonzero-exit'].includes(control)) {
        expect(report.verdict.notes.join(' ')).toContain('Child outcome comparison unknown');
        expect(report.verdict.notes.join(' ')).not.toContain('"child" completes more than 10 points worse');
      }
    });

  it.each<Control>(['mixed-arm', 'mixed-key', 'unapplied', 'off-breach'])(
    'does not rescue rejected %s exposure with an authoritative failure', control => {
      const report = fixture({ rollout: 'crashed', control }).run();
      expect(report.kindTable.child.off.outcomes).toEqual({ succeeded: 8, failed: 0, decided: 8, unknown: 2 });
      if (control === 'off-breach') expect(report.offGraphBreaches).toEqual(['child-off-8', 'child-off-9']);
    });
});
