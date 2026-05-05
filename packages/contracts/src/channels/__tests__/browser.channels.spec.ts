import { describe, expect, it } from 'vitest';
import { BROWSER_CHANNELS } from '../browser.channels';
import { IPC_CHANNELS } from '../index';

describe('BROWSER_CHANNELS', () => {
  it('defines the Browser Gateway IPC channels', () => {
    expect(BROWSER_CHANNELS).toEqual({
      BROWSER_LIST_PROFILES: 'browser:list-profiles',
      BROWSER_CREATE_PROFILE: 'browser:create-profile',
      BROWSER_UPDATE_PROFILE: 'browser:update-profile',
      BROWSER_DELETE_PROFILE: 'browser:delete-profile',
      BROWSER_OPEN_PROFILE: 'browser:open-profile',
      BROWSER_CLOSE_PROFILE: 'browser:close-profile',
      BROWSER_LIST_TARGETS: 'browser:list-targets',
      BROWSER_SELECT_TARGET: 'browser:select-target',
      BROWSER_REFRESH_EXISTING_TAB: 'browser:refresh-existing-tab',
      BROWSER_NAVIGATE: 'browser:navigate',
      BROWSER_CLICK: 'browser:click',
      BROWSER_TYPE: 'browser:type',
      BROWSER_FILL_FORM: 'browser:fill-form',
      BROWSER_SELECT: 'browser:select',
      BROWSER_UPLOAD_FILE: 'browser:upload-file',
      BROWSER_REQUEST_GRANT: 'browser:request-grant',
      BROWSER_GET_APPROVAL_STATUS: 'browser:get-approval-status',
      BROWSER_LIST_APPROVAL_REQUESTS: 'browser:list-approval-requests',
      BROWSER_GET_APPROVAL_REQUEST: 'browser:get-approval-request',
      BROWSER_APPROVE_REQUEST: 'browser:approve-request',
      BROWSER_DENY_REQUEST: 'browser:deny-request',
      BROWSER_CREATE_GRANT: 'browser:create-grant',
      BROWSER_LIST_GRANTS: 'browser:list-grants',
      BROWSER_REVOKE_GRANT: 'browser:revoke-grant',
      BROWSER_SNAPSHOT: 'browser:snapshot',
      BROWSER_SCREENSHOT: 'browser:screenshot',
      BROWSER_CONSOLE_MESSAGES: 'browser:console-messages',
      BROWSER_NETWORK_REQUESTS: 'browser:network-requests',
      BROWSER_WAIT_FOR: 'browser:wait-for',
      BROWSER_GET_AUDIT_LOG: 'browser:get-audit-log',
      BROWSER_GET_HEALTH: 'browser:get-health',
      BROWSER_CHANGED: 'browser:changed',
    });
  });

  it('is included in the merged IPC channel map', () => {
    expect(IPC_CHANNELS.BROWSER_LIST_PROFILES).toBe('browser:list-profiles');
    expect(IPC_CHANNELS.BROWSER_CLICK).toBe('browser:click');
    expect(IPC_CHANNELS.BROWSER_REFRESH_EXISTING_TAB).toBe('browser:refresh-existing-tab');
    expect(IPC_CHANNELS.BROWSER_APPROVE_REQUEST).toBe('browser:approve-request');
    expect(IPC_CHANNELS.BROWSER_LIST_GRANTS).toBe('browser:list-grants');
    expect(IPC_CHANNELS.BROWSER_GET_HEALTH).toBe('browser:get-health');
    expect(IPC_CHANNELS.BROWSER_CHANGED).toBe('browser:changed');
  });
});
