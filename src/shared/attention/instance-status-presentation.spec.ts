import { describe, expect, it } from 'vitest';
import type { InstanceStatus } from '@contracts/types/instance-events';
import type { InstanceWaitReason } from '../types/instance-wait-reason.types';
import { ALL_INSTANCE_STATUSES, attentionLevelForInstanceStatus } from './attention-level';
import {
  INSTANCE_STATUS_LABELS,
  INSTANCE_STATUS_TONE_COLORS,
  describeInstanceStatus,
  isInstanceStatus,
  liveActivityStatusKey,
  presentInstanceStatus,
  type InstanceStatusLabel,
  type InstanceStatusTone,
} from './instance-status-presentation';

/** Status -> [label, tone]: the whole vocabulary on one screen. */
const EXPECTED: Record<InstanceStatus, [InstanceStatusLabel, InstanceStatusTone]> = {
  initializing: ['Working', 'working'],
  ready: ['Ready', 'ok'],
  idle: ['Ready', 'ok'],
  busy: ['Working', 'working'],
  processing: ['Working', 'working'],
  thinking_deeply: ['Thinking', 'thinking'],
  waiting_for_input: ['Needs your answer', 'attention'],
  waiting_for_permission: ['Needs your OK', 'attention'],
  interrupting: ['Stopping', 'stopping'],
  cancelling: ['Stopping', 'stopping'],
  'interrupt-escalating': ['Stopping', 'danger'],
  cancelled: ['Stopped', 'quiet'],
  superseded: ['Stopped', 'quiet'],
  respawning: ['Restarting', 'thinking'],
  hibernating: ['Asleep', 'asleep'],
  hibernated: ['Asleep', 'asleep'],
  waking: ['Restarting', 'thinking'],
  degraded: ['Problem', 'warning'],
  error: ['Problem', 'danger'],
  failed: ['Problem', 'danger'],
  terminated: ['Stopped', 'quiet'],
};

