import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logSpies, traceSpy } = vi.hoisted(() => ({
  logSpies: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  traceSpy: vi.fn(),
}));

vi.mock('../../logging/logger', () => ({ getLogger: () => logSpies }));
vi.mock('../../observability/lifecycle-trace', () => ({ recordLifecycleTrace: traceSpy }));

import {
  _setCopilotAccountEventSinkForTesting,
  emitCopilotAccountEvent,
  type CopilotAccountEvent,
} from './copilot-account-events';

/**
 * Spec §18. The positive case is easy; the negative one is the point. Every
 * field this feature touches sits next to credential material — Copilot config
 * files, child environments, login flows — so the assertion that matters is
 * that a token, a raw config, an environment value, prompt content, a device
 * code, or a filesystem path can never reach a log or a trace.
 */
const FORBIDDEN = {
  token: 'gho_NOT_A_REAL_TOKEN_placeholder',
  deviceCode: 'ABCD-1234',
  path: '/Users/me/Library/Application Support/Harness/copilot-cli-profiles/enterprise',
  prompt: 'the user asked about their salary spreadsheet',
  envValue: 'GITHUB_TOKEN=gho_NOT_A_REAL_TOKEN_placeholder',
  rawConfig: '{"copilotTokens":{"github.com:octocat":"gho_x"}}',
};

beforeEach(() => {
  for (const spy of Object.values(logSpies)) spy.mockClear();
  traceSpy.mockClear();
  _setCopilotAccountEventSinkForTesting(null);
});

afterEach(() => {
  _setCopilotAccountEventSinkForTesting(null);
});

describe('copilot account events', () => {
  it('emits each of the five spec events with its identifying fields', () => {
    const captured: CopilotAccountEvent[] = [];
    _setCopilotAccountEventSinkForTesting((event) => captured.push(event));

    emitCopilotAccountEvent({
      event: 'copilot_account_route_resolved',
      profileId: 'enterprise',
      routingSource: 'owner',
      ruleId: 'rule-1',
      origin: 'loop',
      nodeId: 'local',
    });
    emitCopilotAccountEvent({
      event: 'copilot_account_route_blocked',
      failureCode: 'protected-scope-unmapped',
      origin: 'automation',
    });
    emitCopilotAccountEvent({
      event: 'copilot_account_binding_checked',
      profileId: 'enterprise',
      state: 'authenticated',
    });
    emitCopilotAccountEvent({
      event: 'copilot_account_identity_mismatch',
      profileId: 'enterprise',
      observedLogin: 'someone-else',
    });
    emitCopilotAccountEvent({
      event: 'copilot_account_login_launched',
      profileId: 'enterprise',
    });

    expect(captured.map((event) => event.event)).toEqual([
      'copilot_account_route_resolved',
      'copilot_account_route_blocked',
      'copilot_account_binding_checked',
      'copilot_account_identity_mismatch',
      'copilot_account_login_launched',
    ]);
    expect(captured[0].routingSource).toBe('owner');
    expect(captured[1].failureCode).toBe('protected-scope-unmapped');
  });

  it('writes to the subsystem log and the lifecycle trace by default', () => {
    emitCopilotAccountEvent({
      event: 'copilot_account_route_resolved',
      profileId: 'personal',
      routingSource: 'default',
    });
    expect(logSpies.info).toHaveBeenCalledWith(
      'copilot_account_route_resolved',
      expect.objectContaining({ profileId: 'personal', routingSource: 'default' }),
    );
    expect(traceSpy).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'copilot_account_route_resolved', provider: 'copilot' }),
    );
  });

  it('has no field that can carry a token, raw config, env value, prompt, device code, or path', () => {
    // The event type is a CLOSED set of fields with no free-form metadata bag,
    // so the only way to attempt a leak is to force one in.
    emitCopilotAccountEvent({
      event: 'copilot_account_identity_mismatch',
      profileId: 'enterprise',
      nodeId: 'local',
      observedLogin: 'someone-else',
      observedHost: 'github.com',
      ...(FORBIDDEN as unknown as Record<string, never>),
    } as CopilotAccountEvent);

    const emitted = JSON.stringify([logSpies.info.mock.calls, traceSpy.mock.calls]);
    for (const [name, value] of Object.entries(FORBIDDEN)) {
      expect(emitted, name).not.toContain(value);
    }
  });

  it('logs nothing beyond the declared fields even for a fully populated event', () => {
    emitCopilotAccountEvent({
      event: 'copilot_account_binding_checked',
      profileId: 'enterprise',
      nodeId: 'local',
      origin: 'review',
      routingSource: 'repository',
      ruleId: 'rule-9',
      failureCode: 'profile-unauthenticated',
      state: 'unauthenticated',
      observedLogin: 'octocat',
      observedHost: 'github.com',
      instanceId: 'inst-1',
    });
    const [, payload] = logSpies.info.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(payload).sort()).toEqual([
      'failureCode',
      'nodeId',
      'observedHost',
      'observedLogin',
      'origin',
      'profileId',
      'routingSource',
      'ruleId',
      'state',
    ]);
  });
});
