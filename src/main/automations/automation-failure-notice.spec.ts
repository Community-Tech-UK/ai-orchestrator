import { describe, expect, it, vi } from 'vitest';

const notify = vi.hoisted(() => vi.fn());
vi.mock('../notifications/notification-service', () => ({ getNotificationService: () => ({ notify }) }));
import { notifyAutomationDisabled } from './automation-runner-terminal';

describe('automation breaker notice', () => {
  it('explains failure plainly without embedding the stored diagnostic in the notification', () => {
    notifyAutomationDisabled('automation', 3, 'Instance entered error');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Automation paused after repeated failures',
      body: expect.stringContaining('The session failed.'),
      urgency: 'critical',
    }));
    expect(notify.mock.calls[0][0].body).not.toContain('Instance entered');
  });
});
