import { describe, expect, it, vi } from 'vitest';
import type { CopilotRouteOutcome } from '../../../shared/types/copilot-account.types';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { refuseAvoidedCopilotRoute } from './copilot-account-routing-service';

const routed: CopilotRouteOutcome = {
  ok: true,
  route: { profileId: 'work', profileLabel: 'Work seat', source: 'rule', executionNodeId: 'local', expectedLogin: null } as never,
};

describe('refuseAvoidedCopilotRoute', () => {
  it('refuses a resolved profile on the never-use list, naming the account', () => {
    expect(refuseAvoidedCopilotRoute(routed, ['work'])).toEqual({
      ok: false,
      code: 'automation-disallowed',
      detail: 'The Work seat account is on your never-use list (Plan Queue page), so this session cannot use it.',
      profileId: 'work',
    });
  });

  it('passes a route through when its profile is not on the list', () => {
    expect(refuseAvoidedCopilotRoute(routed, ['other'])).toBe(routed);
    expect(refuseAvoidedCopilotRoute(routed, undefined)).toBe(routed);
  });

  it('leaves a failure as it is', () => {
    const failure: CopilotRouteOutcome = { ok: false, code: 'no-profiles', detail: 'none' };
    expect(refuseAvoidedCopilotRoute(failure, ['work'])).toBe(failure);
  });
});
