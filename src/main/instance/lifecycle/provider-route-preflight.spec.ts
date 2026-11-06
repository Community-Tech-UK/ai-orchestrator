import { describe, expect, it, vi } from 'vitest';

vi.mock('./copilot-route-preflight', () => ({
  attachCopilotRoute: vi.fn((_cli: string, options: unknown) => Promise.resolve(options)),
}));
vi.mock('./account-route-preflight', () => ({
  attachAccountRoute: vi.fn((_cli: string, options: unknown) => Promise.resolve(options)),
}));

import { attachProviderRoutes } from './provider-route-preflight';
import { attachCopilotRoute } from './copilot-route-preflight';
import { attachAccountRoute } from './account-route-preflight';
import type { CopilotInvocationOrigin } from '../../../shared/types/copilot-account.types';
import type { SessionKind } from '../../../shared/types/session-kind.types';

describe('attachProviderRoutes stamps', () => {
  it.each([
    ['automation', 'automation', 'automation'],
    ['review', 'review', 'review'],
    ['verification', 'verification', 'review'],
    ['loop', 'loop', 'loop'],
    ['workflow', 'workflow', 'review'],
    ['consensus', 'consensus', 'review'],
    ['failover', 'failover', 'review'],
    ['internal', 'internal', 'review'],
  ] as [CopilotInvocationOrigin, string, SessionKind][])(
    'the %s origin stamps machineSession %s and sessionKind %s',
    async (origin, machineSession, sessionKind) => {
      const result = await attachProviderRoutes('claude', {}, origin);
      expect(result.machineSession).toBe(machineSession);
      expect(result.sessionKind).toBe(sessionKind);
    },
  );

  it("'interactive' leaves machineSession unset and stamps a chat", async () => {
    const result = await attachProviderRoutes('codex', {}, 'interactive');
    expect(result.machineSession).toBeUndefined();
    expect(result.sessionKind).toBe('chat');
  });

  it('keeps an explicit machineSession and sessionKind from the caller', async () => {
    const result = await attachProviderRoutes(
      'codex',
      { machineSession: 'plan-queue', sessionKind: 'plan-queue' },
      'interactive',
    );
    expect(result.machineSession).toBe('plan-queue');
    expect(result.sessionKind).toBe('plan-queue');
  });

  it('hands the stamped options to both account preflights', async () => {
    await attachProviderRoutes('claude', {}, 'loop', { instanceId: 'instance-1' });
    expect(attachCopilotRoute).toHaveBeenCalledWith(
      'claude', expect.objectContaining({ machineSession: 'loop', sessionKind: 'loop' }), 'loop', { instanceId: 'instance-1' },
    );
    expect(attachAccountRoute).toHaveBeenCalledWith(
      'claude', expect.objectContaining({ machineSession: 'loop', sessionKind: 'loop' }), 'loop', { instanceId: 'instance-1' },
    );
  });
});
