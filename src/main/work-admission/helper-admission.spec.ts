import { describe, it, expect } from 'vitest';
import { WorkAdmission } from './work-admission';
import { isRunningHelperAgent, reserveHelperAdmission } from './helper-admission';

describe('helper work admission', () => {
  it('counts concurrent starts against the helper cap before adapters become visible', () => {
    const admission = new WorkAdmission({ cpuCount: () => 8, loadAverage: () => [0, 0] });
    admission.setWorkloadLevel(1);
    const first = reserveHelperAdmission({}, admission);
    const second = reserveHelperAdmission({}, admission);
    expect(() => reserveHelperAdmission({}, admission)).toThrow('at most 2 helper agents');
    first();
    expect(() => reserveHelperAdmission({}, admission)).not.toThrow();
    second();
  });
  it('counts helpers on other computers against the cap', () => {
    const admission = new WorkAdmission({ cpuCount: () => 8, loadAverage: () => [100, 100] });
    admission.setWorkloadLevel(1);
    const first = reserveHelperAdmission({ otherComputer: true }, admission);
    reserveHelperAdmission({ otherComputer: true }, admission);
    expect(() => reserveHelperAdmission({ otherComputer: true }, admission)).toThrow('at most 2 helper agents');
    first();
    expect(() => reserveHelperAdmission({ otherComputer: true }, admission)).not.toThrow();
  });
  it('lets engine-owned helpers past the caps, but refuses them during restart pause', () => {
    const admission = new WorkAdmission();
    admission.setGlobalPhase('ready');
    expect(() => reserveHelperAdmission({ remote: true }, admission)).toThrow('paused for restart');
    admission.setGlobalPhase('holding');
    expect(() => reserveHelperAdmission({ remote: true }, admission)).not.toThrow();
  });
  it('counts a running session with a parent or a run_on_node spawn depth, and nothing else', () => {
    expect(isRunningHelperAgent({ id: 'a', status: 'busy', parentId: 'root' })).toBe(true);
    expect(isRunningHelperAgent({ id: 'b', status: 'busy', metadata: { spawnDepth: 1 } })).toBe(true);
    expect(isRunningHelperAgent({ id: 'c', status: 'busy' })).toBe(false);
    expect(isRunningHelperAgent({ id: 'd', status: 'idle', parentId: 'root' })).toBe(false);
    expect(isRunningHelperAgent({ id: 'e', status: 'terminated', metadata: { spawnDepth: 1 } })).toBe(false);
  });
});
