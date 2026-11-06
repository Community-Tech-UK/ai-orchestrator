import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parsePolicyLog } from '../claude-cost-audit-report.mjs';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

it.skipIf(spawnSync('sqlite3', ['--version']).status !== 0)('withholds CLI adoption when a damaged policy record hides the reviewer guard', () => {
  root = mkdtempSync(join(tmpdir(), 'claude-policy-loss-'));
  const projects = join(root, 'projects'), userData = join(root, 'userdata'), policyDir = join(userData, 'session-policy');
  const start = Date.parse('2026-09-01T00:00:00Z'), end = start + 20 * 86_400_000;
  const iso = (at: number) => new Date(at).toISOString();
  const policies: Record<string, unknown>[] = [];
  mkdirSync(policyDir, { recursive: true });
  for (const [j, id] of ['fixture-0', 'fixture-1', 'fixture-8'].entries()) {
    const arm = j === 2 ? 'same-as-session' : 'sonnet';
    policies.push({ at: iso(start), provider: 'claude', sessionId: id, setting: 'trial', arm,
      armKey: j === 0 ? 'item-s' : j === 2 ? 'item-c' : 'guard-only',
      applied: j !== 2, reviewerRuleDelivered: true, waitingRuleDelivered: false });
    const dir = join(projects, 'fixture', id, 'subagents');
    mkdirSync(dir, { recursive: true });
    const parent: Record<string, unknown>[] = [];
    for (let i = 0; i < (j === 0 ? 300 : j === 1 ? 20 : 320); i++) {
      const at = start + 86_400_000 + i * 100, tool = `tool-${i}`;
      writeFileSync(join(dir, `agent-${i}.meta.json`), JSON.stringify({ agentType: 'general-purpose', toolUseId: tool,
        description: j === 1 ? 'Review the finished change' : 'Implement fixture' }));
      writeFileSync(join(dir, `agent-${i}.jsonl`), JSON.stringify({ type: 'assistant', timestamp: iso(at + 2),
        message: { id: `helper-${i}`, model: j === 2 ? 'claude-opus-4-7' : 'claude-sonnet-4-5',
          usage: { input_tokens: 10_000, output_tokens: 0 } } }));
      parent.push({ type: 'user', uuid: `turn-${i}`, timestamp: iso(at), message: { content: 'Fixture task' } },
        { type: 'assistant', timestamp: iso(at + 1), message: { id: `parent-${i}`, model: 'claude-opus-4-7',
          usage: { input_tokens: 1_000, output_tokens: 0 }, content: [{ type: 'tool_use', id: tool, name: 'Task', input: {} }] } },
        { type: 'user', timestamp: iso(at + 10), message: { content: [{ type: 'tool_result', tool_use_id: tool, is_error: false, content: 'Complete' }] } });
    }
    writeFileSync(join(projects, 'fixture', id + '.jsonl'), parent.map(row => JSON.stringify(row)).join('\n'));
  }
  const loop = join(userData, 'loop-mode', 'loop-mode.db');
  mkdirSync(join(userData, 'loop-mode'));
  execFileSync('sqlite3', [loop, `CREATE TABLE plan_queue_items (id TEXT, state TEXT, landed_commit TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE loop_iterations (loop_run_id TEXT, tokens INTEGER, cost_cents INTEGER, started_at INTEGER);
    INSERT INTO plan_queue_items VALUES ('item-s', 'landed', 'fixture-landed', ${start}, ${end - 1});
    INSERT INTO plan_queue_items VALUES ('item-c', 'landed', 'fixture-landed', ${start}, ${end - 1});`]);
  const prices = join(root, 'prices.json');
  writeFileSync(prices, JSON.stringify({ 'claude-sonnet-4-5': { inputPerMTok: 1, outputPerMTok: 1 },
    'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 5 } }));
  const file = join(policyDir, '2026-09-01.jsonl');
  const run = (lines: string[]) => {
    writeFileSync(file, lines.join('\n'));
    return execFileSync(process.execPath, ['scripts/claude-cost-audit-report.mjs', '--subagents', '--userdata', userData,
      '--projects', projects, '--prices', prices, '--since', iso(start), '--until', iso(end)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AIO_COST_ATTRIBUTION_DIR: join(root, 'no-attribution'), AIO_COST_AUDIT_SQLITE_DRIVER: 'cli' },
    });
  };
  const intact = policies.map(row => JSON.stringify(row));
  expect(run(intact)).toContain('**do-not-adopt (the reviewer rule must be firmer first)**');
  const torn = [...intact]; torn[1] = torn[1].slice(0, -1);
  const damaged = run(torn);
  expect(damaged).toContain('**pending (policy evidence)**');
  expect(damaged).toContain('1 damaged or unplaceable policy record');
  expect(damaged).not.toContain('**adopt-sonnet**');
  expect(run(intact)).toContain('**do-not-adopt (the reviewer rule must be firmer first)**');
  const clean = policies.filter(row => row['sessionId'] !== 'fixture-1').map(row => JSON.stringify(row));
  expect(run(clean)).toContain('**adopt-sonnet**');
}, 30_000);

it.each(['{', 'null', '[]', '42', '{"provider":"claude","at":"invalid"}'])('retains uncertainty for unusable policy evidence: %s', row => {
  root = mkdtempSync(join(tmpdir(), 'claude-policy-reader-'));
  writeFileSync(join(root, '2026-09-01.jsonl'), row + '\n');
  expect(parsePolicyLog(root, 0, Date.parse('2026-09-21T00:00:00Z'))).toEqual({ entries: [], unparsableLines: 1 });
});

it('excludes known future policy files and other providers without inventing damage', () => {
  root = mkdtempSync(join(tmpdir(), 'claude-policy-window-'));
  writeFileSync(join(root, '2026-09-22.jsonl'), '{');
  writeFileSync(join(root, '2026-09-21.jsonl'), JSON.stringify({ provider: 'claude', at: '2026-09-21T00:00:00Z' }));
  writeFileSync(join(root, '2026-09-01.jsonl'), JSON.stringify({ provider: 'codex', at: 'invalid' }) + '\n');
  expect(parsePolicyLog(root, 0, Date.parse('2026-09-21T00:00:00Z'))).toEqual({ entries: [], unparsableLines: 0 });
});
