import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { LspFeedbackDeps } from './lsp-feedback-coordinator';
import type { AdmissionOutcome } from '../session/session-admission-service';

const coordinatorMocks = vi.hoisted(() => ({
  attach: vi.fn(),
  dispose: vi.fn(),
  capturedDeps: null as LspFeedbackDeps | null,
}));

vi.mock('./lsp-feedback-coordinator', () => ({
  LspFeedbackCoordinator: vi.fn().mockImplementation((deps: LspFeedbackDeps) => {
    coordinatorMocks.capturedDeps = deps;
    return {
      attach: coordinatorMocks.attach,
      dispose: coordinatorMocks.dispose,
      forgetInstance: vi.fn(),
    };
  }),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock('../workspace/lsp-manager', () => ({
  getLspManager: () => ({
    getDiagnostics: vi.fn().mockResolvedValue(null),
  }),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const admissionMocks = vi.hoisted(() => ({
  admitAutomatedWrite: vi.fn<() => AdmissionOutcome>(() => ({ kind: 'admitted', admissionId: 'adm-default' })),
  markDelivered: vi.fn(),
  markFailed: vi.fn(),
  registerRedeliveryHandler: vi.fn(),
}));

vi.mock('../session/session-admission-service', () => ({
  getSessionAdmissionService: () => admissionMocks,
}));

import { registerLspFeedback, _disposeLspFeedbackForTesting } from './lsp-feedback-registration';

describe('registerLspFeedback — injectFeedback admission gating (A5)', () => {
  let sendInput: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    admissionMocks.admitAutomatedWrite.mockReset();
    admissionMocks.admitAutomatedWrite.mockReturnValue({ kind: 'admitted', admissionId: 'adm-default' });
    admissionMocks.markDelivered.mockClear();
    admissionMocks.markFailed.mockClear();
    sendInput = vi.fn().mockResolvedValue(undefined);
    _disposeLspFeedbackForTesting();
    registerLspFeedback({
      instanceManager: {
        getInstance: vi.fn(() => ({ status: 'idle' })),
        sendInput,
      },
    });
  });

  it('sends the feedback note and marks delivered when admission admits', async () => {
    const deps = coordinatorMocks.capturedDeps!;
    await deps.injectFeedback('inst-1', 'Fix this error');

    expect(admissionMocks.admitAutomatedWrite).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      origin: 'lsp-feedback',
      message: 'Fix this error',
    });
    expect(sendInput).toHaveBeenCalledWith('inst-1', 'Fix this error', undefined, { autoContinuation: true });
    expect(admissionMocks.markDelivered).toHaveBeenCalledWith('adm-default');
  });

  it('does not send when admission suppresses the write, and drops it (no redelivery handler)', async () => {
    admissionMocks.admitAutomatedWrite.mockReturnValue({
      kind: 'suppressed',
      reason: 'interrupting',
      admissionId: 'adm-blocked',
    });

    const deps = coordinatorMocks.capturedDeps!;
    await deps.injectFeedback('inst-1', 'Fix this error');

    expect(sendInput).not.toHaveBeenCalled();
    expect(admissionMocks.markDelivered).not.toHaveBeenCalled();
    expect(admissionMocks.registerRedeliveryHandler).not.toHaveBeenCalledWith('lsp-feedback', expect.anything());
  });

  it('marks failed and rethrows when the send itself fails', async () => {
    sendInput.mockRejectedValueOnce(new Error('adapter gone'));
    const deps = coordinatorMocks.capturedDeps!;

    await expect(deps.injectFeedback('inst-1', 'Fix this error')).rejects.toThrow('adapter gone');
    expect(admissionMocks.markFailed).toHaveBeenCalledWith('adm-default', 'adapter gone');
  });
});