describe('presentInstanceStatus', () => {
  it('has an entry for every status the app can report', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ALL_INSTANCE_STATUSES].sort());
  });

  it.each(ALL_INSTANCE_STATUSES.map((status) => [status, ...EXPECTED[status]] as const))(
    '%s reads "%s" in the %s tone',
    (status, label, tone) => {
      const presentation = presentInstanceStatus(status);
      expect(presentation.label).toBe(label);
      expect(presentation.tone).toBe(tone);
      expect(presentation.color).toBe(INSTANCE_STATUS_TONE_COLORS[tone]);
    },
  );

  it('uses a short closed list of plain labels', () => {
    const used = new Set(ALL_INSTANCE_STATUSES.map((status) => presentInstanceStatus(status).label));
    expect([...used].sort()).toEqual([...INSTANCE_STATUS_LABELS].sort());
    expect(INSTANCE_STATUS_LABELS.length).toBeLessThanOrEqual(10);
    for (const label of INSTANCE_STATUS_LABELS) {
      expect(label).not.toMatch(/[_]|\.\.\.|…/);
      expect(label).not.toMatch(/\b(AIO|instance|degraded|hibernat|respawn|interrupt)/i);
    }
  });

  it('never calls a question an approval', () => {
    expect(presentInstanceStatus('waiting_for_input').label).toBe('Needs your answer');
    expect(presentInstanceStatus('waiting_for_permission').label).toBe('Needs your OK');
    expect(presentInstanceStatus('waiting_for_input').detail).not.toMatch(/permission|approv/i);
    expect(presentInstanceStatus('waiting_for_permission').detail).toMatch(/permission/);
  });

  it('flags needsYou exactly where the attention scale says blocked', () => {
    for (const status of ALL_INSTANCE_STATUSES) {
      expect(presentInstanceStatus(status).needsYou).toBe(attentionLevelForInstanceStatus(status) === 'blocked');
    }
  });

  it('keeps the dot behaviour the sidebar and the row had before', () => {
    const pulsing = ALL_INSTANCE_STATUSES.filter((status) => presentInstanceStatus(status).pulse);
    expect(pulsing.sort()).toEqual([
      'cancelling', 'hibernating', 'initializing', 'interrupt-escalating', 'interrupting',
      'respawning', 'waiting_for_input', 'waiting_for_permission', 'waking',
    ].sort());
    const spinning = ALL_INSTANCE_STATUSES.filter((status) => presentInstanceStatus(status).spinner);
    expect(spinning.sort()).toEqual([
      'busy', 'cancelling', 'interrupt-escalating', 'interrupting', 'processing', 'thinking_deeply',
    ].sort());
    const inProgress = ALL_INSTANCE_STATUSES.filter((status) => presentInstanceStatus(status).inProgress);
    expect(inProgress.sort()).toEqual([
      'busy', 'cancelling', 'hibernating', 'initializing', 'interrupt-escalating', 'interrupting',
      'processing', 'respawning', 'thinking_deeply', 'waking',
    ].sort());
  });

  it('draws respawning in one colour, the teal the sidebar already used', () => {
    expect(presentInstanceStatus('respawning').color).toBe('#4fa3a5');
    expect(presentInstanceStatus('respawning').color).toBe(presentInstanceStatus('thinking_deeply').color);
  });

  it('writes details as lowercase fragments with no raw codes', () => {
    for (const status of ALL_INSTANCE_STATUSES) {
      const { detail } = presentInstanceStatus(status);
      expect(detail).not.toMatch(/[_]|[A-Z]{3,}\b/);
      if (detail) expect(detail[0]).toBe(detail[0]!.toLowerCase());
    }
  });

  it('reads an unknown status as plain working rather than throwing', () => {
    const presentation = presentInstanceStatus('brand-new-status' as InstanceStatus);
    expect(presentation.label).toBe('Working');
    expect(presentation.needsYou).toBe(false);
  });

  describe('wait reasons', () => {
    const quotaPark: InstanceWaitReason = { kind: 'quota-park', provider: 'claude', resumeAt: 5 };
    const authRequired: InstanceWaitReason = { kind: 'auth-required', provider: 'opencode', since: 5 };

    it('shows a session parked on a usage limit as asleep, not ready', () => {
      const presentation = presentInstanceStatus('idle', quotaPark);
      expect(presentation.label).toBe('Asleep');
      expect(presentation.tone).toBe('asleep');
      expect(presentation.detail).toBe('paused until your Claude allowance resets');
      expect(presentation.inProgress).toBe(false);
    });

    it('shows a signed-out session as a problem and names the account family, not a raw id', () => {
      const presentation = presentInstanceStatus('idle', authRequired);
      expect(presentation.label).toBe('Problem');
      expect(presentation.tone).toBe('warning');
      expect(presentation.detail).toBe('signed out of MiMo');
    });

    it('does not override a question or an approval', () => {
      expect(presentInstanceStatus('waiting_for_permission', quotaPark).label).toBe('Needs your OK');
      expect(presentInstanceStatus('waiting_for_input', authRequired).detail)
        .toBe('the agent asked you a question');
    });

    it('keeps a problem or a stop as it is and only adds the reason', () => {
      const failed = presentInstanceStatus('failed', authRequired);
      expect(failed.label).toBe('Problem');
      expect(failed.tone).toBe('danger');
      expect(failed.detail).toBe('signed out of MiMo');
      expect(presentInstanceStatus('terminated', quotaPark).label).toBe('Stopped');
    });

    it('explains a hold without changing the label', () => {
      const cases: [InstanceStatus, InstanceWaitReason, string][] = [
        ['busy', { kind: 'provider-slot', provider: 'opencode', startedAt: 1 }, 'waiting for another OpenCode session to finish'],
        ['interrupting', { kind: 'interrupt-ack', startedAt: 1, attempt: 2 }, 'waiting for the current work to stop'],
        ['idle', { kind: 'terminating', force: true, startedAt: 1 }, 'closing it by force'],
        ['respawning', { kind: 'respawning', strategy: 'native-resume', startedAt: 1 }, 'picking up where it left off'],
        ['respawning', { kind: 'respawning', strategy: 'fresh-replay', startedAt: 1 }, 'restarting with your recent messages carried over'],
        ['respawning', { kind: 'resume-proof', provider: 'claude', startedAt: 1 }, 'checking that the conversation was restored'],
        ['degraded', { kind: 'remote-heartbeat', nodeId: 'node-7', staleForMs: 9000 }, 'waiting for its computer to reconnect'],
        ['busy', { kind: 'mutex', operation: 'respawn', startedAt: 1 }, 'finishing the previous action first'],
        ['error', { kind: 'backoff', attempt: 3, retryAt: 9 }, 'trying again shortly'],
      ];
      for (const [status, wait, detail] of cases) {
        const presentation = presentInstanceStatus(status, wait);
        expect(presentation.label).toBe(EXPECTED[status][0]);
        expect(presentation.detail).toBe(detail);
        expect(presentation.detail).not.toMatch(/node-7|native-resume|fresh-replay|opencode/);
      }
    });

    it('treats a missing or null wait reason as no wait reason', () => {
      expect(presentInstanceStatus('idle', null)).toEqual(presentInstanceStatus('idle'));
      expect(presentInstanceStatus('idle', undefined)).toEqual(presentInstanceStatus('idle'));
    });
  });

  describe('background work', () => {
    it('shows an idle session that still owns background work as working in the background', () => {
      for (const status of ['idle', 'ready'] as const) {
        const presentation = presentInstanceStatus(status, null, { backgroundWorkCount: 2 });
        expect(presentation.label).toBe('Working');
        expect(presentation.tone).toBe('background');
        expect(presentation.color).toBe('#7aa2c8');
        expect(presentation.detail).toBe('waiting on background work');
        expect(presentation.spinner).toBe(false);
        expect(presentation.inProgress).toBe(false);
      }
    });

    it('lets a running turn win, and ignores a count of zero', () => {
      expect(presentInstanceStatus('busy', null, { backgroundWorkCount: 3 }).tone).toBe('working');
      expect(presentInstanceStatus('idle', null, { backgroundWorkCount: 0 }).label).toBe('Ready');
    });
  });
});

