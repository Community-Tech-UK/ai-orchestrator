import { describe, expect, it, vi } from 'vitest';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import { postTimeoutMutationProbe } from './browser-existing-tab-timeout-probe';

const PROFILE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function makeAttachment(): BrowserExistingTabAttachment {
  return {
    profileId: `existing-tab:n.node-1:p.${PROFILE}:1:2`,
    targetId: `existing-tab:n.node-1:p.${PROFILE}:1:2:target`,
    tabId: 2,
    windowId: 1,
    nodeId: 'node-1',
    extensionInstanceId: PROFILE,
    url: 'https://example.test/form',
    origin: 'https://example.test',
    allowedOrigins: [],
    attachedAt: 1,
    updatedAt: 1,
  };
}

describe('postTimeoutMutationProbe with a Chrome profile', () => {
  // The probe decides whether a timed-out write landed. Read from another
  // profile, it would judge the wrong tab (or none at all).
  it('reads the control back from the tab\'s own profile', async () => {
    const sendCommand = vi.fn(async () => ({ value: 'typed' }));

    await expect(postTimeoutMutationProbe('type', { selector: '#q', value: 'typed' }, makeAttachment(), sendCommand))
      .resolves.toBe('timed_out_applied');

    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      queueKey: 'node:node-1',
      command: 'read_control',
      target: expect.objectContaining({ tabId: 2, extensionInstanceId: PROFILE }),
    }));
  });

  it('takes the post-timeout snapshot from the tab\'s own profile', async () => {
    const sendCommand = vi.fn(async () => ({ tabId: 2, windowId: 1, url: 'https://example.test/done', title: 'Done' }));

    await postTimeoutMutationProbe('click', { selector: '#save' }, makeAttachment(), sendCommand);

    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'snapshot',
      target: expect.objectContaining({ tabId: 2, extensionInstanceId: PROFILE }),
    }));
  });
});
