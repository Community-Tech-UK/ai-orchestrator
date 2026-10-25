import { afterEach, describe, expect, it } from 'vitest';
import { getWorkAdmission, WorkAdmission } from './work-admission';
import { queueAdmission } from './queue-admission';

afterEach(() => WorkAdmission._resetForTesting());
describe('queue admission', () => {
  it('starts neither workers, verifiers nor triage during Hold', () => {
    const admission = getWorkAdmission();
    admission.setGlobalPhase('holding');
    const policy = queueAdmission({ workerSlots: 3, verificationSlots: 2, maxLoadAverage: 30 }, 0, 0);
    expect(policy.canStartWorker(0)).toBe(false);
    expect(policy.canStartCheck(0)).toBe(false);
    expect(policy.canStartTriage()).toBe(false);
    admission.setGlobalPhase('none');
    expect(queueAdmission({ workerSlots: 3, verificationSlots: 2, maxLoadAverage: 30 }, 0, 0).canStartWorker(0)).toBe(true);
  });
  it('uses cross-run counts on Lightest and raises only effective slots on Most', () => {
    const admission = getWorkAdmission();
    admission.setWorkloadLevel(1);
    expect(queueAdmission({ workerSlots: 3, verificationSlots: 2, maxLoadAverage: 30 }, 1, 0).canStartWorker(0)).toBe(false);
    admission.setWorkloadLevel(5);
    const policy = queueAdmission({ workerSlots: 3, verificationSlots: 2, maxLoadAverage: 30 }, 10, 10);
    expect(policy.workerSlots).toBe(5);
    expect(policy.verificationSlots).toBe(3);
    expect(policy.canStartWorker(4)).toBe(true);
  });
});
