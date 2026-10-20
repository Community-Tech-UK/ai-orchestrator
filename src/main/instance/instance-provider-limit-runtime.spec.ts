import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';

const handler = vi.hoisted(() => ({
  maybePark: vi.fn(() => 'switching-account' as string),
  holdAutomatedTurn: vi.fn(() => false),
}));
vi.mock('./instance-provider-limit-handler', () => ({ getInstanceProviderLimitHandler: () => handler }));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createCodexUsageLimitError } from '../cli/adapters/codex/app-server-runtime-errors';
import { holdQueuedOrchestrationResponse, holdRejectedOrchestrationResponse } from './instance-provider-limit-runtime';

const parent = { id: 'parent-1', provider: 'codex', currentModel: 'gpt-6.1-sol', accountProfileId: 'comtech' } as unknown as Instance;

beforeEach(() => {
  handler.maybePark.mockReset().mockReturnValue('switching-account');
  handler.holdAutomatedTurn.mockReset().mockReturnValue(false);
});

describe('holdRejectedOrchestrationResponse', () => {
  it('hands a usage-limit refusal to the park/switch funnel with nothing to re-send', () => {
    const refusal = createCodexUsageLimitError(
      'You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 25th, 2026 1:51 AM. - [codex_error_info: usageLimitExceeded]',
    );
    expect(holdRejectedOrchestrationResponse(parent, {}, refusal)).toBe(true);
    expect(handler.maybePark).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'parent-1', provider: 'codex', resumePrompt: null, accountProfileId: 'comtech',
    }));
  });

  it('holds a refusal the funnel would not park (automatic resume off) on the limit it recorded', () => {
    handler.maybePark.mockReturnValue('skipped');
    handler.holdAutomatedTurn.mockReturnValue(true);
    expect(holdRejectedOrchestrationResponse(parent, {}, createCodexUsageLimitError('usage limit reached'))).toBe(true);
    expect(handler.holdAutomatedTurn).toHaveBeenCalledWith('parent-1');
  });

  it('does not hold a refusal when nothing owns the limit', () => {
    handler.maybePark.mockReturnValue('skipped');
    expect(holdRejectedOrchestrationResponse(parent, {}, createCodexUsageLimitError('usage limit reached'))).toBe(false);
  });

  it('holds any other failure only while a switch, park or known limit owns the session', () => {
    const replaced = new Error('Instance adapter changed before orchestration response delivery');
    expect(holdRejectedOrchestrationResponse(parent, {}, replaced)).toBe(false);
    handler.holdAutomatedTurn.mockReturnValue(true);
    expect(holdRejectedOrchestrationResponse(parent, {}, replaced)).toBe(true);
    expect(handler.maybePark).not.toHaveBeenCalled();
  });

  it('fails the response, rather than throwing past its delivery confirmation, when the limit check throws', () => {
    handler.maybePark.mockImplementation(() => { throw new Error('ledger unreadable'); });
    expect(holdRejectedOrchestrationResponse(parent, {}, createCodexUsageLimitError('usage limit reached'))).toBe(false);
  });

  it('never holds for an instance that is gone', () => {
    expect(holdRejectedOrchestrationResponse(undefined, {}, new Error('usage limit'))).toBe(false);
  });
});

describe('holdQueuedOrchestrationResponse', () => {
  it('holds while the handler says the session is limited, parked or switching', () => {
    handler.holdAutomatedTurn.mockReturnValue(true);
    expect(holdQueuedOrchestrationResponse('parent-1')).toBe(true);
    expect(handler.holdAutomatedTurn).toHaveBeenCalledWith('parent-1');
  });

  it('fails open when the limit check throws', () => {
    handler.holdAutomatedTurn.mockImplementation(() => { throw new Error('ledger closed'); });
    expect(holdQueuedOrchestrationResponse('parent-1')).toBe(false);
  });
});
