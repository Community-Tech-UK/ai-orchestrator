import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateCost } from '../rtk-trial-report.mjs';

describe('RTK measured zero-dollar costs', () => {
  it('accepts measured zero treatment against a positive control, while absent or zero controls remain unmeasured', () => {
    const metrics = { onCostPerTurn: 0, offCostPerTurn: 0.02 } as Parameters<typeof evaluateCost>[0];
    expect(evaluateCost(metrics).pass).toBe(true);
    expect(evaluateCost({ ...metrics, offCostPerTurn: 0 }).pass).toBeNull();
    expect(evaluateCost({ ...metrics, onCostPerTurn: undefined } as never).pass).toBeNull();
  });

  it('CLI withholds aggregate costs for admitted unknown sessions and retains positive controls', () => {
    const root = mkdtempSync(join(tmpdir(), 'rtk-known-cost-'));
    try {
      const costDir = join(root, 'cost-attribution');
      const hookDir = join(root, 'rtk', 'hook-decisions');
      const projects = join(root, 'projects', 'fixture');
      for (const dir of [costDir, hookDir, projects]) mkdirSync(dir, { recursive: true });
      const samples = [
        ['zero', 'on', 0, true], ['positive', 'on', 0.02, true],
        ['unknown', 'on', 9, false], ['control', 'off', 0.04, true],
      ] as const;
      const rows = samples.map(([id, arm, cost, costKnown]) => ({
        ts: Date.parse('2026-10-18T10:00:00Z'), sessionId: id,
        provider: 'claude', source: 'instance-turn', instanceId: id,
        rtkTrialEligible: true, rtkTrialKey: id, rtkTrialSurface: 'interactive',
        rtkArm: arm, costKnown, usage: { cost, inputTokens: 10 },
      }));
      writeFileSync(join(costDir, 'fixture.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
      writeFileSync(join(hookDir, 'fixture.jsonl'), samples.filter(([, arm]) => arm === 'on').map(([id]) => JSON.stringify({
        ts: '2026-10-18T10:00:00Z', session_id: id, tool_use_id: 'bash',
        mode: 'rewrite-only', decision: 'rewritten',
      })).join('\n'));
      for (const [id] of samples) writeFileSync(join(projects, `${id}.jsonl`), JSON.stringify({
        timestamp: '2026-10-18T10:00:00Z', message: {
          content: [{ type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'git status' } }],
        },
      }));
      const report = JSON.parse(execFileSync(process.execPath, [
        'scripts/rtk-trial-report.mjs', '--since', '2026-10-01', '--until', '2026-10-19', '--userdata', root, '--json',
      ], { encoding: 'utf8', env: { ...process.env, AIO_COST_ATTRIBUTION_DIR: costDir, AIO_RTK_TRIAL_PROJECTS_DIR: join(root, 'projects') } }));
      expect(report.sessions).toEqual({ withHook: 3, withoutHook: 1 });
      expect(report.costPerTurn.on).toBeNull();
      expect(report.costPerTurn.off.point).toBe(0.04);
      expect(report.strata['interactive/unknown/on'].costPerTurn).toBeNull();
      expect(report.verdicts.find((v: { name: string }) => v.name === 'Cost per turn').pass).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('RTK trial transcript discovery', () => {
  it('admits sessions whose transcripts live only under a managed account profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'rtk-profiles-'));
    try {
      const costDir = join(root, 'cost-attribution');
      const hookDir = join(root, 'rtk', 'hook-decisions');
      const projects = join(root, 'claude-cli-profiles', 'profile-a', 'projects', 'fixture');
      mkdirSync(costDir, { recursive: true });
      mkdirSync(hookDir, { recursive: true });
      mkdirSync(projects, { recursive: true });
      const samples = [
        ['zero', 'on', 0, true], ['positive', 'on', 0.02, true],
        ['unknown', 'on', 9, false], ['control', 'off', 0.04, true],
      ] as const;
      const rows = samples.map(([id, arm, cost, costKnown]) => ({
        ts: Date.parse('2026-10-18T10:00:00Z'), sessionId: id,
        provider: 'claude', source: 'instance-turn', instanceId: id,
        rtkTrialEligible: true, rtkTrialKey: id, rtkTrialSurface: 'interactive',
        rtkArm: arm, costKnown, usage: { cost, inputTokens: 10 },
      }));
      writeFileSync(join(costDir, 'fixture.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
      writeFileSync(join(hookDir, 'fixture.jsonl'), samples.filter(([, arm]) => arm === 'on').map(([id]) => JSON.stringify({
        ts: '2026-10-18T10:00:00Z', session_id: id, tool_use_id: 'bash',
        mode: 'rewrite-only', decision: 'rewritten',
      })).join('\n'));
      for (const [id] of samples) writeFileSync(join(projects, `${id}.jsonl`), JSON.stringify({
        timestamp: '2026-10-18T10:00:00Z', message: {
          content: [{ type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'git status' } }],
        },
      }));
      // No AIO_RTK_TRIAL_PROJECTS_DIR override: discovery must reach the
      // managed profile home (CLAUDE_CONFIG_DIR points the default root at an
      // empty directory).
      const report = JSON.parse(execFileSync(process.execPath, [
        'scripts/rtk-trial-report.mjs', '--since', '2026-10-01', '--until', '2026-10-19', '--userdata', root, '--json',
      ], { encoding: 'utf8', env: { ...process.env, AIO_COST_ATTRIBUTION_DIR: costDir, CLAUDE_CONFIG_DIR: join(root, 'no-claude-config') } }));
      expect(report.sessions).toEqual({ withHook: 3, withoutHook: 1 });
      expect(report.perSession.onCallsPerSession).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
