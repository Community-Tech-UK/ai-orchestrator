import { describe, expect, it } from 'vitest';
import type { PlanQueueLinearConnectionState } from '@contracts/schemas/plan-queue';
import { linearConnectionReason, type LinearConnectionReasonInput } from './linear-connection-reason';

function input(overrides: Partial<LinearConnectionReasonInput>): LinearConnectionReasonInput {
  return { state: 'ready', connectorName: 'Work Linear', connectorProblem: null, unreachableCause: null, ...overrides };
}

describe('linearConnectionReason', () => {
  it('has no reason when the connection is ready', () => {
    expect(linearConnectionReason(input({ state: 'ready' }))).toBeNull();
  });

  it('has a plain sentence for every state that is not usable', () => {
    const states: PlanQueueLinearConnectionState[] = [
      'not-set-up',
      'checking',
      'needs-sign-in',
      'someone-else',
      'connector-changed',
      'unreachable',
    ];
    const sentences = states.map((state) => linearConnectionReason(input({ state })));
    for (const sentence of sentences) expect(sentence).toMatch(/^Linear work is paused/);
    expect(new Set(sentences).size).toBe(states.length);
  });

  it('names the connector, and each connector problem and unreachable cause has its own words', () => {
    expect(linearConnectionReason(input({ state: 'needs-sign-in' }))).toContain('"Work Linear"');
    const problems = (['gone', 'off', 'not-linear', 'read-only'] as const).map((connectorProblem) =>
      linearConnectionReason(input({ state: 'connector-changed', connectorProblem })),
    );
    expect(new Set(problems).size).toBe(4);
    const causes = (['unreachable', 'rate-limited', 'unexpected'] as const).map((unreachableCause) =>
      linearConnectionReason(input({ state: 'unreachable', unreachableCause })),
    );
    expect(new Set(causes).size).toBe(3);
  });

  it('keeps the connector name short and on one line, and copes with no name', () => {
    const long = linearConnectionReason(input({ state: 'needs-sign-in', connectorName: `a\nb${'x'.repeat(500)}` }))!;
    expect(long).not.toContain('\n');
    expect(long.length).toBeLessThan(250);
    expect(linearConnectionReason(input({ state: 'needs-sign-in', connectorName: null }))).toContain('the Linear connector');
  });
});
