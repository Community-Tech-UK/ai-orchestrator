import { describe, expect, it, vi } from 'vitest';
import { sendBrowserEscalationPush } from './mobile-gateway-push';

function makeDeps(overrides: { configured?: boolean; tokens?: string[] } = {}) {
  const send = vi.fn(async (_deviceTokens: string[], _alert: Record<string, unknown>) => undefined);
  const deps = {
    apnsSender: {
      isConfigured: () => overrides.configured ?? true,
      send,
    },
    registry: {
      apnsTokens: () => overrides.tokens ?? ['token-1'],
    },
    instanceManager: null,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { deps: deps as never, send };
}

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
