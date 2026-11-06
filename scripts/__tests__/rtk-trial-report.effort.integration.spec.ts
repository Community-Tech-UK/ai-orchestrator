import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface Report {
  sessions: { withHook: number; withoutHook: number };
  strata: Record<string, { sessions: number; turns: number; bashCalls: number; costPerTurn: { point: number } }>;
  costPerTurn: { on: { point: number } | null; off: { point: number } | null };
}

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rtk-effort-fixture-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function report(efforts: Array<string | undefined>, arm: 'on' | 'off', ordinary = false): Report {
  const cost = join(root, 'cost');
  const userdata = join(root, 'userdata');
  const hooks = join(userdata, 'rtk', 'hook-decisions');
  const projects = join(root, 'projects');
  const project = join(projects, 'fixture');
  for (const directory of [cost, hooks, project]) mkdirSync(directory, { recursive: true });
  const rows: Record<string, unknown>[] = [];
  const transcript: Record<string, unknown>[] = [];
  const hookRows: Record<string, unknown>[] = [];
  for (const [index, effort] of efforts.entries()) {
    const timestamp = new Date(Date.parse('2026-10-18T12:00:00Z') + index * 60_000).toISOString();
    const id = `tool-${index}`;
    rows.push({ ts: Date.parse(timestamp), source: 'instance-turn', provider: 'claude',
      instanceId: 'fixture-instance', sessionId: 'fixture-session', rtkTrialKey: 'fixture-instance',
      rtkTrialEligible: true, rtkTrialSurface: 'interactive', rtkArm: arm, reasoningEffort: effort,
      costKnown: true, usage: { cost: effort === 'high' ? 100 : 1, inputTokens: 100 } });
    transcript.push({ timestamp, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'git status' } }] } },
      { timestamp, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'inert result' }] } });
    if (arm === 'on') hookRows.push({ ts: timestamp, session_id: 'fixture-session', tool_use_id: id,
      mode: 'rewrite-only', decision: 'rewritten' });
  }
  if (ordinary) rows.push({ ts: Date.parse('2026-10-18T12:05:00Z'), source: 'instance-turn',
    provider: 'claude', sessionId: 'fixture-session', usage: { cost: 1 } });
  const jsonl = (values: Record<string, unknown>[]) => values.map(value => JSON.stringify(value)).join('\n');
  writeFileSync(join(cost, 'cost.jsonl'), jsonl(rows));
  writeFileSync(join(project, 'fixture-session.jsonl'), jsonl(transcript));
  writeFileSync(join(hooks, 'hooks.jsonl'), jsonl(hookRows));
  return JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../rtk-trial-report.mjs', pathToFileURL(__filename))),
    '--since', '2026-10-18', '--until', '2026-10-19', '--userdata', userdata, '--json'], {
    encoding: 'utf8', env: { ...process.env, AIO_COST_ATTRIBUTION_DIR: cost, AIO_RTK_TRIAL_PROJECTS_DIR: projects },
  }));
}

describe('actual RTK report CLI effort strata', () => {
  it.each(['on', 'off'] as const)('%s quarantines both mixed orders and does not readmit a later matching row', arm => {
    for (const efforts of [['low', 'high', 'low'], ['high', 'low', 'high']]) {
      const actual = report(efforts, arm);
      expect(actual.strata).toEqual({});
      expect(actual.sessions).toEqual({ withHook: 0, withoutHook: 0 });
      expect(actual.costPerTurn).toEqual({ on: null, off: null });
    }
  });

  it.each([
    ['low', 1], ['high', 100], [undefined, 1],
  ] as const)('preserves homogeneous %s session metrics', (effort, cost) => {
    const actual = report([effort, effort], 'off');
    expect(actual.sessions).toEqual({ withHook: 0, withoutHook: 1 });
    expect(actual.strata[`interactive/${effort ?? 'unknown'}/off`]).toMatchObject({
      sessions: 1, turns: 2, bashCalls: 2, costPerTurn: { point: cost },
    });
  });

  it('quarantines missing-to-known effort rather than inventing pure attribution', () => {
    expect(report([undefined, 'low'], 'off').strata).toEqual({});
  });

  it('retains ordinary-turn quarantine even when eligible rows have one effort', () => {
    expect(report(['low', 'low'], 'off', true).strata).toEqual({});
  });
});
