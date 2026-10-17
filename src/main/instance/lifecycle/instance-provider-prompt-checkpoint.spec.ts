import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getManager: vi.fn(), prepare: vi.fn() }));
vi.mock('../../session/session-continuity', () => ({ getSessionContinuityManager: mocks.getManager }));
import { createProviderPromptCheckpoint } from './instance-provider-prompt-checkpoint';

beforeEach(() => { vi.clearAllMocks(); mocks.prepare.mockResolvedValue(undefined); mocks.getManager.mockReturnValue({ prepareForProviderTurn: mocks.prepare }); });
describe('main instance provider prompt checkpoint', () => {
  it('resolves the manager only when input is sent and uses the main instance identity', async () => {
    const beforeProviderPrompt = createProviderPromptCheckpoint('main-placeholder');
    expect(mocks.getManager).not.toHaveBeenCalled();
    await beforeProviderPrompt();
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith('main-placeholder');
  });
  it('propagates failure so the adapter cannot dispatch provider input', async () => {
    const failure = new Error('placeholder persistence failure');
    mocks.prepare.mockRejectedValue(failure);
    await expect(createProviderPromptCheckpoint('main-placeholder')()).rejects.toBe(failure);
  });
});
