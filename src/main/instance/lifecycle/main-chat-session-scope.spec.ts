import { describe, expect, it } from 'vitest';
import { isMainChatSession, mainChatSessionSkipReason, type MainChatSessionScope } from './main-chat-session-scope';

const main: MainChatSessionScope = { parentId: null, executionLocation: { type: 'local' } };

describe('main chat session scope', () => {
  it('accepts a local root chat without machine-session provenance', () => {
    expect(isMainChatSession(main)).toBe(true);
    expect(mainChatSessionSkipReason(main)).toBeNull();
  });

  it.each([
    [{ parentId: 'parent' }, 'child'],
    [{ metadata: { planQueueRunId: 'queue' } }, 'plan-queue'],
    [{ metadata: { planQueueItemId: 'item' } }, 'plan-queue'],
    [{ metadata: { planQueueRole: 'verifier' } }, 'plan-queue'],
    [{ metadata: { spendPurpose: 'plan-queue' } }, 'plan-queue'],
    [{ metadata: { automationId: 'automation' } }, 'automation'],
    [{ metadata: { automationRunId: 'run' } }, 'automation'],
    [{ metadata: { spendPurpose: 'automation' } }, 'automation'],
    [{ metadata: { repoJobId: 'job-1' } }, 'repo-job'],
    [{ metadata: { spendPurpose: 'repo-job' } }, 'repo-job'],
    [{ metadata: { pingPongReviewer: true } }, 'ping-pong-reviewer'],
    [{ executionLocation: { type: 'remote', nodeId: 'worker' } }, 'remote'],
  ] as const)('excludes machine session %j', (overrides, reason) => {
    const session = { ...main, ...overrides } as MainChatSessionScope;
    expect(isMainChatSession(session)).toBe(false);
    expect(mainChatSessionSkipReason(session)).toBe(reason);
  });

  it('lets callers exclude an active loop while creation without a loop remains a main chat', () => {
    expect(mainChatSessionSkipReason(main, true)).toBe('active-loop');
    expect(isMainChatSession(main, true)).toBe(false);
    expect(isMainChatSession(main, false)).toBe(true);
  });
});
