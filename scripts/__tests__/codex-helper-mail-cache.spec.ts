import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function report(options: { mailAt?: number | number[]; cache?: number[]; author?: string; type?: string; duplicate?: boolean; missingCache?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-mail-cache-')); dirs.push(dir);
  const policyDir = join(dir, 'policy'); mkdirSync(policyDir);
  const epoch = Date.parse('2026-09-01T00:00:00Z');
  const records: { type: string; timestamp: number; payload: Record<string, unknown> }[] = [
    { type: 'event_msg', timestamp: epoch, payload: { type: 'task_started' } },
  ];
  let cached = 0;
  for (const [index, value] of (options.cache ?? [80, 0, 80]).entries()) {
    cached += value;
    const usage = { input_tokens: 100 * (index + 1), ...(options.missingCache ? {} : { cached_input_tokens: cached }), output_tokens: index + 1 };
    records.push({ type: 'token_usage_record', timestamp: epoch + 10 + index * 20,
      payload: { thread_token_usage: usage } });
    if (options.duplicate) records.push({ type: 'event_msg', timestamp: epoch + 11 + index * 20,
      payload: { type: 'token_count', info: { total_token_usage: usage } } });
  }
  for (const [index, at] of (Array.isArray(options.mailAt) ? options.mailAt : options.mailAt === undefined ? [] : [options.mailAt]).entries()) records.push({
    type: options.type ?? 'response_item', timestamp: epoch + at,
    payload: { type: 'agent_message', id: `amsg_fixture_${index}`, author: options.author ?? '/root/researcher',
      recipient: '/root', content: [{ type: 'input_text', text: 'Obvious fixture mail.' }] },
  });
  records.push({ type: 'event_msg', timestamp: epoch + 100, payload: { type: 'task_complete' } });
  records.sort((a, b) => a.timestamp - b.timestamp);
  const rollout = join(dir, 'rollout.jsonl');
  writeFileSync(rollout, records.map((r) => JSON.stringify(r)).join('\n'));
  writeFileSync(join(policyDir, 'policy.jsonl'), JSON.stringify({ at: new Date(epoch).toISOString(), provider: 'codex',
    threadId: 'root', instanceId: 'instance-fixture', sessionKind: 'chat', arm: 'full', level: 'full', armKey: 'fixture', applied: true }));
  const stateDb = join(dir, 'state.sqlite');
  execFileSync('sqlite3', [stateDb, `CREATE TABLE threads(id TEXT, rollout_path TEXT);
    CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT);
    INSERT INTO threads VALUES ('root', '${rollout}');`]);
  const args = ['scripts/codex-helper-trial-report.mjs', '--since', '2026-09-01', '--until', '2026-09-23',
    '--policy-dir', policyDir, '--state-db', stateDb, '--loop-db', join(dir, 'absent.sqlite'), '--rlm-db', join(dir, 'absent.sqlite')];
  const run = (json: boolean) => {
    const result = spawnSync(process.execPath, [...args, ...(json ? ['--json'] : [])], {
      encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' },
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  return { data: JSON.parse(run(true)), text: () => run(false) };
}

describe('Codex helper-mail cache chronology through the real report CLI', () => {
  it('distinguishes a miss after delivery from the same token totals with the miss before delivery', () => {
    const after = report({ mailAt: 20 });
    const before = report({ mailAt: 40 });
    expect(after.data.chats.full.meanUncachedInputPerTurn).toBe(before.data.chats.full.meanUncachedInputPerTurn);
    expect(after.data.chats.full).toMatchObject({ cacheMissesAfterHelperMail: 1, requestsAfterHelperMail: 1, helperMailDeliveries: 1 });
    expect(before.data.chats.full).toMatchObject({ cacheMissesAfterHelperMail: 0, requestsAfterHelperMail: 1 });
    expect(after.text()).toContain('1 / 1 measured next requests');
    expect(before.text()).toContain('0 / 1 measured next requests');
  });

  it('deduplicates usage receipts and excludes cold starts and mail without a following request', () => {
    expect(report({ mailAt: 20, duplicate: true }).data.chats.full)
      .toMatchObject({ cacheMissesAfterHelperMail: 1, requestsAfterHelperMail: 1 });
    for (const mailAt of [5, 80]) expect(report({ mailAt }).data.chats.full)
      .toMatchObject({ cacheMissesAfterHelperMail: null, requestsAfterHelperMail: 0, unmeasuredHelperMailDeliveries: 1 });
  });

  it('leaves absent/unsupported mail and missing cache counters unknown', () => {
    for (const options of [{}, { mailAt: 20, type: 'event_msg' }, { mailAt: 20, author: '/root' }, { mailAt: 20, missingCache: true }, { mailAt: 20, cache: [80, -80, 80] }]) {
      expect(report(options).data.chats.full.cacheMissesAfterHelperMail).toBeNull();
    }
  });

  it('counts one next request for a batch of deliveries and ignores mail outside the active turn', () => {
    expect(report({ mailAt: [15, 20] }).data.chats.full)
      .toMatchObject({ helperMailDeliveries: 2, requestsAfterHelperMail: 1, cacheMissesAfterHelperMail: 1 });
    expect(report({ mailAt: 110 }).data.chats.full)
      .toMatchObject({ helperMailDeliveries: 0, requestsAfterHelperMail: 0, cacheMissesAfterHelperMail: null });
  });
});
