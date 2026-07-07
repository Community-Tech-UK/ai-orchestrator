import { describe, expect, it } from 'vitest';
import { isRestorableUrl, parseSavedRoute } from './resume-route';

const NOW = 1_700_000_000_000;

describe('isRestorableUrl', () => {
  it('restores session and history screens', () => {
    expect(isRestorableUrl('/projects')).toBe(true);
    expect(isRestorableUrl('/projects/%2FUsers%2Fme%2Frepo/sessions/inst-1')).toBe(true);
    expect(isRestorableUrl('/history/chat-9')).toBe(true);
  });

  it('never restores onboarding or compose screens', () => {
    expect(isRestorableUrl('/')).toBe(false);
    expect(isRestorableUrl('/add-host')).toBe(false);
    expect(isRestorableUrl('/new-session')).toBe(false);
  });
});

describe('parseSavedRoute', () => {
  it('round-trips a fresh saved route', () => {
    const value = JSON.stringify({ url: '/projects/key/sessions/inst-1', at: NOW - 60_000 });
    expect(parseSavedRoute(value, NOW)).toEqual({
      url: '/projects/key/sessions/inst-1',
      at: NOW - 60_000,
    });
  });

  it('rejects stale routes past the 24h window', () => {
    const value = JSON.stringify({ url: '/projects', at: NOW - 25 * 60 * 60 * 1000 });
    expect(parseSavedRoute(value, NOW)).toBeNull();
  });

  it('rejects missing, malformed and non-restorable payloads', () => {
    expect(parseSavedRoute(null, NOW)).toBeNull();
    expect(parseSavedRoute('not json', NOW)).toBeNull();
    expect(parseSavedRoute(JSON.stringify({ url: 42, at: NOW }), NOW)).toBeNull();
    expect(parseSavedRoute(JSON.stringify({ url: '/add-host', at: NOW }), NOW)).toBeNull();
  });
});
