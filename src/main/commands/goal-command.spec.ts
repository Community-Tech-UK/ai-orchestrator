import { describe, expect, it } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import {
  applyGoalCommand,
  buildActiveGoalContext,
  getInstanceGoalState,
} from './goal-command';

function makeInstance(metadata?: Record<string, unknown>): Instance {
  return {
    id: 'inst-1',
    provider: 'claude',
    metadata,
  } as Instance;
}

describe('goal command handling', () => {
  it('sets an active goal and builds an explicit provider prompt', () => {
    const instance = makeInstance();

    const result = applyGoalCommand(instance, ['ship', 'settings', 'toggle'], { now: 1000 });

    expect(result.action).toBe('set');
    expect(result.state).toEqual({
      objective: 'ship settings toggle',
      status: 'active',
      createdAt: 1000,
      updatedAt: 1000,
    });
    expect(getInstanceGoalState(instance)).toEqual(result.state);
    expect(result.providerPrompt).toContain('Active goal');
    expect(result.providerPrompt).toContain('ship settings toggle');
    expect(result.providerPrompt).not.toContain('/goal ship');
    expect(buildActiveGoalContext(instance)).toContain('ship settings toggle');
  });

  it('views the active goal without sending a provider prompt', () => {
    const instance = makeInstance({
      goal: {
        objective: 'finish the importer',
        status: 'active',
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    const result = applyGoalCommand(instance, [], { now: 2000 });

    expect(result.action).toBe('view');
    expect(result.providerPrompt).toBeNull();
    expect(result.notice).toContain('finish the importer');
    expect(getInstanceGoalState(instance)?.status).toBe('active');
  });

  it('pauses, resumes, and clears the stored goal', () => {
    const instance = makeInstance();

    applyGoalCommand(instance, ['finish', 'the', 'release'], { now: 1000 });
    const paused = applyGoalCommand(instance, ['pause'], { now: 2000 });
    expect(paused.action).toBe('pause');
    expect(paused.state?.status).toBe('paused');
    expect(buildActiveGoalContext(instance)).toBeNull();

    const resumed = applyGoalCommand(instance, ['resume'], { now: 3000 });
    expect(resumed.action).toBe('resume');
    expect(resumed.state?.status).toBe('active');
    expect(resumed.providerPrompt).toContain('finish the release');

    const cleared = applyGoalCommand(instance, ['clear'], { now: 4000 });
    expect(cleared.action).toBe('clear');
    expect(cleared.state).toBeNull();
    expect(getInstanceGoalState(instance)).toBeNull();
  });

  it('rejects oversized goal text before mutating state', () => {
    const instance = makeInstance();
    const tooLong = 'x'.repeat(4001);

    expect(() => applyGoalCommand(instance, [tooLong], { now: 1000 })).toThrow(/4000 characters/);
    expect(getInstanceGoalState(instance)).toBeNull();
  });
});
