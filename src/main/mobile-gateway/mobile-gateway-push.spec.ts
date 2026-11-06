import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_INSTANCE_STATUSES } from '../../shared/attention/attention-level';
import { presentInstanceStatus } from '../../shared/attention/instance-status-presentation';
import {
  _resetMobilePushThrottleForTesting,
  clearMobilePushThrottle,
  liveActivityDisplayLabel,
  liveActivityStatusLabel,
  sendBrowserEscalationPush,
  sendMobileAutomationFailurePush,
  sendMobileCompletionPush,
  sendMobileLiveActivityPush,
  sendMobilePromptPush,
} from './mobile-gateway-push';

function makeDeps(overrides: {
  configured?: boolean;
  tokens?: string[];
  instanceManager?: { getInstance(id: string): { displayName?: string; workingDirectory?: string } | undefined };
} = {}) {
  const send = vi.fn(async (_deviceTokens: string[], _alert: Record<string, unknown>): Promise<unknown[]> => []);
  const sendLiveActivity = vi.fn(async (
    _tokens: string[],
    _update: Record<string, unknown>,
  ): Promise<unknown[]> => []);
  const clearApnsToken = vi.fn();
  const clearLiveActivityToken = vi.fn();
  const deps = {
    apnsSender: {
      isConfigured: () => overrides.configured ?? true,
      send,
      sendLiveActivity,
    },
    registry: {
      apnsTokens: () => overrides.tokens ?? ['token-1'],
      apnsTargets: () => (overrides.tokens ?? ['token-1']).map((token, index) => ({ deviceId: `host-${index}`, token })),
      liveActivityTokensFor: () => ['activity-token'],
      liveActivityTargetsFor: () => [{ deviceId: 'host-0', token: 'activity-token' }],
      clearApnsToken,
      clearLiveActivityToken,
    },
    instanceManager: overrides.instanceManager ?? null,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { deps: deps as never, send, sendLiveActivity, clearApnsToken, clearLiveActivityToken };
}

afterEach(() => {
  _resetMobilePushThrottleForTesting();
  vi.useRealTimers();
});

const ESCALATION = {
  escalationId: 'esc-1',
  kind: 'relogin_failed',
  profileId: 'profile-1',
  campaignId: 'campaign-1',
  reason: 'Auto re-login failed after 2 attempts',
};

describe('sendBrowserEscalationPush', () => {
  it('sends a categorized push with the escalation id and no secrets', () => {
    const { deps, send } = makeDeps();

    sendBrowserEscalationPush(deps, ESCALATION);

    expect(send).toHaveBeenCalledTimes(1);
    const [tokens, payload] = send.mock.calls[0]! as [string[], Record<string, unknown>];
    expect(tokens).toEqual(['token-1']);
    expect(payload).toMatchObject({
      title: 'Browser agent parked: relogin failed',
      category: 'AIO_BROWSER_ESCALATION',
      threadId: 'campaign-1',
      data: expect.objectContaining({ escalationId: 'esc-1', kind: 'browser_escalation' }),
    });
  });

  it('is a no-op when APNs is not configured', () => {
    const { deps, send } = makeDeps({ configured: false });

    sendBrowserEscalationPush(deps, ESCALATION);

    expect(send).not.toHaveBeenCalled();
  });

  it('is a no-op when no device tokens are registered', () => {
    const { deps, send } = makeDeps({ tokens: [] });

    sendBrowserEscalationPush(deps, ESCALATION);

    expect(send).not.toHaveBeenCalled();
  });

  it('falls back to the profile id as the thread when there is no campaign', () => {
    const { deps, send } = makeDeps();

    sendBrowserEscalationPush(deps, { ...ESCALATION, campaignId: undefined });

    expect(send.mock.calls[0]![1]).toMatchObject({ threadId: 'profile-1' });
  });
});

describe('Live Activity status keys (a wire contract with phones built earlier)', () => {
  it('sends a question as waiting, never as needs approval', () => {
    expect(liveActivityStatusLabel('waiting_for_input')).toBe('waiting');
    expect(liveActivityStatusLabel('waiting_for_permission')).toBe('needs approval');
  });

  it('keeps the other keys the installed widget already colours by', () => {
    for (const status of ['error', 'failed', 'degraded']) expect(liveActivityStatusLabel(status)).toBe('error');
    for (const status of ['idle', 'ready']) expect(liveActivityStatusLabel(status)).toBe('idle');
    for (const status of ['busy', 'processing', 'thinking_deeply', 'initializing', 'respawning', 'waking', 'interrupting']) {
      expect(liveActivityStatusLabel(status)).toBe('working');
    }
  });

  it('reads a status it does not know as working, as before', () => {
    expect(liveActivityStatusLabel('a-status-from-a-newer-app')).toBe('working');
  });

  it('sends the key, the project and the host device id for a waiting question', async () => {
    const { deps, sendLiveActivity } = makeDeps();

    sendMobileLiveActivityPush(deps, 'instance', 'waiting_for_input');

    await vi.waitFor(() => expect(sendLiveActivity).toHaveBeenCalledTimes(1));
    expect(sendLiveActivity.mock.calls[0]![1]).toMatchObject({
      event: 'update',
      contentState: { status: 'waiting', detail: '', hostDeviceId: 'host-0' },
    });
  });
});

describe('Live Activity exact words (displayLabel, beside the older key)', () => {
  it('is the status presenter\'s label for every status', () => {
    for (const status of ALL_INSTANCE_STATUSES) {
      expect(liveActivityDisplayLabel(status), status).toBe(presentInstanceStatus(status).label);
    }
  });

  it('keeps Thinking, Restarting, Stopping, Asleep and Stopped apart where the key folds them together', () => {
    const cases: [string, string, string][] = [
      ['thinking_deeply', 'working', 'Thinking'],
      ['respawning', 'working', 'Restarting'],
      ['waking', 'working', 'Restarting'],
      ['interrupting', 'working', 'Stopping'],
      ['hibernated', 'idle', 'Asleep'],
      ['terminated', 'idle', 'Stopped'],
      ['cancelled', 'idle', 'Stopped'],
    ];
    for (const [status, key, words] of cases) {
      expect(liveActivityStatusLabel(status), `${status} key`).toBe(key);
      expect(liveActivityDisplayLabel(status), `${status} words`).toBe(words);
    }
  });

  it('reads a status it does not know as Working, like the key does', () => {
    expect(liveActivityDisplayLabel('a-status-from-a-newer-app')).toBe('Working');
  });

  it('puts the words in the pushed content state beside the key', async () => {
    const { deps, sendLiveActivity } = makeDeps();

    sendMobileLiveActivityPush(deps, 'instance', 'thinking_deeply');

    await vi.waitFor(() => expect(sendLiveActivity).toHaveBeenCalledTimes(1));
    expect(sendLiveActivity.mock.calls[0]![1]).toMatchObject({
      contentState: { status: 'working', displayLabel: 'Thinking', displayTone: 'thinking', hostDeviceId: 'host-0' },
    });
  });

  it('tells the lock screen a closed session is Stopped, not Ready', async () => {
    const { deps, sendLiveActivity } = makeDeps();

    sendMobileLiveActivityPush(deps, 'instance', 'terminated', 'end');

    await vi.waitFor(() => expect(sendLiveActivity).toHaveBeenCalledTimes(1));
    expect(sendLiveActivity.mock.calls[0]![1]).toMatchObject({
      event: 'end',
      contentState: { status: 'idle', displayLabel: 'Stopped' },
    });
  });
});

describe('status wording in push notifications', () => {
  it('names a permission prompt with the shared status words', () => {
    const { deps, send } = makeDeps();

    sendMobilePromptPush(deps, {
      id: 'p', instanceId: 'i', requestId: 'r', kind: 'permission', toolName: 'Bash',
      title: 'Bash needs approval', message: 'Allow Bash?', createdAt: 1,
    });
    sendMobilePromptPush(deps, {
      id: 'p2', instanceId: 'i', requestId: 'r2', kind: 'permission',
      title: 'Permission required', message: 'Allow?', createdAt: 1,
    });

    expect(send.mock.calls[0]![1]).toMatchObject({ title: 'Bash: Needs your OK' });
    expect(send.mock.calls[1]![1]).toMatchObject({ title: 'Needs your OK' });
  });

  it('calls a finished session Ready, not Idle', () => {
    const { deps, send } = makeDeps({
      instanceManager: { getInstance: () => ({ displayName: 'Fix login', workingDirectory: '/work/shop' }) },
    });

    sendMobileCompletionPush(deps, 'instance');

    expect(send.mock.calls[0]![1]).toMatchObject({ title: 'Fix login finished', body: 'Ready · shop' });
  });
});

describe('mobile push identity and invalid-token lifecycle', () => {
  it('sends only generic automation failure copy and safe identifiers', () => {
    const { deps, send } = makeDeps();

    sendMobileAutomationFailurePush(deps, { automationId: 'daily-review', runId: 'run-1' });

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      title: 'Automation failed', category: 'AIO_AUTOMATION_FAILED',
      data: { kind: 'automation_failed', automationId: 'daily-review', runId: 'run-1', hostDeviceId: 'host-0' },
    });
    expect(JSON.stringify(payload)).not.toContain('prompt');
    expect(JSON.stringify(payload)).not.toContain('error');
  });

  it('adds the paired host device id and clears a 410 APNs token', async () => {
    const { deps, send, clearApnsToken } = makeDeps();
    send.mockResolvedValueOnce([{ deviceToken: 'token-1', ok: false, status: 410, reason: 'Unregistered' }]);

    sendMobilePromptPush(deps, {
      id: 'prompt', instanceId: 'instance', requestId: 'request', kind: 'permission',
      title: 'Approve', message: 'Approve', createdAt: 1,
    });

    await vi.waitFor(() => expect(clearApnsToken).toHaveBeenCalledWith('token-1'));
    expect(send.mock.calls[0]![1]).toMatchObject({
      data: expect.objectContaining({ hostDeviceId: 'host-0' }),
    });
  });

  it('throttles updates per instance but always sends the final state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    const { deps, sendLiveActivity } = makeDeps();

    sendMobileLiveActivityPush(deps, 'instance', 'processing');
    sendMobileLiveActivityPush(deps, 'instance', 'thinking_deeply');
    expect(sendLiveActivity).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendLiveActivity).toHaveBeenCalledTimes(2);

    sendMobileLiveActivityPush(deps, 'instance', 'idle', 'end');
    expect(sendLiveActivity).toHaveBeenCalledTimes(3);
    expect(sendLiveActivity.mock.calls[2]![1]).toMatchObject({
      event: 'end', collapseId: 'live-instance',
    });
  });

  it('cancels pending throttled updates during gateway teardown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    const { deps, sendLiveActivity } = makeDeps();

    sendMobileLiveActivityPush(deps, 'instance', 'processing');
    sendMobileLiveActivityPush(deps, 'instance', 'thinking_deeply');
    clearMobilePushThrottle();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(sendLiveActivity).toHaveBeenCalledTimes(1);
  });
});


it('pushes the exact presenter tone even where labels share different severity', () => {
  const { deps, sendLiveActivity } = makeDeps();
  for (const status of ALL_INSTANCE_STATUSES) {
    sendMobileLiveActivityPush(deps, `tone-${status}`, status);
    expect(sendLiveActivity.mock.calls.at(-1)![1]).toMatchObject({
      contentState: { displayLabel: presentInstanceStatus(status).label, displayTone: presentInstanceStatus(status).tone },
    });
  }
});
