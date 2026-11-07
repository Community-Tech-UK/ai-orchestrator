import { describe, expect, it } from 'vitest';
import { ALL_INSTANCE_STATUSES } from '../../src/shared/attention/attention-level';
import { presentInstanceStatus } from '../../src/shared/attention/instance-status-presentation';
import { statusLabel, displayStatusLabel } from '../../apps/mobile/src/app/core/status';

describe('phone session status parity', () => {
  it.each(ALL_INSTANCE_STATUSES)('%s has the desktop label', status => {
    expect(statusLabel(status)).toBe(presentInstanceStatus(status).label);
  });

  it('keeps questions and approvals distinct in the exact words sent to the Live Activity', () => {
    expect(displayStatusLabel({ status: 'waiting_for_input' })).toBe(presentInstanceStatus('waiting_for_input').label);
    expect(displayStatusLabel({ status: 'waiting_for_permission' })).toBe(presentInstanceStatus('waiting_for_permission').label);
    expect(presentInstanceStatus('waiting_for_input').label).not.toBe(presentInstanceStatus('waiting_for_permission').label);
  });
});
