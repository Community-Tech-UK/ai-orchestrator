import { describe, expect, it } from 'vitest';
import {
  agentModeName,
  copilotAccountBadgeFor,
  remoteNodeTooltip,
  waitReasonDetail,
  waitReasonLabel,
} from './instance-header-presentation';

describe('waitReasonLabel', () => {
  const now = Date.UTC(2026, 10, 3, 10, 0, 0);

  it('says what the session is waiting on, in plain words', () => {
    expect(waitReasonLabel({ kind: 'respawning', strategy: 'native-resume' } as never)).toBe('Resuming session…');
    expect(waitReasonLabel({ kind: 'respawning', strategy: 'fresh' } as never)).toBe('Restarting session…');
    expect(waitReasonLabel({ kind: 'interrupt-ack', attempt: 1, startedAt: 0 })).toBe('Waiting for interrupt…');
    expect(waitReasonLabel({ kind: 'provider-slot', provider: 'codex' } as never)).toBe('Waiting for another Codex session to finish…');
    expect(waitReasonLabel({ kind: 'resume-proof', provider: 'codex' } as never)).toBe('Verifying session resume…');
    expect(waitReasonLabel({ kind: 'remote-heartbeat', nodeId: 'n', staleForMs: 1 })).toBe('Waiting for its computer to reconnect…');
    expect(waitReasonLabel({ kind: 'mutex', operation: 'x' } as never)).toBe('Finishing the previous action…');
    expect(waitReasonLabel({ kind: 'terminating', force: false } as never)).toBe('Terminating…');
    expect(waitReasonLabel({ kind: 'terminating', force: true } as never)).toBe('Force terminating…');
    expect(waitReasonLabel(undefined)).toBeNull();
  });

  it('counts down a back-off and says Retrying once it is due', () => {
    expect(waitReasonLabel({ kind: 'backoff', attempt: 1, retryAt: now + 4_600 }, now)).toBe('Backing off — retry in 5s');
    expect(waitReasonLabel({ kind: 'backoff', attempt: 1, retryAt: now - 1 }, now)).toBe('Retrying…');
  });

  it('leaves quota and sign-in waits to their composer banners', () => {
    expect(waitReasonLabel({ kind: 'quota-park', provider: 'codex', resumeAt: now } as never)).toBeNull();
    expect(waitReasonLabel({ kind: 'auth-required', provider: 'codex', since: now } as never)).toBeNull();
  });
});

describe('waitReasonDetail', () => {
  it('keeps the runtime values in the hover text, not the visible label', () => {
    expect(waitReasonDetail({ kind: 'interrupt-ack', attempt: 2, startedAt: 0 })).toBe('Attempt 2');
    expect(waitReasonDetail({ kind: 'remote-heartbeat', nodeId: 'n', staleForMs: 2_600 })).toBe('No reply for 3s');
    expect(waitReasonDetail({ kind: 'terminating', force: true } as never)).toBe('Force kill');
    expect(waitReasonDetail({ kind: 'mutex', operation: 'restart', owner: 'ping-pong' } as never)).toBe('Owner: ping-pong');
    expect(waitReasonDetail({ kind: 'mutex', operation: 'restart' } as never)).toBe('restart');
    expect(waitReasonDetail(undefined)).toBe('');
  });
});

describe('copilotAccountBadgeFor', () => {
  const stamped = (copilotRoutingSource?: string) => copilotAccountBadgeFor({
    provider: 'copilot', copilotAccountProfileId: 'work-seat', copilotRoutingSource,
  } as never);

  it('shows only for a Copilot session that was stamped with an account', () => {
    expect(copilotAccountBadgeFor({ provider: 'claude', copilotAccountProfileId: 'work-seat' } as never)).toBeNull();
    expect(copilotAccountBadgeFor({ provider: 'copilot' } as never)).toBeNull();
    expect(stamped()?.label).toBe('work-seat');
  });

  it.each([
    ['repository', 'matched this repository'],
    ['owner', 'matched this GitHub owner'],
    ['path-prefix', 'matched this folder'],
    ['explicit', 'you chose this account'],
    ['persisted', 'carried over from when this conversation started'],
    ['legacy', 'your existing Copilot sign-in'],
    [undefined, 'the default account'],
  ])('explains a %s route', (source, reason) => {
    expect(stamped(source)?.title).toBe(`GitHub Copilot account: work-seat — ${reason}`);
  });
});

describe('agentModeName', () => {
  it('reads Build unless the session is in Plan or Review', () => {
    expect(agentModeName(undefined)).toBe('Build');
    expect(agentModeName('build')).toBe('Build');
    expect(agentModeName('plan')).toBe('Plan');
    expect(agentModeName('review')).toBe('Review');
  });
});

describe('remoteNodeTooltip', () => {
  const node = {
    name: 'windows-pc', status: 'connected', latencyMs: 12, activeInstances: 2,
    capabilities: { platform: 'win32', arch: 'x64', cpuCores: 8, availableMemoryMB: 8192, totalMemoryMB: 16384, supportedClis: ['claude', 'codex'] },
  };

  it('lists the computer, its load and its tools', () => {
    expect(remoteNodeTooltip(node, 'windows-pc').split('\n')).toEqual([
      'windows-pc', 'Platform: Windows (x64)', 'Latency: 12ms', 'CPU: 8 cores', 'Memory: 8.0 / 16.0 GB',
      'CLIs: claude, codex', 'Sessions: 2 active', 'Status: connected',
    ]);
  });

  it('names the computer, never a raw id, when it is no longer registered', () => {
    expect(remoteNodeTooltip(null, 'Windows computer')).toBe('Windows computer is no longer registered');
  });
});
