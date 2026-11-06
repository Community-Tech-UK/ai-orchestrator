import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateSubagentMetrics, evaluateSubagentVerdict,
  type ParentSessionRecord, type SubagentArm,
} from '../claude-cost-audit-report.mjs';

const start = Date.parse('2026-10-01T00:00:00Z');
const end = start + 20 * 86_400_000;
const iso = (at: number) => new Date(at).toISOString();
const arms = ['sonnet', 'same-as-session'] as const;
const sessionId = (arm: SubagentArm) => arm === 'sonnet' ? 'fixture-session-a1' : 'fixture-session-a8';
const itemId = (arm: SubagentArm, index: number) => `${arm}-${index}`;
const policyEntries = arms.flatMap(arm => Array.from({ length: 20 }, (_, index) => ({
  provider: 'claude', sessionId: sessionId(arm), arm, armKey: itemId(arm, index),
  at: iso(start), setting: 'trial', applied: arm === 'sonnet',
  reviewerRuleDelivered: true, waitingRuleDelivered: false,
})));
const sessions: ParentSessionRecord[] = arms.map(arm => ({
  sessionId: sessionId(arm), arm, parentModel: 'claude-opus-4-7', firstAt: start,
  subagents: Array.from({ length: 300 }, (_, index) => ({
    meta: { agentType: 'general-purpose' },
    model: arm === 'sonnet' ? 'claude-sonnet-4-5' : 'claude-opus-4-7',
    parentModel: 'claude-opus-4-7', spendUsd: arm === 'sonnet' ? 0.5 : 1,
    finalContext: 1000, runMs: 1000,
    firstAt: start + 86_400_000 + index * 60_000,
    lastAt: start + 86_400_001 + index * 60_000,
    returnedAt: start + 86_400_002 + index * 60_000,
    parentTurnId: `turn-${index}`, isError: false, longWaits: [],
  })),
}));

function items(sonnetLanded = 16, unknownControl = 10, unknownSonnet = 0) {
  return arms.flatMap(arm => Array.from({ length: 20 }, (_, index) => ({
    id: itemId(arm, index),
    landed_commit: arm !== 'sonnet' || index < sonnetLanded ? 'fixture-landed' : null,
    updated_at: index < (arm === 'sonnet' ? unknownSonnet : unknownControl) ? null : start + 1000,
  })));
}

function aggregate(rows = items(), measuredSessions = sessions) {
  return aggregateSubagentMetrics(measuredSessions, {
    sinceMs: start, untilMs: end, policyEntries, items: rows,
  });
}

