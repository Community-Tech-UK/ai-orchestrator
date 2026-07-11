import { describe, expect, it, vi } from 'vitest';
import { handleLocalReviewerQualification } from './local-reviewer-qualification-handler';
import type { IpcMainInvokeEvent } from 'electron';

const EVENT = {} as IpcMainInvokeEvent;
const authorize = vi.fn(() => null);

describe('handleLocalReviewerQualification', () => {
  it('validates and forwards an exact selector to the bounded controller', async () => {
    const qualify = vi.fn().mockResolvedValue({ status: 'verified' });

    await expect(handleLocalReviewerQualification(EVENT, {
      selectorId: 'lm://this-device/ollama/ollama/qwen',
      ipcAuthToken: 'token',
    }, { qualify }, authorize)).resolves.toEqual({
      success: true,
      data: { status: 'verified' },
    });
    expect(qualify).toHaveBeenCalledWith('lm://this-device/ollama/ollama/qwen');
  });

  it('rejects malformed payloads without starting a probe', async () => {
    const qualify = vi.fn();

    const result = await handleLocalReviewerQualification(
      EVENT,
      { selectorId: 'qwen', ipcAuthToken: 'token' },
      { qualify },
      authorize,
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: 'MODELS_LOCAL_REVIEWER_QUALIFY_FAILED' },
    });
    expect(qualify).not.toHaveBeenCalled();
  });

  it('returns authorization failures before validation or probing', async () => {
    const qualify = vi.fn();
    const authFailure = {
      success: false as const,
      error: { code: 'IPC_AUTH_FAILED', message: 'unauthorized', timestamp: 1 },
    };
    const ensureAuthorized = vi.fn(() => authFailure);

    await expect(handleLocalReviewerQualification(
      EVENT,
      { selectorId: 'lm://this-device/ollama/ollama/qwen' },
      { qualify },
      ensureAuthorized,
    )).resolves.toEqual(authFailure);
    expect(qualify).not.toHaveBeenCalled();
  });
});
