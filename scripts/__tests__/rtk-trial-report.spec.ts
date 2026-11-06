import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootstrapMeanInterval,
  evaluateBenefit,
  evaluateCost,
  evaluateG1,
  evaluateG2,
  evaluateG3,
  evaluateG5,
  evaluateTrial,
  readBashCalls,
  readTrialCostRows,
  recommendTrial,
} from '../rtk-trial-report.mjs';

function baseMetrics(overrides = {}) {
  return {
    onSessions: 80,
    offSessions: 80,
    onTurnsPerSession: 4,
    offTurnsPerSession: 4,
    onCallsPerSession: 10,
    offCallsPerSession: 10,
    rewrittenTotal: 500,
    rewrittenFail: 2,
    otherTotal: 300,
    otherFail: 1,
    retryAfterRewrite: 5,
    onMedianCharsRewritten: 700,
    offMedianChars: 2_000,
    onCostPerTurn: 0.0101,
    offCostPerTurn: 0.01,
    ...overrides,
  };
}

function seededReport(
  root: string,
  costRows: Record<string, unknown>[],
  hookRows: Record<string, unknown>[],
  transcripts: Record<string, string | null>,
) {
  const userData = path.join(root, 'userdata');
  const costDir = path.join(userData, 'cost-attribution');
  const hookDir = path.join(userData, 'rtk', 'hook-decisions');
  const projectDir = path.join(root, 'projects', 'project');
  for (const directory of [costDir, hookDir, projectDir]) mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(costDir, 'cost.jsonl'), costRows.map(row => JSON.stringify(row)).join('\n'));
  writeFileSync(path.join(hookDir, '2026-10-20.jsonl'), hookRows.map(row => JSON.stringify(row)).join('\n'));
  for (const [sessionId, command] of Object.entries(transcripts)) {
    const content = command === null ? [{ type: 'text', text: 'done' }]
      : [{ type: 'tool_use', id: 'bash', name: 'Bash', input: { command } }];
    writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), JSON.stringify({
      timestamp: '2026-10-20T10:00:00Z', message: { content },
    }) + '\n');
  }
  const output = execFileSync(process.execPath, [
    path.join(process.cwd(), 'scripts', 'rtk-trial-report.mjs'), '--since', '2026-10-01',
    '--userdata', userData, '--json',
  ], { encoding: 'utf8', env: { ...process.env, AIO_RTK_TRIAL_PROJECTS_DIR: path.join(root, 'projects') } });
  return JSON.parse(output);
}

describe('bootstrapMeanInterval (A13, Step 18b)', () => {
  it('is deterministic and brackets the sample mean', () => {
    const values = [0.01, 0.02, 0.015, 0.012, 0.018];
    const a = bootstrapMeanInterval(values, { seed: 7 });
    const b = bootstrapMeanInterval(values, { seed: 7 });
    expect(a).toEqual(b);
    expect(a.point).toBeCloseTo(0.015, 5);
    expect(a.lo).toBeLessThanOrEqual(a.point);
    expect(a.hi).toBeGreaterThanOrEqual(a.point);
  });

  it('handles an empty sample', () => {
    expect(bootstrapMeanInterval([])).toEqual({ point: 0, lo: 0, hi: 0 });
  });
});

