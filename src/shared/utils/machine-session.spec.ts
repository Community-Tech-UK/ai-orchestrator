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

describe('machineSessionReasonForOrigin', () => {
  it.each(['automation', 'review', 'verification', 'loop', 'workflow', 'consensus', 'failover', 'internal'] as const)(
    'maps automatic origin %s to itself',
    (origin) => {
      expect(machineSessionReasonForOrigin(origin)).toBe(origin);
    },
  );

  it("maps 'interactive' to null", () => {
    expect(machineSessionReasonForOrigin('interactive')).toBeNull();
  });
});

describe('machineSessionReasonOf markers', () => {
  it.each([
    ['no session', undefined, null],
    ['a plain root session', {}, null],
    ['a channel session', { metadata: { spendPurpose: 'channel' } }, null],
    ['the ping-pong reviewer marker', { metadata: { pingPongReviewer: true } }, 'ping-pong-review'],
    ['planQueueRunId', { metadata: { planQueueRunId: 'run-1' } }, 'plan-queue'],
    ['planQueueRole', { metadata: { planQueueRole: 'triage' } }, 'plan-queue'],
    ['spendPurpose plan-queue', { metadata: { spendPurpose: 'plan-queue' } }, 'plan-queue'],
    ['automationId', { metadata: { automationId: 'auto-1' } }, 'automation'],
    ['spendPurpose automation', { metadata: { spendPurpose: 'automation' } }, 'automation'],
    ['spendPurpose repo-job', { metadata: { spendPurpose: 'repo-job' } }, 'repo-job'],
    ['spawnParentInstanceId', { metadata: { spawnParentInstanceId: 'parent-1' } }, 'node-run'],
    ['spendPurpose remote-node', { metadata: { spendPurpose: 'remote-node' } }, 'node-run'],
    ['a parentId alone', { parentId: 'parent-1' }, 'child'],
  ] as const)('classifies %s', (_name, session, expected) => {
    expect(machineSessionReasonOf(session as Parameters<typeof machineSessionReasonOf>[0])).toBe(expected);
  });

  it.each([
    ['plan-queue beats child', { parentId: 'p', metadata: { planQueueRunId: 'r' } }, 'plan-queue'],
    ['plan-queue beats automation', { metadata: { planQueueRunId: 'r', automationId: 'a' } }, 'plan-queue'],
    ['automation beats child', { parentId: 'p', metadata: { automationId: 'a' } }, 'automation'],
    ['repo-job beats child', { parentId: 'p', metadata: { spendPurpose: 'repo-job' } }, 'repo-job'],
    ['node-run beats child', { parentId: 'p', metadata: { spawnParentInstanceId: 'n' } }, 'node-run'],
    ['ping-pong beats every other marker',
      { parentId: 'p', metadata: { pingPongReviewer: true, planQueueRunId: 'r', automationId: 'a' } }, 'ping-pong-review'],
  ] as const)('priority: %s', (_name, session, expected) => {
    expect(machineSessionReasonOf(session as Parameters<typeof machineSessionReasonOf>[0])).toBe(expected);
  });
});

