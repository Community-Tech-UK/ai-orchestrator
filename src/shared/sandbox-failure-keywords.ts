/** Provider auth errors that a hardened CLI may report when credential refresh fails. */
const CREDENTIAL_FAILURE_KEYWORDS = [
  'not logged in',
  'please run /login',
  'oauth access token',
  'invalid_grant',
  'failed to refresh',
  'authentication failed',
  'failed to authenticate',
];

export function isSandboxCredentialFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  return CREDENTIAL_FAILURE_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

const FILE_DENIAL_KEYWORDS = [
  'operation not permitted',
  'permission denied',
  'read-only file system',
  'sandbox',
  'deny(1)',
  'failed to write file',
];

export function isSandboxFileDenial(output: string): boolean {
  const normalized = output.toLowerCase();
  return FILE_DENIAL_KEYWORDS.some((keyword) => normalized.includes(keyword));
}
