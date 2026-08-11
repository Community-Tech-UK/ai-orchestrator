import { describe, expect, it } from 'vitest';
import { detectAuthFailureSignal } from './instance-auth-failure-detection';

describe('detectAuthFailureSignal', () => {
  it('detects the Claude OAuth expiry that killed a live session', () => {
    // Verbatim from the transcript this feature was built for.
    const signal = detectAuthFailureSignal(
      'Failed to authenticate: OAuth session expired and could not be refreshed',
    );

    expect(signal).not.toBeNull();
    expect(signal?.reason).toContain('OAuth session expired');
  });

  it.each([
    'Not logged in. Run `codex login` to sign in.',
    'authentication_error: invalid x-api-key',
    'Invalid API key provided',
    'HTTP 401 Unauthorized',
    'Your credentials have expired, please sign in again',
    'Please run `claude auth login` and try again',
  ])('detects provider credential failure: %s', (message) => {
    expect(detectAuthFailureSignal(message)).not.toBeNull();
  });

  it.each([
    'Command failed with exit code 1',
    'Instance abc is in error state and cannot accept input',
    'Process exited unexpectedly with code 143',
    'Request timed out after 30s',
    "You've hit your session limit · resets 6:30pm",
    'ENOENT: no such file or directory',
    '',
    '   ',
  ])('does not misclassify an ordinary failure: %s', (message) => {
    expect(detectAuthFailureSignal(message)).toBeNull();
  });

  it.each([
    'MCP server "linear" failed to authenticate: OAuth session expired',
    'git push failed: invalid credentials for origin',
    'npm ERR! 401 Unauthorized - GET https://registry.npmjs.org/foo',
    'Failed to authenticate with the GitHub API: token expired',
    'ssh: Permission denied (publickey), credentials expired',
  ])('does not claim a provider sign-out for someone else\'s auth error: %s', (message) => {
    // A tool/MCP OAuth failure must not attach a "you are signed out of Claude"
    // banner — the provider session is fine.
    expect(detectAuthFailureSignal(message)).toBeNull();
  });
});

/**
 * WS "in-session auth repair" check 7: *"no false banner from a tool's OAuth
 * error"* — a tool/MCP failure whose message mentions OAuth, while the provider
 * itself is signed in, must not surface the signed-out banner.
 *
 * The doc frames the guarantee as coming from the live auth probe vetoing the
 * match downstream. It is actually enforced one step earlier and more cheaply:
 * `NOT_PROVIDER_AUTH_PATTERNS` excludes `mcp`, `github`, `npm`, `docker`, `git`,
 * `ssh`, `registry` and `database` *before* the auth patterns are consulted, so
 * these never classify as a provider auth failure at all and
 * `onAuthFailureTurn` is never called. Belt and braces, and worth pinning:
 * a regression here would put a "you are signed out" banner in front of a user
 * who is signed in, for someone else's expired token.
 */
describe('detectAuthFailureSignal — third-party OAuth errors (auth-repair check 7)', () => {
  const thirdPartyOauthFailures = [
    'MCP server "notion" failed: OAuth token expired, please re-run login',
    'mcp: authentication error contacting the remote server',
    'GitHub: Bad credentials (401 Unauthorized) — your token has expired',
    'npm ERR! code E401 — Incorrect or missing credentials, please log in',
    'docker: unauthorized: authentication required (401)',
    'git: Invalid credentials for remote origin; please re-run login',
    'ssh: Permission denied (publickey) — expired credentials',
    'registry returned 401 unauthorized: token revoked',
    'database connection failed: invalid credentials',
  ];

  for (const message of thirdPartyOauthFailures) {
    it(`does not flag a provider auth failure for: ${message.slice(0, 44)}…`, () => {
      expect(detectAuthFailureSignal(message)).toBeNull();
    });
  }

  it('still flags a genuine provider auth failure with the same vocabulary', () => {
    // The control: identical wording, no third-party marker. If this ever
    // returns null the exclusions have over-reached and real sign-outs go quiet.
    expect(detectAuthFailureSignal('OAuth token expired, please re-run login')).not.toBeNull();
    expect(detectAuthFailureSignal('Not logged in · Please run /login')).not.toBeNull();
  });
});
