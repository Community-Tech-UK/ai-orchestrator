import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetMobilePushThrottleForTesting,
  clearMobilePushThrottle,
  sendBrowserEscalationPush,
  sendMobileLiveActivityPush,
  sendMobilePromptPush,
} from './mobile-gateway-push';

function makeDeps(overrides: { configured?: boolean; tokens?: string[] } = {}) {
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
    instanceManager: null,
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

describe('mobile push identity and invalid-token lifecycle', () => {
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
