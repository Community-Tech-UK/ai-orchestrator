/**
 * Plan 5b: the absolute loop ceiling is applied inside
 * evaluateLoopContextDiscipline for every adapter except Codex, whose lever
 * belongs to Step 1c. Exercised through the runtime glue, not the pure
 * decision function.
 */
import { describe, expect, it } from 'vitest';
import type { ContextUsageObservation } from '../cli/adapters/base-cli-adapter.types';
import { evaluateLoopContextDiscipline } from './loop-context-discipline-runtime';
import { rememberLoopAdapterInvocation } from './loop-adapter-account-scope';

const known = (used: number, total: number): ContextUsageObservation =>
  ({ status: 'known', used, total, source: 'provider-turn' });

function adapterOf(provider: 'claude' | 'codex', observation: ContextUsageObservation): object {
  const adapter = { getLastContextUsage: () => observation };
  rememberLoopAdapterInvocation(adapter, provider, undefined);
  return adapter;
}

const machineCeiling = (tokens: number) => (key: string) =>
  key === 'machineContextCeilingTokens' ? tokens : undefined;

const evaluate = (adapter: object, ceilingTokens: number) => evaluateLoopContextDiscipline({
  adapter,
  enabled: true,
  resetAtUtilization: 0.85,
  cumulativeTokens: 0,
  alreadyNotifiedUnavailable: false,
  readSetting: machineCeiling(ceilingTokens),
});

describe('evaluateLoopContextDiscipline — absolute ceiling', () => {
  it('recycles a Claude loop whose known 412K of 1M is over a 400K machine ceiling', () => {
    const outcome = evaluate(adapterOf('claude', known(412_000, 1_000_000)), 400_000);
    expect(outcome.decision.recycle).toBe(true);
    expect(outcome.decision.reason).toContain('400K ceiling');
  });

  it('Codex adapters ignore the ceiling', () => {
    const outcome = evaluate(adapterOf('codex', known(412_000, 1_000_000)), 400_000);
    expect(outcome.decision.recycle).toBe(false);
    expect(outcome.decision.reason).not.toContain('ceiling');
  });

  it('Codex still recycles on its own utilization rule', () => {
    expect(evaluate(adapterOf('codex', known(900_000, 1_000_000)), 400_000).decision.recycle).toBe(true);
  });

  it('a ceiling of 0 behaves as before for Claude, and unknown occupancy never recycles', () => {
    expect(evaluate(adapterOf('claude', known(412_000, 1_000_000)), 0).decision.recycle).toBe(false);
    const unknown = adapterOf('claude', { status: 'unknown', reason: 'not-reported' });
    expect(evaluate(unknown, 400_000).decision.recycle).toBe(false);
  });
});
