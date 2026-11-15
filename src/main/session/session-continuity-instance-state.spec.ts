import { describe, expect, it } from 'vitest';
import type { AgentProfile } from '../../shared/types/agent.types';
import { createInstance } from '../../shared/types/instance.types';
import { buildInstanceRecord } from '../instance/lifecycle/instance-create-builder';
import { instanceToContinuityState } from './session-continuity-instance-state';

const CONFIG = { persistSessionContent: true, redactToolOutputs: false };

describe('instanceToContinuityState', () => {
  it('records internal sessions so recovery can keep them out of the user\'s list', () => {
    const nodeRun = createInstance({
      workingDirectory: '/workspace',
      metadata: { spawnDepth: 1, hideFromProjectRail: true },
    });
    const reviewer = createInstance({
      workingDirectory: '/workspace',
      metadata: { hideFromProjectRail: true },
    });

    expect(instanceToContinuityState(nodeRun, CONFIG).hideFromProjectRail).toBe(true);
    expect(instanceToContinuityState(reviewer, CONFIG).hideFromProjectRail).toBe(true);
  });

  it('records automation provenance so a crash-recovered run keeps its labels', () => {
    const automation = createInstance({
      workingDirectory: '/workspace',
      metadata: { automationId: 'automation-1', automationRunId: 'run-1', automationHidden: true },
    });

    expect(instanceToContinuityState(automation, CONFIG).automation).toEqual({
      automationId: 'automation-1',
      automationRunId: 'run-1',
      hidden: true,
    });
    expect('automation' in instanceToContinuityState(
      createInstance({ workingDirectory: '/workspace' }),
      CONFIG,
    )).toBe(false);
  });

  it("records a member's stamp, because instance metadata is not copied, and nothing for the owner", () => {
    const hers = createInstance({ workingDirectory: '/workspace', metadata: { mobileProfileId: 'member-1' } });
    const owner = createInstance({ workingDirectory: '/workspace' });

    expect(instanceToContinuityState(hers, CONFIG).mobileProfileId).toBe('member-1');
    expect('mobileProfileId' in instanceToContinuityState(owner, CONFIG)).toBe(false);
  });

  it("records the Set aside agent's folder, so a revived agent keeps its tools, and nothing for other sessions", () => {
    const agent = createInstance({ workingDirectory: '/repo', metadata: { planQueueSetAsideFolder: '/repo' } });
    const other = createInstance({ workingDirectory: '/repo' });

    expect(instanceToContinuityState(agent, CONFIG).planQueueSetAsideFolder).toBe('/repo');
    expect('planQueueSetAsideFolder' in instanceToContinuityState(other, CONFIG)).toBe(false);
  });

  it('leaves the flag off ordinary and automation sessions', () => {
    const own = createInstance({ workingDirectory: '/workspace' });
    const automation = createInstance({
      workingDirectory: '/workspace',
      metadata: { automationId: 'automation-1', automationHidden: true },
    });

    expect('hideFromProjectRail' in instanceToContinuityState(own, CONFIG)).toBe(false);
    expect('hideFromProjectRail' in instanceToContinuityState(automation, CONFIG)).toBe(false);
  });

  it('records a session the user switched the watcher off for, and nothing for the rest', () => {
    const muted = createInstance({ workingDirectory: '/workspace' });
    muted.watcherMuted = true;
    const unmuted = createInstance({ workingDirectory: '/workspace' });
    unmuted.watcherMuted = false;

    expect(instanceToContinuityState(muted, CONFIG).watcherMuted).toBe(true);
    expect('watcherMuted' in instanceToContinuityState(unmuted, CONFIG)).toBe(false);
    expect('watcherMuted' in instanceToContinuityState(createInstance({ workingDirectory: '/workspace' }), CONFIG)).toBe(false);
  });

  it('keeps the mute through a save and a revival: built from the saved state, the session is still muted', () => {
    const agent = { id: 'build', mode: 'build' } as AgentProfile;
    const build = (watcherMuted?: boolean) => buildInstanceRecord(
      { workingDirectory: '/workspace', ...(watcherMuted ? { watcherMuted } : {}) }, agent, { defaultYoloMode: false, getParent: () => undefined });

    const saved = instanceToContinuityState(build(true), CONFIG);
    const revived = build(saved.watcherMuted);
    const neverMuted = build(instanceToContinuityState(build(), CONFIG).watcherMuted);

    expect(revived.watcherMuted).toBe(true);
    expect(neverMuted.watcherMuted).toBeUndefined();
  });
});
