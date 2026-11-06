import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rtkArmFor } from '../../src/main/cli/rtk/rtk-rollout';

type Arm = 'on' | 'off';
type Mode = 'cheap' | 'expensive' | 'zero-on' | 'zero-off' | 'known-mixture'
  | 'unknown-on' | 'unknown-off' | 'unknown-both' | 'partial-on' | 'partial-off'
  | 'excluded-transcript' | 'excluded-hook' | 'excluded-no-bash' | 'guardrail-unknown'
  | 'torn' | 'restored' | 'torn-guardrail' | 'transcript-torn' | 'transcript-restored' | 'transcript-stop' | 'result-torn';
interface Interval { point: number; lo: number; hi: number }
interface Report {
  sessions: { withHook: number; withoutHook: number };
  sampleReady: boolean;
  transcriptRecords: { complete: boolean; unparsableLines: number };
  perSession: { onCallsPerSession: number | null };
  recommendation: string;
  costPerTurn: Record<Arm, Interval | null>;
  strata: Record<string, { turns: number; costPerTurn: Interval | null }>;
  verdicts: { name: string; pass: boolean | null }[];
  unmeasuredNoBash: Record<Arm, number>;
}

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rtk-unknown-cost-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function runReport(mode: Mode): { report: Report; text: string } {
  const userdata = join(root, 'userdata');
  const cost = join(userdata, 'cost-attribution');
  const hooks = join(userdata, 'rtk', 'hook-decisions');
  const projects = join(root, 'projects');
  const project = join(projects, 'fixture');
  for (const directory of [cost, hooks, project]) mkdirSync(directory, { recursive: true });
  const timestamp = '2026-09-30T10:00:00Z';
  const rows: Record<string, unknown>[] = [];
  const hookRows: Record<string, unknown>[] = [];
  const count = mode === 'known-mixture' ? 1 : 150;
  for (const arm of ['on', 'off'] as const) {
    const extra = arm === 'on' && mode.startsWith('excluded-') ? 1 : 0;
    for (let session = 0; session < count + extra; session++) {
      let suffix = 0;
      let id = `${arm}-${session}-${suffix}`;
      while (rtkArmFor(id, 'trial') !== arm) id = `${arm}-${session}-${++suffix}`;
      const excluded = session === count;
      const partial = mode === `partial-${arm}` && session === 0;
      const turns = partial || mode === 'known-mixture' ? 2 : 1;
      for (let turn = 0; turn < turns; turn++) {
        const unknown = excluded || (session === 0 && (mode === `unknown-${arm}` || mode === 'unknown-both'
          || (mode === 'guardrail-unknown' && arm === 'on'))) || (partial && turn === 1);
        const amount = mode === 'known-mixture' ? (arm === 'on' ? turn * 0.02 : 0.04)
          : mode === `zero-${arm}` ? 0 : mode === 'expensive' && arm === 'on' ? 100 : 0.01;
        rows.push({ ts: Date.parse(timestamp), sessionId: id, provider: 'claude', source: 'instance-turn',
          instanceId: id, rtkTrialEligible: true, rtkTrialKey: id, rtkTrialSurface: 'interactive',
          rtkArm: arm, reasoningEffort: 'low', costKnown: !unknown,
          // Explicit unknown must override even a numeric estimate.
          usage: { inputTokens: 10, cost: unknown ? 99 : amount } });
      }
      const entries: Record<string, unknown>[] = [];
      for (const [index, command] of ['git status', 'git diff'].entries()) {
        const tool = `t${index}`;
        entries.push({ timestamp, message: { content: [{ type: 'tool_use', id: tool, name: 'Bash', input: { command } }] } },
          { timestamp, message: { content: [{ type: 'tool_result', tool_use_id: tool,
            is_error: arm === 'on' && index === 0 && ((mode === 'guardrail-unknown' || mode === 'torn-guardrail' || mode === 'transcript-stop')
              || ((mode.startsWith('transcript-') || mode === 'result-torn') && session < 2)),
            content: 'x'.repeat(arm === 'on' && index === 0 ? 50 : 100) }] } });
        if (arm === 'on' && !(excluded && mode === 'excluded-hook')) hookRows.push({ ts: timestamp,
          session_id: id, tool_use_id: tool, mode: 'rewrite-only', decision: index === 0 ? 'rewritten' : 'passthrough' });
      }
      if (!(excluded && mode === 'excluded-transcript')) writeFileSync(join(project, `${id}.jsonl`),
        excluded && mode === 'excluded-no-bash' ? '' : entries.map((row, index) => {
          const text = JSON.stringify(row);
          return arm === 'on' && session === 1 && ((index === 0 && ['transcript-torn', 'transcript-stop'].includes(mode))
            || (index === 1 && mode === 'result-torn')) ? text.slice(0, -1) : text;
        }).join('\n'));
    }
  }
  const tail = JSON.stringify({ ...rows[0], usage: { inputTokens: 10, cost: 0.1 } });
  const extra = mode === 'restored' ? `\n${tail}` : mode.startsWith('torn') ? `\n${tail.slice(0, -1)}` : '';
  writeFileSync(join(cost, 'fixture.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + extra);
  writeFileSync(join(hooks, 'fixture.jsonl'), hookRows.map(row => JSON.stringify(row)).join('\n'));
  const args = [fileURLToPath(new URL('../rtk-trial-report.mjs', pathToFileURL(__filename))),
    '--since', '2026-09-01', '--until', '2026-10-19', '--userdata', userdata];
  const options = { encoding: 'utf8' as const, env: { ...process.env, AIO_COST_ATTRIBUTION_DIR: cost,
    AIO_RTK_TRIAL_PROJECTS_DIR: projects, CLAUDE_CONFIG_DIR: join(root, 'unused-config') } };
  return { report: JSON.parse(execFileSync(process.execPath, [...args, '--json'], options)),
    text: execFileSync(process.execPath, args, options) };
}

describe('actual RTK report CLI admitted cost completeness', () => {
  it.each(['transcript-torn', 'result-torn'] as const)('%s withholds favourable measures; restoring the brace reveals the stop', mode => {
    const torn = runReport(mode);
    expect(torn.report.transcriptRecords).toMatchObject({ complete: false, unparsableLines: 1 });
    expect(torn.report.perSession.onCallsPerSession).toBeNull();
    expect(torn.report.verdicts.every(row => row.pass !== true)).toBe(true);
    expect(torn.report.recommendation).toBe('inconclusive');
    expect(torn.text).toContain('Transcript evidence unknown');
    const intact = runReport('transcript-restored');
    expect(intact.report.transcriptRecords.complete).toBe(true);
    expect(intact.report.verdicts.find(row => row.name.startsWith('G1'))?.pass).toBe(false);
    expect(intact.report.recommendation).toBe('off');
  });

  it('retains an observed guardrail stop with a torn Bash call', () => {
    const { report } = runReport('transcript-stop');
    expect(report.transcriptRecords.complete).toBe(false);
    expect(report.verdicts.find(row => row.name.startsWith('G1'))?.pass).toBe(false);
    expect(report.recommendation).toBe('off');
  });

  it('withholds a positive decision for a torn final cost row; restoring only its brace exposes the cost breach', () => {
    const torn = runReport('torn');
    expect(torn.report.sessions).toEqual({ withHook: 150, withoutHook: 150 });
    expect(torn.report.sampleReady).toBe(true);
    expect(torn.report.verdicts.find(value => value.name === 'Cost per turn')?.pass).toBeNull();
    expect(torn.report.recommendation).toBe('inconclusive');
    expect(torn.text).toContain('NOT MEASURED — Cost per turn');
    const restored = runReport('restored');
    expect(restored.report.costPerTurn.on?.point).toBeGreaterThan(0.0102);
    expect(restored.report.verdicts.find(value => value.name === 'Cost per turn')?.pass).toBe(false);
    expect(restored.report.recommendation).toBe('off');
  });

  it('preserves a measured guardrail stop despite an unbounded torn cost row', () => {
    const { report } = runReport('torn-guardrail');
    expect(report.verdicts.find(value => value.name.startsWith('G1'))?.pass).toBe(false);
    expect(report.recommendation).toBe('off');
  });
  it.each([
    ['unknown-on', ['on']], ['unknown-off', ['off']], ['unknown-both', ['on', 'off']],
    ['partial-on', ['on']], ['partial-off', ['off']],
  ] as const)('%s cannot authorize a mature trial from the known subset', (mode, unknownArms) => {
    const { report, text } = runReport(mode);
    expect(report.sessions).toEqual({ withHook: 150, withoutHook: 150 });
    expect(report.sampleReady).toBe(true);
    for (const arm of ['on', 'off'] as const) {
      if (unknownArms.some(value => value === arm)) {
        expect(report.costPerTurn[arm]).toBeNull();
        expect(report.strata[`interactive/low/${arm}`].costPerTurn).toBeNull();
      } else expect(report.costPerTurn[arm]?.point).toBeCloseTo(0.01);
      expect(report.strata[`interactive/low/${arm}`].turns).toBe(mode === `partial-${arm}` ? 151 : 150);
    }
    expect(report.verdicts.find(value => value.name === 'Cost per turn')?.pass).toBeNull();
    expect(report.recommendation).toBe('inconclusive');
    expect(text).toContain('Recommendation: inconclusive.');
    expect(text).toContain('NOT MEASURED — Cost per turn');
  });

  it.each(['excluded-transcript', 'excluded-hook', 'excluded-no-bash'] as const)(
    '%s does not contaminate admitted known costs', mode => {
      const { report, text } = runReport(mode);
      expect(report.sessions).toEqual({ withHook: 150, withoutHook: 150 });
      expect(report.sampleReady).toBe(true);
      expect(report.costPerTurn.on?.point).toBeCloseTo(0.01);
      expect(report.costPerTurn.off?.point).toBeCloseTo(0.01);
      expect(report.verdicts.find(value => value.name === 'Cost per turn')?.pass).toBe(true);
      expect(report.recommendation).toBe('sessions-only');
      expect(text).toContain('Recommendation: sessions-only.');
      expect(report.unmeasuredNoBash.on).toBe(mode === 'excluded-no-bash' ? 1 : 0);
    });

  it.each([
    ['cheap', true, 'sessions-only'], ['expensive', false, 'off'],
    ['zero-on', true, 'sessions-only'], ['zero-off', null, 'inconclusive'],
  ] as const)('%s preserves fully known cost decisions', (mode, verdict, recommendation) => {
    const { report, text } = runReport(mode);
    expect(report.sessions).toEqual({ withHook: 150, withoutHook: 150 });
    expect(report.sampleReady).toBe(true);
    expect(report.verdicts.find(value => value.name === 'Cost per turn')?.pass).toBe(verdict);
    expect(report.recommendation).toBe(recommendation);
    expect(text).toContain(`Recommendation: ${recommendation}.`);
    if (mode === 'zero-on') expect(report.costPerTurn.on).toEqual({ point: 0, lo: 0, hi: 0 });
    if (mode === 'zero-off') expect(report.costPerTurn.off).toEqual({ point: 0, lo: 0, hi: 0 });
  });

  it('preserves the full known zero/positive turn population and its bootstrap interval', () => {
    const { report } = runReport('known-mixture');
    expect(report.sessions).toEqual({ withHook: 1, withoutHook: 1 });
    expect(report.strata['interactive/low/on'].turns).toBe(2);
    expect(report.costPerTurn.on).toEqual({ point: 0.01, lo: 0, hi: 0.02 });
    expect(report.costPerTurn.off).toEqual({ point: 0.04, lo: 0.04, hi: 0.04 });
    expect(report.verdicts.find(value => value.name === 'Cost per turn')?.pass).toBe(true);
    expect(report.sampleReady).toBe(false);
    expect(report.recommendation).toBe('pending');
  });

  it('retains a measured guardrail stop when cost is unknown', () => {
    const { report, text } = runReport('guardrail-unknown');
    expect(report.costPerTurn.on).toBeNull();
    expect(report.verdicts.find(value => value.name === 'Cost per turn')?.pass).toBeNull();
    expect(report.verdicts.find(value => value.name.startsWith('G1'))?.pass).toBe(false);
    expect(report.recommendation).toBe('off');
    expect(text).toContain('Recommendation: off.');
  });
});
