import { describe, expect, it } from 'vitest';
import { applyOpenCodeSessionLevers } from './opencode-session-levers';

describe('applyOpenCodeSessionLevers', () => {
  it('disables title generation while retaining existing agent fields', () => {
    const config: Record<string, unknown> = { agent: { title: { permissions: { edit: 'deny' } }, build: { disabled: false } } };
    applyOpenCodeSessionLevers(config, { major: 2, maxTurns: 7 });
    const agents = config['agent'] as Record<string, Record<string, unknown>>;
    expect(agents['title']).toEqual({ permissions: { edit: 'deny' }, disable: true });
    expect(agents['build']).toEqual({ disabled: false, steps: 7 });
    expect(agents['plan']?.['steps']).toBe(7);
  });

  it('leaves subagent steps alone and omits missing maxTurns', () => {
    const config: Record<string, unknown> = { agent: { task: { steps: 5 } } };
    applyOpenCodeSessionLevers(config, { major: 2 });
    const agents = config['agent'] as Record<string, Record<string, unknown>>;
    expect(agents['task']?.['steps']).toBe(5);
    expect(agents['build']).toBeUndefined();
  });

  it('enables prune only for 1.x', () => {
    const v1: Record<string, unknown> = {};
    applyOpenCodeSessionLevers(v1, { major: 1, maxTurns: 3 });
    expect((v1['compaction'] as Record<string, unknown>)['prune']).toBe(true);
    const v2: Record<string, unknown> = {};
    applyOpenCodeSessionLevers(v2, { major: 2, maxTurns: 3 });
    expect(v2['compaction']).toBeUndefined();
  });
});
