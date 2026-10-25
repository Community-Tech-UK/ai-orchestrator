import { describe, it, expect } from 'vitest';
import { WorkAdmission } from './work-admission';
import { reserveHelperAdmission } from './helper-admission';

describe('helper work admission', () => {
  it('counts concurrent starts against the helper cap before adapters become visible', () => {
    const admission = new WorkAdmission({ cpuCount: () => 8, loadAverage: () => [0, 0] });
    admission.setWorkloadLevel(1);
    const first = reserveHelperAdmission(false, admission);
    const second = reserveHelperAdmission(false, admission);
    expect(() => reserveHelperAdmission(false, admission)).toThrow('at most 2 helper agents');
    first();
    expect(() => reserveHelperAdmission(false, admission)).not.toThrow();
    second();
  });
  it('allows remote helpers past local caps, but refuses them during restart pause', () => {
    const admission = new WorkAdmission();
    admission.setGlobalPhase('ready');
    expect(() => reserveHelperAdmission(true, admission)).toThrow('paused for restart');
    admission.setGlobalPhase('holding');
    expect(() => reserveHelperAdmission(true, admission)).not.toThrow();
  });
});