describe('guardrail verdicts', () => {
  it('never recommends rollout before the sample is ready and limits unmeasured loops to sessions', () => {
    const verdicts = evaluateTrial(baseMetrics());
    expect(recommendTrial(verdicts, { sampleReady: false, stopReached: false })).toBe('pending');
    expect(recommendTrial(verdicts, { sampleReady: true, stopReached: false })).toBe('sessions-only');
    expect(recommendTrial(evaluateTrial(baseMetrics({ rewrittenFail: 20 })), { sampleReady: true, stopReached: false })).toBe('off');
  });
  it('all criteria pass on a healthy sample', () => {
    const verdicts = evaluateTrial(baseMetrics());
    const byName = Object.fromEntries(verdicts.map((v) => [v.name, v]));
    expect(byName['G1 rewritten-call failures'].pass).toBe(true);
    expect(byName['G2 Bash calls per session'].pass).toBe(true);
    expect(byName['G3 turns per session'].pass).toBe(true);
    expect(byName['G5 retry-after-rewrite'].pass).toBe(true);
    expect(byName['Benefit: shorter tool results'].pass).toBe(true);
    expect(byName['Cost per turn'].pass).toBe(true);
  });

  it('G1 fails when rewritten calls fail more than 1pp more often', () => {
    const pass = evaluateG1(baseMetrics());
    expect(pass.pass).toBe(true);
    // 4% rewritten failure vs 0.3% other → 3.7pp over the line.
    const breach = evaluateG1(baseMetrics({ rewrittenFail: 20, otherFail: 1 }));
    expect(breach.pass).toBe(false);
  });

  it('G1 allows the exactly-1.0pp rule edge and fails only past it', () => {
    // 49 of 1000 rewritten vs 39 of 1000 other is exactly 1.0pp at rule
    // precision; binary subtraction reports 1.0000000000000004.
    const edge = evaluateG1(baseMetrics({ rewrittenTotal: 1_000, rewrittenFail: 49, otherTotal: 1_000, otherFail: 39 }));
    expect(edge.pass).toBe(true);
    expect(edge.detail).toContain('Δ 1.0pp');
    const breach = evaluateG1(baseMetrics({ rewrittenTotal: 1_000, rewrittenFail: 50, otherTotal: 1_000, otherFail: 39 }));
    expect(breach.pass).toBe(false);
  });

  it('an exactly-1.0pp G1 edge does not turn an immature trial off', () => {
    const verdicts = evaluateTrial(baseMetrics({ rewrittenTotal: 1_000, rewrittenFail: 49, otherTotal: 1_000, otherFail: 39 }));
    expect(recommendTrial(verdicts, { sampleReady: false, stopReached: false })).toBe('pending');
    expect(recommendTrial(verdicts, { sampleReady: true, stopReached: false })).toBe('sessions-only');
  });

  it('G2 and G3 allow the 1.05 ratio at the rule edge exactly', () => {
    // 21 of 19 sessions against 20 of 19 is exactly 1.05 at rule precision;
    // binary division reports 1.0500000000000003.
    expect(evaluateG2(baseMetrics({ onCallsPerSession: 21 / 19, offCallsPerSession: 20 / 19, onSessions: 19, offSessions: 19 })).pass).toBe(true);
    expect(evaluateG3(baseMetrics({ onTurnsPerSession: 21 / 19, offTurnsPerSession: 20 / 19, onSessions: 19, offSessions: 19 })).pass).toBe(true);
  });

  it('G2 and G3 fail past the 105% ratio', () => {
    expect(evaluateG2(baseMetrics({ onCallsPerSession: 10.4 })).pass).toBe(true);
    expect(evaluateG2(baseMetrics({ onCallsPerSession: 10.6 })).pass).toBe(false);
    expect(evaluateG3(baseMetrics({ onTurnsPerSession: 4.2 })).pass).toBe(true);
    expect(evaluateG3(baseMetrics({ onTurnsPerSession: 4.3 })).pass).toBe(false);
  });

  it('G5 fails when retries after a rewrite reach 3%', () => {
    expect(evaluateG5(baseMetrics({ retryAfterRewrite: 14 })).pass).toBe(true);
    expect(evaluateG5(baseMetrics({ retryAfterRewrite: 15 })).pass).toBe(false);
  });

  it('G4 is never claimed as measured', () => {
    const g4 = evaluateTrial(baseMetrics()).find((v) => v.name.startsWith('G4'));
    expect(g4?.pass).toBeNull();
    expect(g4?.detail).toContain('G1 and G5');
  });

  it('the benefit must hold and cost is reported against the +2% ceiling', () => {
    expect(evaluateBenefit(baseMetrics({ onMedianCharsRewritten: 1_400 })).pass).toBe(true);
    expect(evaluateBenefit(baseMetrics({ onMedianCharsRewritten: 1_500 })).pass).toBe(false);
    expect(evaluateCost(baseMetrics({ onCostPerTurn: 0.0102 })).pass).toBe(true);
    expect(evaluateCost(baseMetrics({ onCostPerTurn: 0.0103 })).pass).toBe(false);
    expect(evaluateCost(baseMetrics({ offCostPerTurn: 0 })).pass).toBeNull();
  });
});