describe('unknown queue landing dates in the Claude helper trial', () => {
  it('withholds adoption when restoring only missing control dates reveals a quality regression', () => {
    const uncertain = aggregate();
    expect(uncertain.sample).toEqual({ days: 20, gp: { sonnet: 300, 'same-as-session': 300 } });
    expect(uncertain.planQueue.sonnet).toEqual({ items: 20, landed: 16 });
    expect(uncertain.planQueue['same-as-session']).toEqual({ items: 20, landed: 10 });
    expect(uncertain.planQueue.landedUnplaced).toBe(10);
    expect(evaluateSubagentVerdict(uncertain).verdict).toBe('pending (plan-queue landing evidence)');

    const restored = aggregate(items(16, 0));
    expect(restored.arms).toEqual(uncertain.arms);
    expect(restored.planQueue['same-as-session']).toEqual({ items: 20, landed: 20 });
    expect(evaluateSubagentVerdict(restored).verdict)
      .toBe('keep-same-as-session-for-chats (spend falls but a quality sign failed; report)');
  });

  it('adopts with unknown dates only when the worst possible drop still meets the ten-point rule', () => {
    // Control may be 50-100%, but Sonnet is known to be 90%: at worst a
    // ten-point drop, exactly the allowed edge. One fewer known landing is not safe.
    expect(evaluateSubagentVerdict(aggregate(items(18))).verdict).toBe('adopt-sonnet');
    expect(evaluateSubagentVerdict(aggregate(items(17))).verdict).toBe('pending (plan-queue landing evidence)');
  });

  it('does not mistake unknown Sonnet dates for a measured regression', () => {
    // Sonnet is 80-100%, control 100%. Only after the four dates are placed
    // outside the window is the twenty-point loss independently measured.
    const rows = items(20, 0, 4);
    expect(evaluateSubagentVerdict(aggregate(rows)).verdict).toBe('pending (plan-queue landing evidence)');
    const placedLater = rows.map(row => ({ ...row, updated_at: row.updated_at ?? end }));
    expect(evaluateSubagentVerdict(aggregate(placedLater)).verdict)
      .toBe('keep-same-as-session-for-chats (spend falls but a quality sign failed; report)');
  });

  it('preserves measured losses, reviewer vetoes and sample ordering despite unknown dates', () => {
    expect(evaluateSubagentVerdict(aggregate(items(10, 2))).verdict)
      .toBe('keep-same-as-session-for-chats (spend falls but a quality sign failed; report)');
    const errorSessions = sessions.map(s => ({ ...s, subagents: s.subagents.map((a, i) => ({
      ...a, isError: s.arm === 'sonnet' && i < 30,
    })) }));
    expect(evaluateSubagentVerdict(aggregate(items(), errorSessions)).verdict)
      .toBe('keep-same-as-session-for-chats (spend falls but a quality sign failed; report)');
    const noSaving = aggregate();
    noSaving.arms.sonnet.spendPerSessionUsd = noSaving.arms['same-as-session'].spendPerSessionUsd;
    expect(evaluateSubagentVerdict(noSaving).verdict).toBe('keep-same-as-session (spend saving below the rule)');
    const short = aggregate();
    short.sample.days = 13;
    expect(evaluateSubagentVerdict(short).verdict).toBe('pending (sample)');
    short.arms.sonnet.reviewerGuardChecked = 1;
    short.arms.sonnet.reviewerGuardViolations = 1;
    expect(evaluateSubagentVerdict(short).verdict).toBe('do-not-adopt (the reviewer rule must be firmer first)');
  });
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('judges unusable SQLite landing dates conservatively through the actual CLI, paired with restored dates', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-landing-evidence-'));
  tempDirs.push(root);
  const projects = join(root, 'projects');
  const userData = join(root, 'userData');
  const policyDir = join(userData, 'session-policy');
  mkdirSync(policyDir, { recursive: true });
  mkdirSync(join(userData, 'loop-mode'), { recursive: true });
  writeFileSync(join(policyDir, 'fixture.jsonl'), policyEntries.map(row => JSON.stringify(row)).join('\n'));
  // Actual transcript parsing, parent turn/return evidence and prices. Price
  // overrides make the saving exactly 50%, independent of catalog changes.
  const prices = join(root, 'prices.json');
  writeFileSync(prices, JSON.stringify({
    'claude-sonnet-4-5': { inputPerMTok: 1, outputPerMTok: 1 },
    'claude-opus-4-7': { inputPerMTok: 2, outputPerMTok: 2 },
  }));
  for (const session of sessions) {
    const dir = join(projects, '-fixture', session.sessionId, 'subagents');
    mkdirSync(dir, { recursive: true });
    const parent = session.subagents.flatMap((a, i) => {
      const tool = `fixture-tool-${i}`;
      writeFileSync(join(dir, `agent-${i}.meta.json`), JSON.stringify({
        agentType: 'general-purpose', toolUseId: tool, description: 'Implement fixture',
      }));
      writeFileSync(join(dir, `agent-${i}.jsonl`), JSON.stringify({
        type: 'assistant', timestamp: iso(a.firstAt), message: { id: `helper-${i}`, model: a.model,
          usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      }));
      return [
        { type: 'user', uuid: `turn-${i}`, timestamp: iso(a.firstAt - 2), message: { content: 'Fixture task' } },
        { type: 'assistant', timestamp: iso(a.firstAt - 1), message: {
          id: `parent-${i}`, model: 'claude-opus-4-7', content: [{ type: 'tool_use', id: tool, name: 'Task', input: {} }],
          usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        } },
        { type: 'user', timestamp: iso(a.returnedAt!), message: {
          content: [{ type: 'tool_result', tool_use_id: tool, is_error: false, content: 'Fixture complete' }],
        } },
      ];
    });
    writeFileSync(join(projects, '-fixture', `${session.sessionId}.jsonl`), parent.map(row => JSON.stringify(row)).join('\n'));
  }
  const schema = readFileSync(join(process.cwd(), 'src/main/orchestration/loop-schema.ts'), 'utf8');
  const migrationSql = [...schema.matchAll(/up: `([\s\S]*?)`/g)].map(match => match[1]).join('\n');
  expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS plan_queue_items');
  const db = join(userData, 'loop-mode/loop-mode.db');
  execFileSync('sqlite3', [db, migrationSql]);
  const seed = (rows: ReturnType<typeof items>) => execFileSync('sqlite3', [db,
    `DELETE FROM plan_queue_items; INSERT INTO plan_queue_items
      (id, run_id, document_path, state, landed_commit, created_at, updated_at) VALUES ` + rows.map(row =>
      `('${row.id}', 'fixture-run', '/fixture/${row.id}_plan.md', '${row.landed_commit ? 'landed' : 'queued'}',
       ${row.landed_commit ? "'fixture-landed'" : 'NULL'}, ${start}, ${row.updated_at ?? "'unusable-time-placeholder'"})`,
    ).join(',') + ';',
  ]);
  const run = () => {
    const result = spawnSync(process.execPath, [join(process.cwd(), 'scripts/claude-cost-audit-report.mjs'),
      '--subagents', '--userdata', userData, '--projects', projects,
      '--prices', prices, '--since', iso(start), '--until', iso(end)], {
      encoding: 'utf8', env: { ...process.env, AIO_COST_ATTRIBUTION_DIR: join(root, 'attribution'), AIO_COST_AUDIT_SQLITE_DRIVER: 'cli' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('elapsed 20.0 days');
    expect(result.stdout.match(/general-purpose 300/g)).toHaveLength(2);
    expect(result.stdout).toContain('50.0% lower');
    expect(result.stdout).toContain('0/0 helper lifecycles unknown');
    return result.stdout;
  };
  seed(items());
  const unknown = run();
  seed(items(16, 0));
  const restored = run();
  expect(restored).toContain('| same-as-session | 20 | 20 | 100.0% |');
  expect(restored).toContain('Claude helper model: **keep-same-as-session-for-chats');
  expect(unknown).toContain('| same-as-session | 20 | 10 | 50.0% |');
  expect(unknown).toContain('Landings without a usable updated_at (unknown, not counted as landed): 10.');
  expect(unknown).toContain('Claude helper model: **pending (plan-queue landing evidence)**');
  expect(unknown).not.toContain('**adopt-sonnet**');
}, 15_000);
