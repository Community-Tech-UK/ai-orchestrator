import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { collectSubagentSessions, aggregateSubagentMetrics, evaluateSubagentVerdict, type ParentSessionRecord } from '../claude-cost-audit-report.mjs';
import { parseTranscript } from '../lib/claude-transcripts.mjs';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
it.skipIf(spawnSync('sqlite3', ['--version']).status !== 0)('propagates lost usage through the real reader, collector, verdict and CLI, preserving zero and negative controls', async () => {
  root = mkdtempSync(join(tmpdir(), 'claude-usage-completeness-'));
  const projects = join(root, 'projects'), userData = join(root, 'userdata'), policy = join(userData, 'session-policy');
  const start = Date.parse('2026-09-01T00:00:00Z'), end = start + 20 * 86_400_000;
  const iso = (at: number) => new Date(at).toISOString();
  const priceData = { 'claude-sonnet-4-5': { inputPerMTok: 1, outputPerMTok: 1 }, 'claude-opus-4-7': { inputPerMTok: 2, outputPerMTok: 2 } };
  const prices = join(root, 'prices.json');
  mkdirSync(policy, { recursive: true });
  writeFileSync(prices, JSON.stringify(priceData));
  const policies: Record<string, unknown>[] = [], items: { id: string; landed_commit: string; updated_at: number }[] = [];
  const helpers: { file: string; first: string; last: string; model: string; at: number }[] = [];
  const parents: { file: string; entries: Record<string, unknown>[] }[] = [];
  for (const arm of ['sonnet', 'same-as-session'] as const) {
    const id = arm === 'sonnet' ? 'fixture-1' : 'fixture-a';
    policies.push({ at: iso(start), provider: 'claude', sessionId: id, setting: 'trial', arm, armKey: id,
      applied: arm === 'sonnet', reviewerRuleDelivered: true, waitingRuleDelivered: false });
    items.push({ id, landed_commit: 'fixture-landed', updated_at: end - 1 });
    const dir = join(projects, 'fixture', id, 'subagents'); mkdirSync(dir, { recursive: true });
    const parent: Record<string, unknown>[] = [];
    for (let i = 0; i < 300; i++) {
      const at = start + 86_400_000 + i * 1_000, tool = `tool-${i}`;
      const model = arm === 'sonnet' ? 'claude-sonnet-4-5' : 'claude-opus-4-7';
      const request = (n: number, input: number) => JSON.stringify({ type: 'assistant', timestamp: iso(at + n),
        message: { id: `helper-${i}-${n}`, model, usage: { input_tokens: input, output_tokens: 0 } } });
      const first = request(2, 500), last = request(50, arm === 'sonnet' ? 2_500 : 500);
      const file = join(dir, `agent-${i}.jsonl`);
      writeFileSync(file.replace('.jsonl', '.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: tool, description: 'Implement fixture' }));
      writeFileSync(file, first + '\n' + last + '\n');
      if (arm === 'sonnet') helpers.push({ file, first, last, model, at });
      parent.push({ type: 'user', uuid: `turn-${i}`, timestamp: iso(at), message: { content: 'Fixture task' } },
        { type: 'assistant', timestamp: iso(at + 1), message: { id: `parent-${i}`, model: 'claude-opus-4-7',
          usage: { input_tokens: 1_000, output_tokens: 0 }, content: [{ type: 'tool_use', id: tool, name: 'Task', input: {} }] } },
        { type: 'user', timestamp: iso(at + 100), message: { content: [{ type: 'tool_result', tool_use_id: tool, is_error: false, content: 'Complete' }] } });
    }
    const file = join(projects, 'fixture', id + '.jsonl');
    writeFileSync(file, parent.map(row => JSON.stringify(row)).join('\n')); parents.push({ file, entries: parent });
  }
  writeFileSync(join(policy, 'fixture.jsonl'), policies.map(row => JSON.stringify(row)).join('\n'));
  const loop = join(userData, 'loop-mode', 'loop-mode.db'); mkdirSync(join(userData, 'loop-mode'));
  execFileSync('sqlite3', [loop, `CREATE TABLE plan_queue_items (id TEXT, state TEXT, landed_commit TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE loop_iterations (loop_run_id TEXT, tokens INTEGER, cost_cents INTEGER, started_at INTEGER);
    ${items.map(row => `INSERT INTO plan_queue_items VALUES ('${row.id}', 'landed', '${row.landed_commit}', ${start}, ${row.updated_at});`).join('\n')}`]);
  const measure = async () => {
    const sessions = await collectSubagentSessions(projects, priceData);
    return aggregateSubagentMetrics(sessions, { sinceMs: start, untilMs: end, policyEntries: policies, items, prices: priceData });
  };
  const cli = () => execFileSync(process.execPath, ['scripts/claude-cost-audit-report.mjs', '--subagents', '--userdata', userData,
    '--projects', projects, '--prices', prices, '--since', iso(start), '--until', iso(end)], {
    encoding: 'utf8', env: { ...process.env, AIO_COST_ATTRIBUTION_DIR: join(root, 'no-attribution'), AIO_COST_AUDIT_SQLITE_DRIVER: 'cli' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const intact = await measure();
  expect(intact.arms.sonnet.spendUsd).toBeCloseTo(0.9);
  expect(evaluateSubagentVerdict(intact).verdict).toContain('spend saving below the rule');
  expect(cli()).toContain('**keep-same-as-session (spend saving below the rule)**');
  for (const h of helpers) writeFileSync(h.file, h.first + '\n' + h.last.slice(0, -1) + '\n');
  const damaged = await measure();
  expect(damaged.sample).toEqual(intact.sample);
  expect(damaged.planQueue).toEqual(intact.planQueue);
  expect(damaged.arms.sonnet.unknownUsageRecords).toBe(300);
  expect(damaged.arms.sonnet.spendUsd).toBeNull();
  expect(damaged.arms['same-as-session'].spendUsd).toBeCloseTo(0.6);
  expect(evaluateSubagentVerdict(damaged).verdict).toBe('pending (helper spend evidence)');
  expect(cli()).toContain('**pending (helper spend evidence)**');
  // Entirely lost helper usage still retains its known parent lifecycle and sample membership.
  for (const h of helpers) writeFileSync(h.file, h.first.slice(0, -1) + '\n' + h.last.slice(0, -1) + '\n');
  const entirelyLost = await measure();
  expect(entirelyLost.sample).toEqual(intact.sample);
  expect(entirelyLost.arms.sonnet.unknownUsageRecords).toBe(600);
  expect(evaluateSubagentVerdict(entirelyLost).verdict).toBe('pending (helper spend evidence)');
  for (const h of helpers) writeFileSync(h.file, JSON.stringify({ type: 'assistant', timestamp: iso(h.at + 2),
    message: { id: 'zero', model: h.model, usage: { input_tokens: 0, output_tokens: 0 } } }));
  const zero = await measure();
  expect(zero.arms.sonnet.spendUsd).toBe(0);
  expect(zero.arms.sonnet.unknownUsageRecords).toBe(0);
  expect(evaluateSubagentVerdict(zero).verdict).toBe('adopt-sonnet');
  expect(cli()).toContain('**adopt-sonnet**');
  // Omitted optional cache counters and the absent cache split above are supported, measured usage.
  expect((await parseTranscript(helpers[0].file)).unknownUsageRecords).toBe(0);
  for (const h of helpers) writeFileSync(h.file, h.first + '\n' + h.last.slice(0, -1) + '\n');
  for (let i = 0; i < 30; i++) {
    const entry = parents[0].entries[i * 3 + 2] as { message: { content: { is_error: boolean }[] } };
    entry.message.content[0].is_error = true;
  }
  writeFileSync(parents[0].file, parents[0].entries.map(row => JSON.stringify(row)).join('\n'));
  expect(evaluateSubagentVerdict(await measure()).verdict).toContain('quality sign failed');
  expect(cli()).toContain('spend unknown and a quality sign failed');
}, 30_000);

it('accepts absent and SDK-null optional cache counters, and exposes supplied invalid usage', async () => {
  root = mkdtempSync(join(tmpdir(), 'claude-usage-counters-'));
  const file = join(root, 'fixture.jsonl');
  for (const usage of [
    { input_tokens: 0, output_tokens: 0 },
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: null, cache_creation_input_tokens: null, cache_creation: null },
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ]) {
    writeFileSync(file, JSON.stringify({ type: 'assistant', timestamp: '2026-09-01T00:00:00Z', message: { id: 'fixture', model: 'sonnet', usage } }));
    const parsed = await parseTranscript(file);
    expect(parsed.unknownUsageRecords).toBe(0);
    expect(parsed.requests[0]).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  }
  writeFileSync(file, JSON.stringify({ type: 'assistant', timestamp: '2026-09-01T00:00:00Z',
    message: { id: 'invalid', model: 'sonnet', usage: { input_tokens: -1, output_tokens: 0 } } }));
  expect((await parseTranscript(file)).unknownUsageRecords).toBe(1);
  for (const usage of ['invalid-usage', { input_tokens: 0, output_tokens: 0, cache_creation: 'invalid-split' }]) {
    writeFileSync(file, JSON.stringify({ type: 'assistant', timestamp: '2026-09-01T00:00:00Z',
      message: { id: 'invalid-shape', model: 'sonnet', usage } }));
    expect((await parseTranscript(file)).unknownUsageRecords).toBe(1);
  }
});

it.each(['known', 'after', 'unplaced', 'outside', 'before', 'before-runtime'] as const)('judges waiting-rule usage in its own population (%s)', mode => {
  const from = Date.parse('2026-09-01T00:00:00Z'), to = from + 20 * 86_400_000, activation = from + 10 * 86_400_000;
  const trials: ParentSessionRecord[] = (['sonnet', 'same-as-session'] as const).map((arm, j) => ({
    sessionId: j ? 'trial-a' : 'trial-1', arm, parentModel: 'opus', firstAt: from,
    subagents: Array.from({ length: 300 }, (_, i) => ({
      meta: { agentType: 'general-purpose' }, model: j ? 'opus' : 'sonnet', parentModel: 'opus',
      spendUsd: j ? 1 : 0.5, finalContext: 100, runMs: 1_000,
      firstAt: from + 1_000 + i * 100, lastAt: from + 1_050 + i * 100, returnedAt: from + 1_060 + i * 100,
      parentTurnId: String(i), isError: false, longWaits: [],
    })),
  }));
  const helper = (firstAt: number) => ({ meta: null, model: 'sonnet', parentModel: 'opus', spendUsd: 0.1,
    finalContext: 100, runMs: 1_000, firstAt, lastAt: firstAt + 1_000, isError: false, longWaits: [] });
  const beforeUnknown = mode === 'before' || mode === 'before-runtime';
  const waiting: ParentSessionRecord = {
    sessionId: 'nontrial-1', arm: 'sonnet', parentModel: 'opus', firstAt: from,
    unplacedUsageRecords: mode === 'unplaced' ? 1 : 0,
    subagents: [{ ...helper(activation - 100_000), unknownUsageRecords: beforeUnknown ? 1 : 0, longWaits: [
      { at: activation - 10, rewrittenTokens: 10, model: 'sonnet' },
      ...(!beforeUnknown ? [{ at: activation - 5, rewrittenTokens: 10, model: 'sonnet' }] : []),
    ] }, { ...helper(activation + 1_000), runMs: mode === 'before-runtime' ? 2_000 : 1_000,
      unknownUsageRecords: mode === 'after' ? 1 : 0,
      longWaits: beforeUnknown ? [{ at: activation + 1_500, rewrittenTokens: 10, model: 'sonnet' }] : [] },
    ...(mode === 'outside' ? [{ ...helper(to + 1_000), unknownUsageRecords: 1 }] : [])],
  };
  const policy: Record<string, unknown>[] = trials.map((session, j) => ({
    at: new Date(from).toISOString(), provider: 'claude', setting: 'trial', sessionId: session.sessionId,
    arm: session.arm, armKey: String(j), applied: j === 0, reviewerRuleDelivered: true,
  }));
  policy.push({ at: new Date(activation).toISOString(), provider: 'claude', sessionId: waiting.sessionId,
    setting: 'parent', reviewerRuleDelivered: false, waitingRuleDelivered: true });
  const metrics = aggregateSubagentMetrics([...trials, waiting], { sinceMs: from, untilMs: to, policyEntries: policy,
    items: [{ id: '0', landed_commit: 'fixture', updated_at: from + 2_000 }, { id: '1', landed_commit: 'fixture', updated_at: from + 2_000 }] });
  const uncertain = mode === 'after' || mode === 'unplaced' || beforeUnknown;
  expect(metrics.waitingRule.unknownUsageRecords).toBe(uncertain ? 1 : 0);
  const verdict = evaluateSubagentVerdict(metrics);
  expect(verdict.verdict).toBe('adopt-sonnet');
  expect(verdict.waitingRule).toBe(mode === 'before-runtime' ? 'report' : uncertain ? 'pending (waiting-rule usage evidence)' : 'keep');
});
