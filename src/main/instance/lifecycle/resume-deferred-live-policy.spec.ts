import { describe, expect, it, vi } from 'vitest';
import { resumeDeferredPermissionWithPolicy } from './resume-deferred-live-policy';

describe('live permission Auto-approve policy', () => {
  it('answers the live ask first, then uses the queued session toggle without a forced lifecycle mutation', async () => {
    const calls: string[] = [];
    const resume = vi.fn(async () => { calls.push('answer'); });
    const queueYoloMode = vi.fn(async () => { calls.push('toggle'); });
    const adapter = { livePermissions: { hasPending: () => true, answer: () => true } };
    await resumeDeferredPermissionWithPolicy(adapter, 'instance-placeholder', true, undefined, { requestId: 'card-placeholder', yoloMode: true }, { resume, queueYoloMode });
    expect(resume).toHaveBeenCalledWith('instance-placeholder', true, undefined, { requestId: 'card-placeholder', yoloMode: undefined });
    expect(queueYoloMode).toHaveBeenCalledWith('instance-placeholder', true);
    expect(calls).toEqual(['answer', 'toggle']);
  });
  it('preserves the held call options and does not toggle on a denied or failed answer', async () => {
    const resume = vi.fn(async () => undefined); const queueYoloMode = vi.fn(async () => undefined);
    await resumeDeferredPermissionWithPolicy({}, 'instance-placeholder', true, undefined, { yoloMode: true }, { resume, queueYoloMode });
    expect(resume).toHaveBeenCalledWith('instance-placeholder', true, undefined, { yoloMode: true });
    expect(queueYoloMode).not.toHaveBeenCalled();
    const adapter = { livePermissions: { hasPending: () => true, answer: () => true } };
    await resumeDeferredPermissionWithPolicy(adapter, 'instance-placeholder', false, undefined, { yoloMode: true }, { resume, queueYoloMode });
    expect(queueYoloMode).not.toHaveBeenCalled();
    resume.mockRejectedValueOnce(new Error('answer failed'));
    await expect(resumeDeferredPermissionWithPolicy(adapter, 'instance-placeholder', true, undefined, { yoloMode: true }, { resume, queueYoloMode })).rejects.toThrow('answer failed');
    expect(queueYoloMode).not.toHaveBeenCalled();
  });
});
