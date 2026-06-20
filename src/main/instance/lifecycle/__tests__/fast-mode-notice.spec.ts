import { describe, it, expect } from 'vitest';
import { isFastModeUnavailableNotice } from '../fast-mode-notice';

describe('isFastModeUnavailableNotice', () => {
  it('matches the known provider "unavailable" notices', () => {
    const notices = [
      'Fast mode requires a paid subscription',
      'Fast mode requires usage credits',
      'Fast mode unavailable: Checking fast mode availability (org status pending)',
      'Fast mode is currently unavailable',
      'Fast mode is not available',
      'Fast mode has been disabled by your organization',
      'Fast mode unavailable due to network connectivity issues',
    ];
    for (const notice of notices) {
      expect(isFastModeUnavailableNotice(notice), notice).toBe(true);
    }
  });

  it('matches when embedded in a larger message', () => {
    expect(
      isFastModeUnavailableNotice('⚠️  Fast mode is currently unavailable — falling back to standard output.'),
    ).toBe(true);
  });

  it('does not match ordinary prose that mentions fast mode', () => {
    const benign = [
      'Fast mode is enabled for this session.',
      'Switched to fast mode.',
      'The model responded quickly in fast mode.',
      'requires careful review', // no "fast mode" at all
      '',
    ];
    for (const text of benign) {
      expect(isFastModeUnavailableNotice(text), text).toBe(false);
    }
  });

  it('handles null/undefined safely', () => {
    expect(isFastModeUnavailableNotice(undefined)).toBe(false);
    expect(isFastModeUnavailableNotice(null)).toBe(false);
  });
});