describe('describeInstanceStatus', () => {
  it('joins label and detail, or gives the label alone', () => {
    expect(describeInstanceStatus(presentInstanceStatus('idle'))).toBe('Ready');
    expect(describeInstanceStatus(presentInstanceStatus('hibernated'))).toBe('Asleep — send a message to wake it');
  });
});

describe('isInstanceStatus', () => {
  it('accepts every real status and nothing else', () => {
    for (const status of ALL_INSTANCE_STATUSES) expect(isInstanceStatus(status)).toBe(true);
    expect(isInstanceStatus('working')).toBe(false);
    expect(isInstanceStatus(undefined)).toBe(false);
  });
});

describe('liveActivityStatusKey (phone wire keys)', () => {
  const EXPECTED_KEYS: Record<InstanceStatus, string> = {
    initializing: 'working', ready: 'idle', idle: 'idle', busy: 'working', processing: 'working',
    thinking_deeply: 'working', waiting_for_input: 'waiting', waiting_for_permission: 'needs approval',
    interrupting: 'working', cancelling: 'working', 'interrupt-escalating': 'working', cancelled: 'idle',
    superseded: 'idle', respawning: 'working', hibernating: 'idle', hibernated: 'idle', waking: 'working',
    degraded: 'error', error: 'error', failed: 'error', terminated: 'idle',
  };

  it.each(ALL_INSTANCE_STATUSES.map((status) => [status, EXPECTED_KEYS[status]] as const))(
    '%s is sent as "%s"',
    (status, key) => {
      expect(liveActivityStatusKey(status)).toBe(key);
    },
  );

  it('sends a question as waiting, not as needs approval', () => {
    expect(liveActivityStatusKey('waiting_for_input')).toBe('waiting');
    expect(liveActivityStatusKey('waiting_for_permission')).toBe('needs approval');
  });
});
