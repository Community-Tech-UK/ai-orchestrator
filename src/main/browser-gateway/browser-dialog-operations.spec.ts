import { describe, expect, it, vi } from 'vitest';
import { DIALOG_ACCEPT_REASON, classifyHandleDialogAction } from './browser-action-classifier';
import { DIALOG_UNSUPPORTED_MANAGED_REASON } from './browser-dialog-operations';
import { makeGrant, makeService } from './browser-gateway-service.test-helpers';

const fixtureTab = {
  profileId: 'existing-tab:7:42',
  targetId: 'existing-tab:7:42:target',
  tabId: 42,
  windowId: 7,
  title: 'Draft post',
  url: 'https://fixture.test/editor',
  origin: 'https://fixture.test',
  allowedOrigins: [
    { scheme: 'https' as const, hostPattern: 'fixture.test', includeSubdomains: false },
  ],
};

function grantFor(actionClass: string, autonomous = false) {
  return makeGrant({
    profileId: fixtureTab.profileId,
    targetId: fixtureTab.targetId,
    allowedOrigins: fixtureTab.allowedOrigins,
    allowedActionClasses: [actionClass as 'input'],
    autonomous,
  });
}

const context = { instanceId: 'instance-1', provider: 'copilot' as const };

describe('browser.handle_dialog', () => {
  it('dismisses a pop-up under an input grant through the extension', async () => {
    const sendCommand = vi.fn(async () => ({ handled: true, accepted: false, dialogType: 'beforeunload' }));
    const { service } = makeService({
      existingTab: fixtureTab,
      extensionCommandStore: { sendCommand },
      grants: [grantFor('input')],
    });

    const result = await service.handleDialog({
      ...context, profileId: fixtureTab.profileId, targetId: fixtureTab.targetId, accept: false,
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: { handled: true, accepted: false, dialogType: 'beforeunload' },
    });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'handle_dialog',
      payload: { accept: false },
    }));
  });

  it('classifies accepting from the hint, and holds an unexplained accept for the user', () => {
    expect(classifyHandleDialogAction({ accept: false })).toEqual({ actionClass: 'input', hardStop: false });
    expect(classifyHandleDialogAction({ accept: true, actionHint: 'delete the post' }))
      .toMatchObject({ actionClass: 'destructive' });
    for (const actionHint of [undefined, 'leave the page']) {
      expect(classifyHandleDialogAction({ accept: true, ...(actionHint ? { actionHint } : {}) })).toEqual({
        actionClass: 'unknown',
        hardStop: true,
        reason: DIALOG_ACCEPT_REASON,
      });
    }
  });

  it.each([
    ['no hint', undefined],
    ['a destructive hint', 'confirm deleting the post'],
  ])('does not accept a pop-up on an input grant with %s', async (_name, actionHint) => {
    const sendCommand = vi.fn();
    const { service } = makeService({
      existingTab: fixtureTab,
      extensionCommandStore: { sendCommand },
      grants: [grantFor('input')],
    });

    const result = await service.handleDialog({
      ...context, profileId: fixtureTab.profileId, targetId: fixtureTab.targetId,
      accept: true, ...(actionHint ? { actionHint } : {}),
    });

    expect(result.decision).not.toBe('allowed');
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('accepts under a grant for the class the hint classifies to', async () => {
    const actionHint = 'delete the abandoned draft';
    const sendCommand = vi.fn(async () => ({ handled: true, accepted: true, dialogType: 'confirm' }));
    const { service } = makeService({
      existingTab: fixtureTab,
      extensionCommandStore: { sendCommand },
      // Destructive actions need an autonomous grant, as for a click.
      grants: [grantFor('destructive', true)],
    });

    const result = await service.handleDialog({
      ...context, profileId: fixtureTab.profileId, targetId: fixtureTab.targetId, accept: true, actionHint,
    });

    expect(result).toMatchObject({
      outcome: 'succeeded',
      data: { handled: true, accepted: true, dialogType: 'confirm' },
    });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'handle_dialog',
      payload: { accept: true },
    }));
  });

  it('reports a secret-filled tab\'s withheld answer as handled without details', async () => {
    const sendCommand = vi.fn(async () => ({
      completed: true,
      observationBlocked: 'browser_secret_observation_blocked_for_tainted_origin',
    }));
    const { service } = makeService({
      existingTab: fixtureTab,
      extensionCommandStore: { sendCommand },
      grants: [grantFor('input')],
    });

    const result = await service.handleDialog({
      ...context, profileId: fixtureTab.profileId, targetId: fixtureTab.targetId, accept: false,
    });

    expect(result).toMatchObject({ outcome: 'succeeded', data: { handled: true, accepted: false } });
    expect(result.data).not.toHaveProperty('dialogType');
  });

  it('fails when the extension answers for a different choice', async () => {
    const sendCommand = vi.fn(async () => ({ handled: true, accepted: true, dialogType: 'confirm' }));
    const { service } = makeService({
      existingTab: fixtureTab,
      extensionCommandStore: { sendCommand },
      grants: [grantFor('input')],
    });

    const result = await service.handleDialog({
      ...context, profileId: fixtureTab.profileId, targetId: fixtureTab.targetId, accept: false,
    });

    expect(result).toMatchObject({
      outcome: 'failed',
      reason: 'browser_extension_handle_dialog_result_invalid',
    });
  });

  it('passes the extension\'s explanation through when no pop-up was seen', async () => {
    const sendCommand = vi.fn(async () => {
      throw new Error('browser_no_dialog_seen: no pop-up seen by the Browser Gateway is waiting on this tab.');
    });
    const { service } = makeService({
      existingTab: fixtureTab,
      extensionCommandStore: { sendCommand },
      grants: [grantFor('input')],
    });

    const result = await service.handleDialog({
      ...context, profileId: fixtureTab.profileId, targetId: fixtureTab.targetId, accept: false,
    });

    expect(result).toMatchObject({ outcome: 'failed' });
    expect(result.reason).toMatch(/^browser_no_dialog_seen:/);
  });

  it('refuses managed profiles clearly', async () => {
    const sendCommand = vi.fn();
    const { service } = makeService({ extensionCommandStore: { sendCommand } });

    const result = await service.handleDialog({
      ...context, profileId: 'profile-1', targetId: 'target-1', accept: true,
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: DIALOG_UNSUPPORTED_MANAGED_REASON,
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('does not hide a waiting pop-up behind the cached snapshot', async () => {
    const dialogError = 'browser_dialog_open: this tab is showing Chrome\'s "Leave site?" pop-up '
      + '(the page has unsaved changes), so the command was not run.';
    const sendCommand = vi.fn(async () => {
      throw new Error(dialogError);
    });
    const { service } = makeService({
      existingTab: { ...fixtureTab, text: 'Cached draft text' },
      extensionCommandStore: { sendCommand },
    });

    const result = await service.snapshot({
      ...context, profileId: fixtureTab.profileId, targetId: fixtureTab.targetId,
    });

    expect(result).toMatchObject({ outcome: 'failed', reason: dialogError, data: null });
  });
});
