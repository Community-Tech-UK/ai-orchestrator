import { describe, expect, it } from 'vitest';
import {
  SessionSentinel,
  evaluateSessionState,
  type PageSessionSignal,
  type SessionFingerprint,
} from './browser-session-sentinel';

const fingerprint: SessionFingerprint = {
  loggedInMarkers: ['Sign out', 'My account'],
  loginUrl: 'https://portal.example.gov.uk/login',
};

function signal(overrides: Partial<PageSessionSignal>): PageSessionSignal {
  return { url: 'https://portal.example.gov.uk/dashboard', hasPasswordField: false, presentTexts: [], ...overrides };
}

describe('evaluateSessionState', () => {
  it('treats a visible password field as logged out (strongest signal)', () => {
    expect(
      evaluateSessionState(signal({ hasPasswordField: true }), fingerprint),
    ).toMatchObject({ state: 'logged_out', reason: 'password_field_present' });
  });

  it('treats a login-shaped URL as logged out', () => {
    expect(
      evaluateSessionState(signal({ url: 'https://portal.example.gov.uk/sign-in' })),
    ).toMatchObject({ state: 'logged_out', reason: 'login_url' });
  });

  it('is logged in when all fingerprint markers are present', () => {
    expect(
      evaluateSessionState(
        signal({ presentTexts: ['Welcome', 'Sign out', 'My Account'] }),
        fingerprint,
      ),
    ).toMatchObject({ state: 'logged_in', reason: 'fingerprint_matched' });
  });

  it('is logged out when fingerprint markers are missing', () => {
    expect(
      evaluateSessionState(signal({ presentTexts: ['Welcome'] }), fingerprint),
    ).toMatchObject({ state: 'logged_out', reason: 'fingerprint_markers_missing' });
  });

  it('is unknown without a fingerprint on a non-login page', () => {
    expect(evaluateSessionState(signal({ presentTexts: ['Welcome'] }))).toMatchObject({
      state: 'unknown',
    });
  });
});

describe('SessionSentinel', () => {
  it('remembers a fingerprint per profile+origin and evaluates against it', () => {
    const sentinel = new SessionSentinel();
    sentinel.remember('profile-1', 'https://portal.example.gov.uk', fingerprint);

    expect(
      sentinel.evaluate('profile-1', 'https://portal.example.gov.uk', signal({ presentTexts: ['sign out', 'my account'] }))
        .state,
    ).toBe('logged_in');
    // A different origin has no fingerprint → unknown.
    expect(
      sentinel.evaluate('profile-1', 'https://other.example', signal({ presentTexts: [] })).state,
    ).toBe('unknown');
  });

  it('plans a re-login when logged out with a known fingerprint', () => {
    const sentinel = new SessionSentinel();
    sentinel.remember('profile-1', 'https://portal.example.gov.uk', fingerprint);

    const plan = sentinel.planRelogin(
      'profile-1',
      'https://portal.example.gov.uk',
      signal({ hasPasswordField: true }),
      3,
    );
    expect(plan).toEqual({ loginUrl: 'https://portal.example.gov.uk/login', maxAttempts: 3 });
  });

  it('returns no plan (escalate instead) when logged out but no fingerprint is known', () => {
    const sentinel = new SessionSentinel();
    expect(
      sentinel.planRelogin('profile-1', 'https://portal.example.gov.uk', signal({ hasPasswordField: true })),
    ).toBeNull();
  });

  it('returns no plan when the session looks healthy', () => {
    const sentinel = new SessionSentinel();
    sentinel.remember('profile-1', 'https://portal.example.gov.uk', fingerprint);
    expect(
      sentinel.planRelogin(
        'profile-1',
        'https://portal.example.gov.uk',
        signal({ presentTexts: ['sign out', 'my account'] }),
      ),
    ).toBeNull();
  });
});
