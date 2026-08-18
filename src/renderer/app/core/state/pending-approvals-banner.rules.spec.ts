import { describe, expect, it } from 'vitest';
import { classifyPermissionRisk, formatDetails, formatRemaining } from './pending-approvals-banner.rules';

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

describe('formatDetails', () => {
  it('joins entries as key: value pairs and skips empty values', () => {
    expect(formatDetails({ appId: 'com.apple.calculator', capability: 'observe', reason: '' }))
      .toBe('appId: com.apple.calculator · capability: observe');
  });

  it('returns an empty string when there are no details', () => {
    expect(formatDetails(undefined)).toBe('');
  });
});
