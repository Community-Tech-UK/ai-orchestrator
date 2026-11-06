import { collectSubagentSessions } from '../claude-cost-audit-report.mjs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activityReturns,
  measuredSummaryFloors,
  parseTranscript,
} from '../lib/claude-transcripts.mjs';
import {
  classifySession,
  pickCeiling,
  realSessionUsd,
  simulateSession,
  type CeilingRow,
} from '../context-ceiling-replay.mjs';

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, 'scripts/context-ceiling-replay.mjs');
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const prices = { 'test-model': { inputPerMTok: 1, outputPerMTok: 1 } };

function req(at: number, context: number, prevContext: number, extra?: {
  write5m?: number;
  write1h?: number;
  output?: number;
  model?: string;
}) {
  return {
    at,
    input: 0,
    cacheRead: prevContext,
    cacheWrite5m: extra?.write5m ?? context - prevContext,
    cacheWrite1h: extra?.write1h ?? 0,
    output: extra?.output ?? 10,
    model: extra?.model ?? 'test-model',
    context,
  };
}

describe('the sawtooth simulation', () => {
  it('books one summary at the ceiling and drops the context to the floor', () => {
    // Growth 50K, 50K, 100K → context 200K crosses 200K-33K after request 3.
    const requests = [
      req(1, 50_000, 0),
      req(2, 100_000, 50_000),
      req(3, 200_000, 100_000),
    ];
    // Hand-computed at 1 input-token unit ($1/Mtok):
    // r1 50000*1.25 + 10 = 62510; r2 50000*0.1 + 50000*1.25 + 10 = 67510;
    // r3 100000*0.1 + 100000*1.25 + 10 = 135010; summary 200000*0.1 + 1000 = 21000.
    const sim = simulateSession(requests, 200_000, 40_000, 1_000, prices);
    expect(sim.summaries).toBe(1);
    expect(sim.simulatedUsd).toBeCloseTo((62_510 + 67_510 + 135_010 + 21_000) / 1e6, 9);
    expect(realSessionUsd(requests, prices)).toBeCloseTo((62_510 + 67_510 + 135_010) / 1e6, 9);
  });

  it('never summarises without a ceiling', () => {
    const requests = [req(1, 50_000, 0), req(2, 900_000, 50_000)];
    const sim = simulateSession(requests, null, 40_000, 1_000, prices);
    expect(sim.summaries).toBe(0);
    expect(sim.simulatedUsd).toBeCloseTo(realSessionUsd(requests, prices), 9);
  });

  it('re-prices a real cold-cache write at the simulated size after a summary', () => {
    const requests = [
      req(1, 150_000, 0),
      req(2, 180_000, 150_000),
      // A real cold re-write after an idle gap: no cache read, the whole
      // 185K context is written again.
      { ...req(3, 185_000, 180_000, { write5m: 185_000 }), cacheRead: 0 },
    ];
    // r1 150000*1.25 + 10 = 187510; r2 150000*0.1 + 30000*1.25 + 10 = 52510;
    // summary 200000*0.1 + 1000 = 21000; r3 written at the simulated 45K:
    // 45000*1.25 + 10 = 56260 (not 185000*1.25 + 10 = 231260).
    const sim = simulateSession(requests, 200_000, 40_000, 1_000, prices);
    expect(sim.summaries).toBe(1);
    expect(sim.simulatedUsd).toBeCloseTo((187_510 + 52_510 + 21_000 + 56_260) / 1e6, 9);
    const real = realSessionUsd(requests, prices);
    expect(real).toBeCloseTo((187_510 + 52_510 + 231_260) / 1e6, 9);
  });
});