describe('readBashCalls (synthetic transcript)', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rtk-trial-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('extracts Bash calls, result sizes, failures and retry-after-rewrite', async () => {
    const file = path.join(dir, 'sess.jsonl');
    const entries = [
      {
        timestamp: '2026-10-20T10:00:00Z',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git status' } }] },
      },
      {
        timestamp: '2026-10-20T10:00:01Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: [{ type: 'text', text: 'x'.repeat(300) }] }] },
      },
      {
        timestamp: '2026-10-20T10:00:02Z',
        message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'rtk proxy git status' } }] },
      },
      {
        timestamp: '2026-10-20T10:00:03Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'boom' }] },
      },
    ];
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n'), 'utf-8');
    const { calls, unparsableLines } = await readBashCalls(file);
    expect(unparsableLines).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ command: 'git status', resultChars: 300, failed: false, retryAfterRewrite: true });
    expect(calls[1]).toMatchObject({ command: 'rtk proxy git status', failed: true });
  });

  it('reads the actual cost-attribution usage.cost field', () => {
    writeFileSync(path.join(dir, 'cost.jsonl'), JSON.stringify({
      ts: Date.parse('2026-10-20T10:00:00Z'), sessionId: 'sess', rtkArm: 'on',
      rtkTrialEligible: true, rtkTrialKey: 'instance-1', rtkTrialSurface: 'interactive', provider: 'claude',
      instanceId: 'instance-1',
      source: 'instance-turn', taskType: 'chat:claude', usage: { cost: 0.02, inputTokens: 20, cacheReadTokens: 80 },
    }) + '\n');
    expect(readTrialCostRows(dir)).toEqual([expect.objectContaining({
      sessionId: 'sess', arm: 'on', costUsd: 0.02, newTokens: 100,
    })]);
  });

  it('excludes legacy, mixed-provider and approval-mode rows even with an arm', () => {
    const common = { ts: Date.parse('2026-10-20T10:00:00Z'), rtkArm: 'off',
      rtkTrialKey: 'run-1', rtkTrialSurface: 'loop', source: 'one-shot', taskType: 'loop-orchestration:claude',
      correlationId: 'run-1::0' };
    const rows = [
      { ...common, sessionId: 'legacy', provider: 'claude' },
      { ...common, sessionId: 'codex', provider: 'codex', rtkTrialEligible: true },
      { ...common, sessionId: 'approval', provider: 'claude', rtkTrialEligible: false },
      { ...common, sessionId: 'wrong-run', provider: 'claude', rtkTrialEligible: true, correlationId: 'other::0' },
      { ...common, sessionId: 'eligible-off', provider: 'claude', rtkTrialEligible: true },
    ];
    writeFileSync(path.join(dir, 'cost.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n'));
    expect(readTrialCostRows(dir).map((row) => row.sessionId)).toEqual(['eligible-off']);
  });

  it('prints a seeded report without claiming a trial verdict from one session', () => {
    const userData = path.join(dir, 'userdata');
    const costDir = path.join(userData, 'cost-attribution');
    const hookDir = path.join(userData, 'rtk', 'hook-decisions');
    const projectDir = path.join(dir, 'projects', 'project');
    mkdirSync(costDir, { recursive: true });
    mkdirSync(hookDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    const costRows = [{
      ts: Date.parse('2026-10-20T10:00:00Z'), sessionId: 'sess', rtkArm: 'on',
      rtkTrialEligible: true, rtkTrialKey: 'instance-on', rtkTrialSurface: 'interactive', provider: 'claude',
      instanceId: 'instance-on',
      source: 'instance-turn', taskType: 'chat:claude', usage: { cost: 0.02, inputTokens: 20, cacheReadTokens: 80 },
    }, {
      ts: Date.parse('2026-10-20T10:00:00Z'), sessionId: 'loop-off', rtkArm: 'off',
      rtkTrialEligible: true, rtkTrialKey: 'run-off', rtkTrialSurface: 'loop', provider: 'claude',
      correlationId: 'run-off::0',
      source: 'one-shot', taskType: 'loop-orchestration:claude', usage: { cost: 0.01, inputTokens: 10 },
    }, {
      ts: Date.parse('2026-10-20T10:00:00Z'), sessionId: 'missing-delivery', rtkArm: 'on',
      rtkTrialEligible: true, rtkTrialKey: 'instance-missing', rtkTrialSurface: 'interactive', provider: 'claude',
      instanceId: 'instance-missing',
      source: 'instance-turn', taskType: 'chat:claude', usage: { cost: 0.03, inputTokens: 30 },
    }, {
      ts: Date.parse('2026-10-20T10:00:00Z'), sessionId: 'other-provider', rtkArm: 'off',
      rtkTrialEligible: true, rtkTrialKey: 'run-codex', rtkTrialSurface: 'loop', provider: 'codex',
      correlationId: 'run-codex::0',
      source: 'one-shot', taskType: 'loop-orchestration:codex', usage: { cost: 0.04, inputTokens: 40 },
    }];
    writeFileSync(path.join(costDir, 'cost.jsonl'), costRows.map((row) => JSON.stringify(row)).join('\n'));
    writeFileSync(path.join(hookDir, '2026-10-20.jsonl'), JSON.stringify({
      ts: '2026-10-20T10:00:00Z', session_id: 'sess', tool_use_id: 't1', mode: 'rewrite-only', decision: 'rewritten',
    }) + '\n');
    writeFileSync(path.join(projectDir, 'sess.jsonl'), [
      { timestamp: '2026-10-20T10:00:00Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git status' } }] } },
      { timestamp: '2026-10-20T10:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'short' }] } },
    ].map((row) => JSON.stringify(row)).join('\n'));
    for (const sessionId of ['loop-off', 'missing-delivery']) {
      writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [
        { timestamp: '2026-10-20T10:00:00Z', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'git status' } }] } },
        { timestamp: '2026-10-20T10:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'full output' }] } },
      ].map((row) => JSON.stringify(row)).join('\n'));
    }
    const output = execFileSync(process.execPath, [
      path.join(process.cwd(), 'scripts', 'rtk-trial-report.mjs'), '--since', '2026-10-20', '--userdata', userData, '--json',
    ], { encoding: 'utf8', env: { ...process.env, AIO_RTK_TRIAL_PROJECTS_DIR: path.join(dir, 'projects') } });
    const report = JSON.parse(output);
    expect(report.sessions).toEqual({ withHook: 1, withoutHook: 1 });
    expect(report.sampleReady).toBe(false);
    expect(report.strata['interactive/unknown/on']).toMatchObject({
      sessions: 1,
      bashCalls: 1,
      rewrittenCalls: 1,
      medianToolResultChars: 5,
      newInputPlusCacheReadTokensPerTurn: 100,
      costPerTurn: { point: 0.02 },
    });
    expect(report.strata['loop/unknown/off']).toMatchObject({ sessions: 1, bashCalls: 1 });
    expect(report.strata['interactive/unknown/on'].sessions).toBe(1);
    expect(report.verdicts.find((row: { name: string }) => row.name.startsWith('G1')).pass).toBeNull();
  });

  it('rejects whole native sessions after an ordinary, provider, exposure, key or arm row', () => {
    const ts = Date.parse('2026-10-20T10:00:00Z');
    const eligible = (id: string, arm: 'on' | 'off' = 'on') => ({
      ts, sessionId: id, provider: 'claude', source: 'instance-turn', instanceId: `key-${id}`,
      rtkTrialEligible: true, rtkTrialKey: `key-${id}`, rtkTrialSurface: 'interactive',
      rtkArm: arm, usage: { cost: 0.01, inputTokens: 10 },
    });
    const badRows = {
      ordinary: { rtkTrialEligible: undefined },
      approval: { rtkTrialEligible: false },
      provider: { provider: 'codex' },
      exposure: { rtkTrialSurface: undefined },
      key: { rtkTrialKey: 'other-key' },
      arm: { rtkArm: 'off' },
    };
    const costRows: Record<string, unknown>[] = [eligible('clean-on'), eligible('clean-off', 'off')];
    for (const [id, bad] of Object.entries(badRows)) {
      costRows.push(eligible(id), { ...eligible(id), ...bad }, eligible(id));
    }
    const onIds = ['clean-on', ...Object.keys(badRows)];
    const report = seededReport(dir, costRows,
      onIds.map(id => ({ ts: '2026-10-20T10:00:00Z', session_id: id,
        tool_use_id: 'bash', mode: 'rewrite-only', decision: 'rewritten' })),
      Object.fromEntries(['clean-on', 'clean-off', ...Object.keys(badRows)]
        .map(id => [id, 'git status'])));
    expect(report.sessions).toEqual({ withHook: 1, withoutHook: 1 });
    expect(report.strata['interactive/unknown/on'].turns).toBe(1);
    expect(report.strata['interactive/unknown/off'].turns).toBe(1);
  });

  it('keeps zero-Bash sessions in an unmeasured stratum without starting the trial clock', () => {
    const earlier = Date.parse('2026-10-01T10:00:00Z');
    const measured = Date.parse('2026-10-20T10:00:00Z');
    const row = (id: string, arm: 'on' | 'off', ts: number) => ({
      ts, sessionId: id, provider: 'claude', source: 'instance-turn', instanceId: `key-${id}`,
      rtkTrialEligible: true, rtkTrialKey: `key-${id}`, rtkTrialSurface: 'interactive',
      rtkArm: arm, usage: { cost: 0.01, inputTokens: 10 },
    });
    const report = seededReport(dir, [row('zero-on', 'on', earlier), row('zero-off', 'off', earlier),
      row('measured-on', 'on', measured), row('measured-off', 'off', measured)],
    [{ ts: '2026-10-20T10:00:00Z', session_id: 'measured-on', tool_use_id: 'bash',
      mode: 'rewrite-only', decision: 'rewritten' }],
    { 'zero-on': null, 'zero-off': null, 'measured-on': 'git status', 'measured-off': 'git status' });
    expect(report.sessions).toEqual({ withHook: 1, withoutHook: 1 });
    expect(report.unmeasuredNoBash).toEqual({ on: 1, off: 1 });
    expect(report.trialStart).toBe('2026-10-20T10:00:00.000Z');
  });
});


