import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPlanModeTools,
  registerPlanModeTools,
  getPlanModeTools,
  _resetPlanModeToolsForTesting,
} from '../plan-mode-tool';
import type { Instance } from '../../../shared/types/instance.types';

function makeInstance(state: Instance['planMode']): Instance {
  return {
    planMode: state,
  } as unknown as Instance;
}

describe('plan-mode-tool', () => {
  beforeEach(() => {
    _resetPlanModeToolsForTesting();
  });

  it('createPlanModeTools delegates to InstanceManager-like deps', async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const tools = createPlanModeTools({
      enterPlanMode: (id) => {
        calls.push({ method: 'enter', args: [id] });
        return makeInstance({ enabled: true, state: 'planning' });
      },
      exitPlanMode: (id, force) => {
        calls.push({ method: 'exit', args: [id, force] });
        return makeInstance({ enabled: false, state: 'off' });
      },
      approvePlan: (id, content) => {
        calls.push({ method: 'approve', args: [id, content] });
        return makeInstance({ enabled: true, state: 'approved', planContent: content });
      },
    });

    const enterResult = await tools.planEnterTool.execute(
      { instanceId: 'inst-1' },
      { instanceId: 'inst-1', workingDirectory: '/tmp' },
    );
    expect(enterResult).toEqual({
      ok: true,
      planMode: { enabled: true, state: 'planning' },
    });

    const approveResult = await tools.planApproveTool.execute(
      { instanceId: 'inst-1', planContent: 'do the thing' },
      { instanceId: 'inst-1', workingDirectory: '/tmp' },
    );
    expect(approveResult).toEqual({
      ok: true,
      planMode: { enabled: true, state: 'approved', planContent: 'do the thing' },
    });

    const exitResult = await tools.planExitTool.execute(
      { instanceId: 'inst-1', force: true },
      { instanceId: 'inst-1', workingDirectory: '/tmp' },
    );
    expect(exitResult).toEqual({
      ok: true,
      planMode: { enabled: false, state: 'off' },
    });

    expect(calls).toEqual([
      { method: 'enter', args: ['inst-1'] },
      { method: 'approve', args: ['inst-1', 'do the thing'] },
      { method: 'exit', args: ['inst-1', true] },
    ]);
  });

  it('exposes all three tools in a tools array', () => {
    const tools = createPlanModeTools({
      enterPlanMode: () => makeInstance({ enabled: true, state: 'planning' }),
      exitPlanMode: () => makeInstance({ enabled: false, state: 'off' }),
      approvePlan: () => makeInstance({ enabled: true, state: 'approved' }),
    });
    expect(tools.tools).toHaveLength(3);
    expect(tools.tools.map((t) => t.id).sort()).toEqual(['plan_approve', 'plan_enter', 'plan_exit']);
  });

  it('registerPlanModeTools caches the result and getPlanModeTools returns it', () => {
    expect(getPlanModeTools()).toBeNull();
    const first = registerPlanModeTools({
      enterPlanMode: () => makeInstance({ enabled: true, state: 'planning' }),
      exitPlanMode: () => makeInstance({ enabled: false, state: 'off' }),
      approvePlan: () => makeInstance({ enabled: true, state: 'approved' }),
    });
    const second = registerPlanModeTools({
      enterPlanMode: () => makeInstance({ enabled: true, state: 'planning' }),
      exitPlanMode: () => makeInstance({ enabled: false, state: 'off' }),
      approvePlan: () => makeInstance({ enabled: true, state: 'approved' }),
    });
    expect(first).toBe(second);
    expect(getPlanModeTools()).toBe(first);
  });
});
