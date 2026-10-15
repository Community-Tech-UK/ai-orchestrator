import { describe, expect, it } from 'vitest';
import { machineSessionReasonOf, machineSessionReasonForOrigin } from './machine-session';
describe('machine session identity',()=>{
  it('keeps manual/channel sessions interactive and honors queue/reviewer priority',()=>{
    expect(machineSessionReasonOf({metadata:{spendPurpose:'channel'}})).toBeNull();expect(machineSessionReasonForOrigin('interactive')).toBeNull();
    expect(machineSessionReasonOf({parentId:'parent',metadata:{planQueueRunId:'queue'}})).toBe('plan-queue');
    expect(machineSessionReasonOf({metadata:{pingPongReviewer:true,planQueueRunId:'queue'}})).toBe('ping-pong-review');
    expect(machineSessionReasonOf({parentId:'parent'})).toBe('child');
  });
});
