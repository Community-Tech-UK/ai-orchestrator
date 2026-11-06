import { describe, expect, it } from 'vitest';
import {
  classifyPermissionRisk,
  describeApprovalScope,
  formatDetails,
  formatRemaining,
} from './pending-approvals-banner.rules';

describe('classifyPermissionRisk', () => {
  it('marks a public app store release as critical', () => {
    expect(classifyPermissionRisk('store_release_mutation')).toEqual({
      label: 'Public app store release',
      tier: 'critical',
    });
  });

  it('marks the Computer Use desktop grant as warning, not critical', () => {
    expect(classifyPermissionRisk('desktop_computer_use_grant').tier).toBe('warning');
  });

  it('labels Microsoft 365 account additions and changes plainly, as warnings', () => {
    expect(classifyPermissionRisk('microsoft365_add_account')).toEqual({ label: 'Add a Microsoft 365 account', tier: 'warning' });
    expect(classifyPermissionRisk('microsoft365_mutation')).toEqual({ label: 'Microsoft 365 change', tier: 'warning' });
  });

  it('falls back to a humanized label and info tier for unknown actions', () => {
    expect(classifyPermissionRisk('some_future_action')).toEqual({
      label: 'some future action',
      tier: 'info',
    });
  });
});

describe('formatRemaining', () => {
  it('renders sub-minute windows as seconds', () => {
    expect(formatRemaining(10_000, 5_000)).toBe('5s left');
  });

  it('renders minute-plus windows as m/s', () => {
    expect(formatRemaining(185_000, 0)).toBe('3m 05s left');
  });

  it('renders "expiring…" once the deadline has passed', () => {
    expect(formatRemaining(1_000, 5_000)).toBe('expiring…');
  });
});

describe('describeApprovalScope', () => {
  it.each(['store_release_mutation', 'calendar_mutation', 'calendar_account_connect'])(
    '%s covers exactly one operation, because every one asks again',
    (action) => {
      expect(describeApprovalScope({ action })).toEqual({
        allowLabel: 'Allow this once',
        lasts: 'Lasts just this once.',
      });
    },
  );

  it('names a session Computer Use grant as this session, with the one-hour limit', () => {
    expect(describeApprovalScope({ action: 'desktop_computer_use_grant', details: { duration: 'session' } })).toEqual({
      allowLabel: 'Allow for this session',
      lasts: 'Lasts until this session ends, and no longer than an hour.',
    });
  });

  it('names a timed Computer Use grant by its minutes, in this session only', () => {
    expect(describeApprovalScope({
      action: 'desktop_computer_use_grant',
      details: { duration: 'boundedMinutes', minutes: 30 },
    })).toEqual({
      allowLabel: 'Allow for 30 minutes',
      lasts: 'Lasts for 30 minutes, in this session only.',
    });
    expect(describeApprovalScope({
      action: 'desktop_computer_use_grant',
      details: { duration: 'boundedMinutes', minutes: 1 },
    })?.allowLabel).toBe('Allow for 1 minute');
  });

  it('warns that an until-revoked Computer Use grant applies in every session', () => {
    expect(describeApprovalScope({ action: 'desktop_computer_use_grant', details: { duration: 'untilRevoked' } })).toEqual({
      allowLabel: 'Always allow',
      lasts: 'Lasts until you take it back, in every session.',
    });
  });

  it.each([
    [{ action: 'desktop_computer_use_grant' }],
    [{ action: 'desktop_computer_use_grant', details: { duration: 'forever' } }],
    [{ action: 'desktop_computer_use_grant', details: { duration: 'boundedMinutes' } }],
    [{ action: 'desktop_computer_use_grant', details: { duration: 'boundedMinutes', minutes: -5 } }],
    [{ action: 'some_future_action' }],
  ])('makes no promise about how long %j lasts', (item) => {
    expect(describeApprovalScope(item)).toBeNull();
  });
});

describe('formatDetails', () => {
  it('joins entries as key: value pairs and skips empty values', () => {
    expect(formatDetails({ appId: 'com.apple.calculator', capability: 'observe', reason: '' }))
      .toBe('appId: com.apple.calculator · capability: observe');
  });

  it('returns an empty string when there are no details', () => {
    expect(formatDetails(undefined)).toBe('');
  });
});