describe('transcript parsing', () => {
  it('de-duplicates assistant entries by message.id and drops <synthetic> entries', async () => {
    const dir = makeTempDir('ceiling-replay-parse-');
    const path = join(dir, 'session.jsonl');
    const lines = [
      assistant('m1', 1000, 500, 10, '2026-10-01T10:00:00.000Z'),
      assistant('m1', 1000, 500, 10, '2026-10-01T10:00:01.000Z'), // duplicate id
      assistant('m2', 0, 0, 5, '2026-10-01T10:05:00.000Z', '<synthetic>'),
      JSON.stringify({
        type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-01T10:06:00.000Z',
        compactMetadata: { trigger: 'auto', preTokens: 100_000, postTokens: 12_000 },
      }),
      assistant('m3', 0, 11_000, 1_000, '2026-10-01T10:07:00.000Z'),
    ];
    writeFileSync(path, lines.join('\n'));
    const parsed = await parseTranscript(path);
    expect(parsed.requests.map((r: { output: number }) => r.output)).toEqual([10, 1_000]);
    expect(parsed.compactions).toHaveLength(1);
    expect(parsed.compactions[0].postTokens).toBe(12_000);
    // The floor is the first request after the boundary: 11_000 cache-read + 1_000 output context.
    expect(measuredSummaryFloors(parsed)).toEqual([11_000]);
  });

  it('counts warm and cold returns from request gaps', () => {
    const parsed = {
      requests: [
        { ...req(0, 10_000, 0), cacheRead: 0, cacheWrite5m: 10_000 },
        { ...req(2 * 60_000, 10_500, 10_000), cacheRead: 10_000, cacheWrite5m: 500 }, // 2 min: not a return
        // 10 min gap: warm return that kept 5,000 of the previous 10,500 context.
        { ...req(12 * 60_000, 11_000, 10_500), cacheRead: 5_000, cacheWrite5m: 6_000 },
        // 68 min gap: cold return that re-wrote 11,500 tokens.
        { ...req(80 * 60_000, 11_500, 11_000), cacheRead: 0, cacheWrite5m: 11_500 },
      ],
      compactions: [],
      entrypoint: null,
      isHarness: false,
    };
    const returns = activityReturns(parsed);
    expect(returns).toHaveLength(2);
    expect(returns[0].cold).toBe(false);
    expect(returns[0].keptCacheShare).toBeCloseTo(5_000 / 10_500, 6);
    expect(returns[1].cold).toBe(true);
    expect(returns[1].rewrittenTokens).toBe(11_500);
  });
});

describe('session classes', () => {
  const lookup = {
    purposeOf(sessionId: string): string | null {
      return sessionId === 'joined' ? 'plan-queue' : null;
    },
  };

  it('splits subagent, harness-with-join, unclassified and own-chat', () => {
    expect(classifySession({ kind: 'subagent', sessionId: 'x', isHarness: false }, lookup)).toBe('subagent');
    expect(classifySession({ kind: 'main', sessionId: 'joined', isHarness: true }, lookup)).toBe('plan-queue');
    expect(classifySession({ kind: 'main', sessionId: 'bare', isHarness: true }, lookup)).toBe('unclassified');
    expect(classifySession({ kind: 'main', sessionId: 'mine', isHarness: false }, lookup)).toBe('own-chat');
  });
});

describe('the decision rule', () => {
  function row(savingUsd: number, p90: number | null): CeilingRow {
    return {
      realUsd: savingUsd * 2,
      simulatedUsd: savingUsd,
      savingUsd,
      sessions: 10,
      summarisingShare: 0.5,
      summariesP50: 1,
      summariesP90: p90,
    };
  }

  it('takes the smallest ceiling that keeps 80% of the 200K saving and fits the p90 cap', () => {
    const rows = {
      200000: row(100, 5),
      250000: row(90, 3),
      300000: row(80, 2),
      400000: row(70, 1),
      600000: row(40, 0),
      none: row(0, 0),
    };
    // 250K keeps 90% but its p90 (3) is above the own-chat cap (2) → 300K.
    expect(pickCeiling(rows, 2).ceiling).toBe(300000);
    // The harness cap (3) admits 250K, the smallest qualifying ceiling.
    expect(pickCeiling(rows, 3).ceiling).toBe(250000);
  });

  it('80% is inclusive and 79.9% is not', () => {
    const rows = {
      200000: row(100, 5),
      250000: row(80, 2),
      300000: row(70, 1),
      400000: row(50, 1),
      600000: row(10, 1),
      none: row(0, 0),
    };
    expect(pickCeiling(rows, 2).ceiling).toBe(250000);
    const tight = { ...rows, 250000: row(79.9, 2) };
    expect(pickCeiling(tight, 2).ceiling).toBeNull();
  });

  it('a p90 above the cap blocks that ceiling', () => {
    const rows = {
      200000: row(100, 3),
      250000: row(95, 3),
      300000: row(90, 3),
      400000: row(85, 2),
      600000: row(60, 1),
      none: row(0, 0),
    };
    expect(pickCeiling(rows, 2).ceiling).toBe(400000);
  });
});

// ── End-to-end fixture tree ─────────────────────────────────────────────────

function assistant(id: string, input: number, cacheRead: number, output: number, timestamp: string, model = 'test-model'): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    entrypoint: 'cli',
    message: {
      id,
      model,
      role: 'assistant',
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: 0,
        output_tokens: output,
      },
    },
  });
}

