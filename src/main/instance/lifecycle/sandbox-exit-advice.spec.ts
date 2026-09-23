import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetHardenedModeScopingForTesting, setInstanceHardened } from './hardened-mode-scoping';
import { noteSandboxDenialOnExit } from './sandbox-exit-advice';

const notify = vi.fn();
vi.mock('../../notifications/notification-service', () => ({
  getNotificationService: () => ({ notify }),
}));

describe('noteSandboxDenialOnExit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetHardenedModeScopingForTesting();
    setInstanceHardened('hardened-instance', true);
  });

  it('gives credential repair guidance without suggesting a writable path grant', () => {
    const advice = noteSandboxDenialOnExit('hardened-instance', 1, [{
      id: 'auth-error', timestamp: 1, type: 'error',
      content: 'Failed to authenticate: OAuth session expired and could not be refreshed',
    }]);

    expect(advice).toContain('WITHOUT hardened mode');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringMatching(/credential/i),
      body: expect.stringContaining('without hardened mode'),
    }));
    expect(notify.mock.calls[0][0].body).not.toContain('Allow path & retry');
  });

  it('keeps path-grant guidance for a genuine file denial', () => {
    noteSandboxDenialOnExit('hardened-instance', 1, [{
      id: 'file-error', timestamp: 1, type: 'error',
      content: 'Operation not permitted: /Users/test/Desktop/probe',
    }]);

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('Allow path & retry'),
    }));
  });
});
