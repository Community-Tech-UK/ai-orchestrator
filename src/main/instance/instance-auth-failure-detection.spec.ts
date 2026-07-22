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