describe('context-ceiling-replay (end to end)', () => {
  it('prints the table per class, the decision rule and the two extra sections', () => {
    const root = makeTempDir('ceiling-replay-e2e-');
    const projectsDir = join(root, 'projects');
    const userData = join(root, 'userData');
    const munged = join(projectsDir, '-fixture');
    mkdirSync(join(munged, 'own-session', 'subagents'), { recursive: true });
    mkdirSync(userData, { recursive: true });

    // An own-chat session that grows to 200K so a 200K ceiling summarises once.
    const own = [assistant('o1', 0, 0, 10, '2026-10-01T10:00:00.000Z')];
    own.push(assistant('o2', 0, 200_000, 10, '2026-10-01T10:10:00.000Z'));
    writeFileSync(join(munged, 'own-session.jsonl'), own.join('\n'));

    // A Harness session (sdk-cli + [Tool Permissions]) with a subagent file.
    const harness = [
      JSON.stringify({
        type: 'user', timestamp: '2026-10-01T11:00:00.000Z',
        message: { role: 'user', content: 'Run the queue item. [Tool Permissions]' },
      }),
      assistant('h1', 0, 0, 10, '2026-10-01T11:00:01.000Z'),
    ];
    writeFileSync(join(munged, 'harness-session.jsonl'), harness.map((l, i) =>
      i === 0 ? l : JSON.stringify({ ...JSON.parse(l), entrypoint: 'sdk-cli' })).join('\n'));
    writeFileSync(join(munged, 'own-session', 'subagents', 'agent-a1.jsonl'),
      assistant('s1', 0, 0, 10, '2026-10-01T11:05:00.000Z'));

    const result = spawnSync(process.execPath, [
      scriptPath,
      '--projects', projectsDir,
      '--userdata', userData,
      '--resume-cache',
      '--cold-returns',
    ], { encoding: 'utf8' });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status).toBe(0);
    expect(output).toContain('## own-chat');
    expect(output).toContain('## unclassified');
    expect(output).toContain('## subagent');
    expect(output).toContain('## Decision rule');
    expect(output).toContain('--resume-cache (the Step 4 guard)');
    expect(output).toContain('--cold-returns');
    expect(output).toContain('| 200K |');
    expect(output).toContain('| none |');

    // R5M6 W11: the report states the rule's own selection, never a hard-coded 400K / 300K proposal.
    expect(output).not.toContain('Proposed starting values');
    expect(output).not.toContain('400K for own chats');
    const json = spawnSync(process.execPath, [scriptPath, '--projects', projectsDir, '--userdata', userData, '--json'],
      { encoding: 'utf8' });
    expect(json.status).toBe(0);
    const { decision } = JSON.parse(json.stdout);
    const label = (ceiling: number | null) => (ceiling === null ? 'none' : `${ceiling / 1000}K`);
    const rule = output.split('## Decision rule')[1]!;
    expect(rule).toContain(`- own chats → ceiling ${label(decision.ownChat.ceiling)} (${decision.ownChat.reason})`);
    expect(rule).toContain(`- Harness-started work → ceiling ${label(decision.harness.ceiling)} (${decision.harness.reason})`);
  });
});


describe('raw cache-creation split reaches actual report consumers', () => {
  function raw(creation?: Record<string, number>, total = 100_000, id = 'split') {
    return JSON.stringify({ type: 'assistant', timestamp: '2026-09-01T10:00:00Z', entrypoint: 'cli',
      message: { id, role: 'assistant', model: 'test-model', usage: {
        input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
        cache_creation_input_tokens: total, ...(creation ? { cache_creation: creation } : {}),
      } } });
  }
  it.each([
    [{ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100_000 }, 100_000, 0, 100_000],
    [{ ephemeral_5m_input_tokens: 100_000, ephemeral_1h_input_tokens: 0 }, 100_000, 100_000, 0],
    [{ ephemeral_5m_input_tokens: 40_000, ephemeral_1h_input_tokens: 60_000 }, 100_000, 40_000, 60_000],
    [{ ephemeral_1h_input_tokens: 100_000 }, 100_000, 0, 100_000],
    [undefined, 100_000, 100_000, 0],
    [{ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, 0, 0, 0],
  ] as const)('prices raw split %j with aggregate %s once', async (creation, total, short, long) => {
    const dir = makeTempDir('cache-split-');
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, raw(creation, total));
    const parsed = await parseTranscript(file);
    expect(parsed.requests).toHaveLength(1);
    expect(parsed.requests[0]).toMatchObject({ cacheWrite5m: short, cacheWrite1h: long, context: total });
    expect(realSessionUsd(parsed.requests, prices)).toBeCloseTo((short * 1.25 + long * 2) / 1e6, 10);
  });

  it('the real replay CLI never invents a summary for a 100K one-hour-only write', () => {
    const root = makeTempDir('cache-split-replay-');
    const project = join(root, 'projects', 'fixture');
    const userData = join(root, 'userdata');
    mkdirSync(project, { recursive: true }); mkdirSync(userData);
    const entry = raw({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100_000 });
    const synthetic = JSON.parse(raw(undefined, 100_000, 'synthetic'));
    synthetic.message.model = '<synthetic>';
    writeFileSync(join(project, 'session.jsonl'), [entry, entry, JSON.stringify(synthetic)].join('\n'));
    const result = spawnSync(process.execPath, [scriptPath, '--projects', join(root, 'projects'),
      '--userdata', userData, '--json', '--prices', JSON.stringify(prices)], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.classes['own-chat'].none.realUsd).toBeCloseTo(0.2, 10);
    expect(report.classes['own-chat']['200000']).toMatchObject({ summarisingShare: 0, summariesP90: null });
  });

  it('the actual helper cost audit consumer receives the same single one-hour write', async () => {
    const root = makeTempDir('cache-split-helper-');
    const project = join(root, 'project');
    const children = join(project, 'parent', 'subagents');
    mkdirSync(children, { recursive: true });
    writeFileSync(join(project, 'parent.jsonl'), raw(undefined, 0, 'parent'));
    writeFileSync(join(children, 'agent-child.jsonl'), raw({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100_000 }));
    writeFileSync(join(children, 'agent-child.meta.json'), JSON.stringify({ agentType: 'general-purpose' }));
    const sessions = await collectSubagentSessions(root, prices);
    expect(sessions[0].subagents[0]).toMatchObject({ spendUsd: 0.2, finalContext: 100_000 });
  });
});

