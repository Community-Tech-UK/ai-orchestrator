import { describe, expect, it } from 'vitest';
import { buildNeverDelegableAskDecision, deriveApprovalCategory } from './approval-category';
import type { PermissionRequest } from './permission-manager';

function req(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: 'req-1',
    instanceId: 'inst-1',
    scope: 'file_read',
    resource: '/tmp/foo.txt',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('deriveApprovalCategory', () => {
  it('maps secret_access scope to "credentials"', () => {
    expect(deriveApprovalCategory(req({ scope: 'secret_access', resource: 'API_KEY' }))).toBe('credentials');
  });

  it('does NOT derive a category for ordinary file/bash/tool scopes', () => {
    for (const scope of ['file_read', 'file_write', 'bash_execute', 'tool_use', 'git_operation'] as const) {
      expect(deriveApprovalCategory(req({ scope }))).toBeNull();
    }
  });

  it('does NOT auto-derive a category from external_service scope alone (must be hinted)', () => {
    expect(deriveApprovalCategory(req({ scope: 'external_service', resource: 'gh pr create' }))).toBeNull();
  });

  it('honors an explicit context.categoryHint for scopes with no structural signal', () => {
    expect(
      deriveApprovalCategory(
        req({ scope: 'external_service', resource: 'gh pr create', context: { categoryHint: 'external_publish' } }),
      ),
    ).toBe('external_publish');
    expect(
      deriveApprovalCategory(req({ scope: 'tool_use', resource: 'charge_card', context: { categoryHint: 'billing' } })),
    ).toBe('billing');
    expect(
      deriveApprovalCategory(
        req({ scope: 'tool_use', resource: 'ask_user', context: { categoryHint: 'interactive_question' } }),
      ),
    ).toBe('interactive_question');
  });

  it('an explicit hint wins even when it disagrees with the scope-based mapping', () => {
    expect(
      deriveApprovalCategory(req({ scope: 'secret_access', context: { categoryHint: 'billing' } })),
    ).toBe('billing');
  });
});

describe('buildNeverDelegableAskDecision', () => {
  it('always forces action=ask with a never-delegable reason, never cached', () => {
    const request = req({ scope: 'secret_access', resource: 'DB_PASSWORD' });
    const decision = buildNeverDelegableAskDecision(request, 'credentials');

    expect(decision.action).toBe('ask');
    expect(decision.category).toBe('credentials');
    expect(decision.decidedBy).toBe('never-delegable-guard');
    expect(decision.reason).toBe('never-delegable:credentials');
    expect(decision.fromCache).toBe(false);
    expect(decision.request).toBe(request);
  });
});