describe('actual CLI requires observed tool results for the failure guardrail', () => {
  let root = '';
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'rtk-result-presence-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it.each([
    ['missing-rewritten', null], ['missing-other', null], ['success', true],
    ['empty', true], ['failed', false], ['nonzero', false], ['missing-hook', null],
  ] as const)('%s keeps unknown outcomes separate from observed success', (mode, expected) => {
    const userData = path.join(root, 'userdata');
    const costDir = path.join(userData, 'cost-attribution');
    const hookDir = path.join(userData, 'rtk', 'hook-decisions');
    const projects = path.join(root, 'projects', 'project');
    for (const directory of [costDir, hookDir, projects]) mkdirSync(directory, { recursive: true });
    const timestamp = '2026-09-01T10:00:00Z';
    const rows: Record<string, unknown>[] = [];
    const hooks: Record<string, unknown>[] = [];
    for (const arm of ['on', 'off']) {
      const sessionId = `fixture-${arm}`;
      const key = `key-${arm}`;
      rows.push({ ts: Date.parse(timestamp), sessionId, provider: 'claude', source: 'instance-turn',
        instanceId: key, rtkTrialEligible: true, rtkTrialKey: key, rtkTrialSurface: 'interactive',
        rtkArm: arm, usage: { cost: 0.01, inputTokens: 10 } });
      const entries: Record<string, unknown>[] = [];
      for (const [index, command] of ['git status', 'git diff'].entries()) {
        const id = `t${index}`;
        entries.push({ timestamp, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
        const missing = arm === 'on' && ((mode === 'missing-rewritten' && index === 0) || (mode === 'missing-other' && index === 1));
        if (!missing) entries.push({ timestamp, message: { content: [{ type: 'tool_result', tool_use_id: id,
          is_error: mode === 'failed' && arm === 'on' && index === 0,
          content: mode === 'empty' ? '' : mode === 'nonzero' && arm === 'on' && index === 0 ? 'Exit code: 2' : 'inert output' }] } });
        if (arm === 'on' && !(mode === 'missing-hook' && index === 1)) hooks.push({ ts: timestamp,
          session_id: sessionId, tool_use_id: id, mode: 'rewrite-only', decision: index === 0 ? 'rewritten' : 'unchanged' });
      }
      writeFileSync(path.join(projects, `${sessionId}.jsonl`), entries.map(entry => JSON.stringify(entry)).join('\n'));
    }
    writeFileSync(path.join(costDir, 'cost.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
    writeFileSync(path.join(hookDir, 'decisions.jsonl'), hooks.map(row => JSON.stringify(row)).join('\n'));
    const report = JSON.parse(execFileSync(process.execPath, [path.join(process.cwd(), 'scripts/rtk-trial-report.mjs'),
      '--since', '2026-09-01', '--userdata', userData, '--json'], { encoding: 'utf8', env: { ...process.env,
      AIO_COST_ATTRIBUTION_DIR: costDir, AIO_RTK_TRIAL_PROJECTS_DIR: path.dirname(projects) } }));
    expect(report.verdicts.find((row: { name: string }) => row.name.startsWith('G1')).pass).toBe(expected);
    expect(report.bash.rewrittenCalls).toBe(1);
    expect(report.perSession.onCallsPerSession).toBe(2);
    expect(report.bash.onUnresolvedCalls).toBe(mode.startsWith('missing-') && mode !== 'missing-hook' ? 1 : 0);
    if (mode === 'missing-rewritten') expect(report.bash.rewrittenErrorRate).toBeNull();
  });

  it('an explicit empty success owns its result even if a duplicate result follows', async () => {
    const file = path.join(root, 'empty-result.jsonl');
    writeFileSync(file, [
      { message: { content: [{ type: 'tool_use', id: 'empty', name: 'Bash', input: { command: 'git status' } }] } },
      { message: { content: [{ type: 'tool_result', tool_use_id: 'empty', content: '' }] } },
      { message: { content: [{ type: 'tool_result', tool_use_id: 'empty', content: 'Exit code: 2', is_error: true }] } },
    ].map(row => JSON.stringify(row)).join('\n'));
    const { calls, unparsableLines } = await readBashCalls(file);
    expect(unparsableLines).toBe(0);
    expect(calls[0].resultObserved).toBe(true);
    expect(calls).toEqual([expect.objectContaining({ resultObserved: true, resultChars: 0, failed: false })]);
  });
});


describe('actual CLI includes observed empty results in matched-command benefit', () => {
  let root = '';
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'rtk-zero-benefit-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  it.each([
    ['mixed-zero-baseline', false], ['all-empty-on', true], ['missing-on', null],
    ['zero-baseline', null], ['same-size', false], ['threshold', true],
  ] as const)('%s preserves the actual result population', (mode, expected) => {
    const userData = path.join(root, 'userdata');
    const costDir = path.join(userData, 'cost-attribution');
    const hookDir = path.join(userData, 'rtk', 'hook-decisions');
    const projects = path.join(root, 'projects', 'project');
    for (const directory of [costDir, hookDir, projects]) mkdirSync(directory, { recursive: true });
    const timestamp = '2026-09-01T10:00:00Z';
    const rows: Record<string, unknown>[] = [];
    const hooks: Record<string, unknown>[] = [];
    for (const arm of ['on', 'off']) {
      const sessionId = `fixture-${arm}`;
      const key = `key-${arm}`;
      rows.push({ ts: Date.parse(timestamp), sessionId, provider: 'claude', source: 'instance-turn',
        instanceId: key, rtkTrialEligible: true, rtkTrialKey: key, rtkTrialSurface: 'interactive',
        rtkArm: arm, usage: { cost: 0.01, inputTokens: 10 } });
      const entries: Record<string, unknown>[] = [];
      const commands = arm === 'off' && mode === 'mixed-zero-baseline' ? ['git status', 'git diff', 'git status'] : ['git status', 'git diff'];
      for (const [index, command] of commands.entries()) {
        const id = `t${index}`;
        entries.push({ timestamp, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
        const length = index !== 0 ? 100 : arm === 'off' && (mode === 'mixed-zero-baseline' || mode === 'zero-baseline') ? 0
          : arm === 'on' && mode === 'all-empty-on' ? 0 : arm === 'on' && mode === 'mixed-zero-baseline' ? 60
          : arm === 'on' && mode === 'threshold' ? 70 : 100;
        if (!(mode === 'missing-on' && arm === 'on' && index === 0)) entries.push({ timestamp,
          message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'x'.repeat(length) }] } });
        if (arm === 'on') hooks.push({ ts: timestamp, session_id: sessionId, tool_use_id: id,
          mode: 'rewrite-only', decision: index === 0 ? 'rewritten' : 'unchanged' });
      }
      writeFileSync(path.join(projects, `${sessionId}.jsonl`), entries.map(entry => JSON.stringify(entry)).join('\n'));
    }
    writeFileSync(path.join(costDir, 'cost.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
    writeFileSync(path.join(hookDir, 'decisions.jsonl'), hooks.map(row => JSON.stringify(row)).join('\n'));
    const report = JSON.parse(execFileSync(process.execPath, [path.join(process.cwd(), 'scripts/rtk-trial-report.mjs'),
      '--since', '2026-09-01', '--userdata', userData, '--json'], { encoding: 'utf8', env: { ...process.env,
      AIO_COST_ATTRIBUTION_DIR: costDir, AIO_RTK_TRIAL_PROJECTS_DIR: path.dirname(projects) } }));
    expect(report.verdicts.find((row: { name: string }) => row.name.startsWith('Benefit')).pass).toBe(expected);
    expect(report.bash.rewrittenCalls).toBe(1);
    expect(report.perSession.onCallsPerSession).toBe(2);
    if (mode === 'mixed-zero-baseline') expect(report.bash.matchedCommandMedianChars).toEqual({ on: 60, off: 50 });
    if (mode === 'all-empty-on') expect(report.bash.matchedCommandMedianChars).toEqual({ on: 0, off: 100 });
    if (mode === 'missing-on') expect(report.bash.matchedCommandMedianChars.on).toBeNull();
  });
});


describe('measured guardrail failures take precedence over trial maturity', () => {
  it.each(['G1', 'G2', 'G3', 'G5'] as const)('%s stops an immature trial', (guardrail) => {
    const verdicts = evaluateTrial(baseMetrics()).map(verdict =>
      verdict.name.startsWith(guardrail) ? { ...verdict, pass: false } : verdict);
    expect(recommendTrial(verdicts, { sampleReady: false, stopReached: false })).toBe('off');
  });

  it.each(['Benefit', 'Cost', 'G4'] as const)('%s alone preserves early waiting and final decisions', (criterion) => {
    const verdicts = evaluateTrial(baseMetrics()).map(verdict =>
      verdict.name.startsWith(criterion) ? { ...verdict, pass: false } : verdict);
    expect(recommendTrial(verdicts, { sampleReady: false, stopReached: false })).toBe('pending');
    expect(recommendTrial(verdicts, { sampleReady: true, stopReached: false }))
      .toBe(criterion === 'G4' ? 'sessions-only' : 'off');
  });

  it('preserves unknown, minimum-sample stop and measured loop rollout decisions', () => {
    const verdicts = evaluateTrial(baseMetrics());
    expect(recommendTrial(verdicts.map(v => ({ ...v, pass: null })), { sampleReady: false, stopReached: false })).toBe('pending');
    expect(recommendTrial(verdicts, { sampleReady: false, stopReached: true })).toBe('inconclusive');
    expect(recommendTrial(verdicts.map(v => v.name.startsWith('G4') ? { ...v, pass: true } : v),
      { sampleReady: true, stopReached: false })).toBe('on');
  });
});

describe('actual CLI early guardrail recommendation', () => {
  let root = '';
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'rtk-early-guardrail-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it.each([
    ['G1', 'off'], ['G2', 'off'], ['G3', 'off'], ['G5', 'off'],
    ['healthy', 'pending'], ['unknown', 'pending'], ['benefit-only', 'pending'], ['cost-only', 'pending'],
    ['mature', 'sessions-only'], ['mature-off', 'off'], ['stop', 'inconclusive'],
  ] as const)('%s prints the same recommendation in JSON and text', (mode, expected) => {
    const userData = path.join(root, 'userdata');
    const costDir = path.join(userData, 'cost-attribution');
    const hookDir = path.join(userData, 'rtk', 'hook-decisions');
    const projects = path.join(root, 'projects', 'fixture');
    for (const directory of [costDir, hookDir, projects]) mkdirSync(directory, { recursive: true });
    const mature = mode.startsWith('mature');
    const timestamp = mode === 'stop' ? '2026-09-01T10:00:00Z'
      : mature ? '2026-09-30T10:00:00Z' : '2026-10-18T10:00:00Z';
    const rows: Record<string, unknown>[] = [];
    const hooks: Record<string, unknown>[] = [];
    for (const arm of ['on', 'off'] as const) {
      for (let session = 0; session < (mature ? 150 : 1); session++) {
        const sessionId = `${arm}-${session}`;
        const turns = arm === 'on' && mode === 'G3' ? 2 : 1;
        for (let turn = 0; turn < turns; turn++) rows.push({
          ts: Date.parse(timestamp), sessionId, provider: 'claude', source: 'instance-turn', instanceId: sessionId,
          rtkTrialEligible: true, rtkTrialKey: sessionId, rtkTrialSurface: 'interactive', rtkArm: arm,
          usage: { cost: arm === 'on' && mode === 'cost-only' ? 0.02 : 0.01, inputTokens: 10 },
        });
        const commands = mode === 'G5' && arm === 'on' ? ['git status', 'rtk proxy git status'] : ['git status', 'git diff'];
        if (arm === 'on' && mode === 'G2') commands.push('git log');
        const entries: Record<string, unknown>[] = [];
        for (const [index, command] of commands.entries()) {
          const id = `t${index}`;
          entries.push({ timestamp, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
          if (!(arm === 'on' && index === 0 && mode === 'unknown')) entries.push({ timestamp, message: { content: [{
            type: 'tool_result', tool_use_id: id,
            is_error: arm === 'on' && index === 0 && (mode === 'G1' || mode === 'mature-off'),
            content: 'x'.repeat(arm === 'off' || index > 0 || mode === 'benefit-only' ? 100 : 50),
          }] } });
          if (arm === 'on') hooks.push({ ts: timestamp, session_id: sessionId, tool_use_id: id,
            mode: 'rewrite-only', decision: index === 0 ? 'rewritten' : 'unchanged' });
        }
        writeFileSync(path.join(projects, `${sessionId}.jsonl`), entries.map(entry => JSON.stringify(entry)).join('\n'));
      }
    }
    writeFileSync(path.join(costDir, 'fixture.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
    writeFileSync(path.join(hookDir, 'fixture.jsonl'), hooks.map(row => JSON.stringify(row)).join('\n'));
    const args = [path.join(process.cwd(), 'scripts/rtk-trial-report.mjs'), '--since', '2026-09-01',
      '--until', '2026-10-19', '--userdata', userData];
    const options = { encoding: 'utf8' as const, env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, 'config'),
      AIO_COST_ATTRIBUTION_DIR: costDir, AIO_RTK_TRIAL_PROJECTS_DIR: path.dirname(projects) } };
    const report: { recommendation: string; sampleReady: boolean; stopReached: boolean;
      sessions: { withHook: number; withoutHook: number }; verdicts: { name: string; pass: boolean | null }[] } =
      JSON.parse(execFileSync(process.execPath, [...args, '--json'], options));
    const text = execFileSync(process.execPath, args, options);
    expect(report.sessions).toEqual({ withHook: mature ? 150 : 1, withoutHook: mature ? 150 : 1 });
    expect(report.sampleReady).toBe(mature);
    expect(report.stopReached).toBe(mode === 'stop');
    expect(report.recommendation).toBe(expected);
    expect(text).toContain(`Recommendation: ${expected}.`);
    if (['G1', 'G2', 'G3', 'G5'].includes(mode)) {
      expect(report.verdicts.find(verdict => verdict.name.startsWith(mode))?.pass).toBe(false);
      expect(text).toContain(`FAIL — ${mode}`);
    }
    if (mode === 'unknown') expect(report.verdicts.find(verdict => verdict.name.startsWith('G1'))?.pass).toBeNull();
    if (mode === 'benefit-only' || mode === 'cost-only') {
      expect(report.verdicts.filter(verdict => /^G[1235]\b/.test(verdict.name)).every(verdict => verdict.pass === true)).toBe(true);
      expect(report.verdicts.find(verdict => verdict.name.startsWith(mode === 'benefit-only' ? 'Benefit' : 'Cost'))?.pass).toBe(false);
    }
  });
});

describe('actual CLI allows the G1 rule edge of exactly 1.0pp', () => {
  let root = '';
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'rtk-g1-rule-edge-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('waits for the sample instead of recommending off at the verifier rule edge', () => {
    const userData = path.join(root, 'userdata');
    const costDir = path.join(userData, 'cost-attribution');
    const hookDir = path.join(userData, 'rtk', 'hook-decisions');
    const projects = path.join(root, 'projects', 'project');
    for (const directory of [costDir, hookDir, projects]) mkdirSync(directory, { recursive: true });
    const timestamp = '2026-10-18T10:00:00Z';
    writeFileSync(path.join(costDir, 'cost.jsonl'), JSON.stringify({
      ts: Date.parse(timestamp), sessionId: 'edge-on', provider: 'claude', source: 'instance-turn',
      instanceId: 'key-edge-on', rtkTrialEligible: true, rtkTrialKey: 'key-edge-on',
      rtkTrialSurface: 'interactive', rtkArm: 'on', usage: { cost: 0.01, inputTokens: 10 },
    }) + '\n');
    const entries: Record<string, unknown>[] = [];
    const hooks: Record<string, unknown>[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const rewritten = i < 1000;
      const id = `t${i}`;
      entries.push({ timestamp, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `git status ${i}` } }] } });
      entries.push({ timestamp, message: { content: [{ type: 'tool_result', tool_use_id: id,
        is_error: rewritten ? i < 49 : i < 1039, content: 'inert output' }] } });
      hooks.push({ ts: timestamp, session_id: 'edge-on', tool_use_id: id,
        mode: 'rewrite-only', decision: rewritten ? 'rewritten' : 'unchanged' });
    }
    writeFileSync(path.join(projects, 'edge-on.jsonl'), entries.map(entry => JSON.stringify(entry)).join('\n'));
    writeFileSync(path.join(hookDir, 'decisions.jsonl'), hooks.map(row => JSON.stringify(row)).join('\n'));
    const report = JSON.parse(execFileSync(process.execPath, [path.join(process.cwd(), 'scripts/rtk-trial-report.mjs'),
      '--since', '2026-10-18', '--until', '2026-10-19', '--userdata', userData, '--json'], { encoding: 'utf8',
    env: { ...process.env, AIO_RTK_TRIAL_PROJECTS_DIR: path.dirname(projects) } }));
    expect(report.bash).toMatchObject({ rewrittenCalls: 1000, rewrittenErrorRate: 0.049 });
    expect(report.verdicts.find((row: { name: string }) => row.name.startsWith('G1'))).toEqual({
      name: 'G1 rewritten-call failures', pass: true, detail: 'rewritten 4.9% vs other 3.9% (Δ 1.0pp; limit 1pp)',
    });
    expect(report.sampleReady).toBe(false);
    expect(report.recommendation).toBe('pending');
  });
});