describe('--resume-cache measures restarts within 55 minutes, after edits, that kept 90% of the context', () => {
  const MIN = 60_000;
  const T0 = Date.parse('2026-10-01T10:00:00.000Z');
  const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

  function editEntry(id: string, offsetMs: number): string {
    return JSON.stringify({
      type: 'assistant', timestamp: iso(offsetMs), entrypoint: 'cli',
      message: { id, model: 'test-model', role: 'assistant',
        content: [{ type: 'tool_use', id: `tu-${id}`, name: 'Edit', input: { file_path: '/x' } }],
        usage: { input_tokens: 0, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0, output_tokens: 5 } },
    });
  }

  function costState(lines: { added: number; removed: number } | null): string {
    return JSON.stringify({ type: 'cost-state', sessionId: 's', totalCostUSD: 1, ...(lines ? { totalLinesAdded: lines.added, totalLinesRemoved: lines.removed } : {}) });
  }

  /** A 100K-context request, then a process end, then a restart `gapMs` later that reads `cacheRead` tokens. */
  function session(name: string, gapMs: number, cacheRead: number, edit: 'tool' | 'none' | 'unknown', endRecord = true): string[] {
    const before = edit === 'tool'
      ? [editEntry(`${name}-a`, 0)]
      : [assistant(`${name}-a`, 0, 100_000, 5, iso(0))];
    const end = !endRecord ? [] : [costState(edit === 'unknown' ? null : { added: 0, removed: 0 })];
    return [...before, ...end, assistant(`${name}-b`, 0, cacheRead, 5, iso(gapMs))];
  }

  it('excludes ordinary cache expiry, no-edit and cold restarts, counts unknowns apart', () => {
    const root = makeTempDir('ceiling-replay-resume-');
    const projectsDir = join(root, 'projects');
    const userData = join(root, 'userData');
    const munged = join(projectsDir, '-fixture');
    mkdirSync(munged, { recursive: true });
    mkdirSync(userData, { recursive: true });
    const write = (name: string, lines: string[]) => writeFileSync(join(munged, `${name}.jsonl`), lines.join('\n'));
    write('idle-no-edits', session('idle', 6 * MIN, 95_000, 'none'));       // 6-minute idle, no edits: excluded
    write('edited-kept', session('keep', 10 * MIN, 95_000, 'tool'));        // edited, within 55 min, kept 95%: kept
    write('edited-lost', session('lost', 10 * MIN, 50_000, 'tool'));        // edited, within 55 min, kept 50%: not kept
    write('edited-cold', session('cold', 70 * MIN, 0, 'tool'));             // over 55 minutes: excluded
    write('unknown', session('unk', 10 * MIN, 95_000, 'unknown'));          // nothing says whether it edited: unknown
    write('expiry-only', session('exp', 10 * MIN, 95_000, 'tool', false));  // 10-minute gap, no process end: not a restart

    const result = spawnSync(process.execPath, [scriptPath, '--projects', projectsDir, '--userdata', userData, '--json'],
      { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const resume = JSON.parse(result.stdout).resumeCache;
    expect(resume).toMatchObject({
      restarts: 5,
      returns: 2,
      kept: 1,
      keptShare: 0.5,
      unknown: 1,
      unknownReasons: { edits: 1 },
      excludedNoEdits: 1,
      excludedCold: 1,
    });
    // Counting every unknown as a failure bounds the share from below.
    expect(resume.keptShareLowerBound).toBeCloseTo(1 / 3, 9);
  });
});
