import { describe, expect, it } from 'vitest';
import { AllowedHostMatcher } from './allowed-hosts';

describe('AllowedHostMatcher', () => {
  it('allows localhost variants by default', () => {
    const matcher = new AllowedHostMatcher({ allowPrivateRanges: false });

    expect(matcher.isAllowed('localhost')).toBe(true);
    expect(matcher.isAllowed('127.0.0.1')).toBe(true);
    expect(matcher.isAllowed('::1')).toBe(true);
    expect(matcher.isAllowed('[::1]')).toBe(true);
    expect(matcher.isAllowed('0.0.0.0')).toBe(true);
  });

  it('does not allow public hosts by default', () => {
    const matcher = new AllowedHostMatcher({ allowPrivateRanges: false });

    expect(matcher.isAllowed('api.anthropic.com')).toBe(false);
    expect(matcher.isAllowed('1.1.1.1')).toBe(false);
  });

  it('blocks RFC 1918 ranges by default', () => {
    const matcher = new AllowedHostMatcher({ allowPrivateRanges: false });

    expect(matcher.isAllowed('10.1.2.3')).toBe(false);
    expect(matcher.isAllowed('172.16.0.1')).toBe(false);
    expect(matcher.isAllowed('192.168.1.1')).toBe(false);
  });

  it('allows RFC 1918 ranges when opted in', () => {
    const matcher = new AllowedHostMatcher({ allowPrivateRanges: true });

    expect(matcher.isAllowed('10.1.2.3')).toBe(true);
    expect(matcher.isAllowed('172.31.0.1')).toBe(true);
    expect(matcher.isAllowed('192.168.1.1')).toBe(true);
    expect(matcher.isAllowed('api.anthropic.com')).toBe(false);
  });

  it('does not match 172.15 or 172.32 as private', () => {
    const matcher = new AllowedHostMatcher({ allowPrivateRanges: true });

    expect(matcher.isAllowed('172.15.0.1')).toBe(false);
    expect(matcher.isAllowed('172.32.0.1')).toBe(false);
  });

  it('returns false for undefined or empty hostname', () => {
    const matcher = new AllowedHostMatcher({ allowPrivateRanges: false });

    expect(matcher.isAllowed(undefined)).toBe(false);
    expect(matcher.isAllowed('')).toBe(false);
  });

  it('allows configured extra hosts', () => {
    const matcher = new AllowedHostMatcher({
      allowPrivateRanges: false,
      extraAllowedHosts: ['my-worker.local'],
    });

    expect(matcher.isAllowed('my-worker.local')).toBe(true);
    expect(matcher.isAllowed('MY-WORKER.LOCAL')).toBe(true);
  });
});
