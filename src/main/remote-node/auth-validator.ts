import * as crypto from 'crypto';
import { getRemoteNodeConfig } from './remote-node-config';
import type { NodeIdentity } from '../../shared/types/worker-node.types';

/** Auth tokens are 64-character hex strings (32 bytes of entropy). */
export const AUTH_TOKEN_LENGTH = 64;

/**
 * Generate a cryptographically secure auth token.
 * Call this once when the user enables remote nodes for the first time.
 */
export function generateAuthToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Validate an incoming token against the configured auth token.
 * Uses timing-safe comparison to prevent timing attacks.
 * Returns false if no authToken is configured (security-by-default).
 */
export function validateAuthToken(token: string | undefined | null): boolean {
  const expected = getRemoteNodeConfig().authToken;
  if (!expected || !token) return false;

  // Timing-safe comparison requires equal-length buffers
  const expectedBuf = Buffer.from(expected, 'utf-8');
  const tokenBuf = Buffer.from(token, 'utf-8');

  if (expectedBuf.length !== tokenBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, tokenBuf);
}

/** Timing-safe string comparison. Returns false when lengths differ. */
function safeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf-8');
  const bBuf = Buffer.from(b, 'utf-8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export type AuthResult =
  | { type: 'registered'; nodeId: string }
  | { type: 'enrollment' }
  | { type: 'rejected' };

/**
 * Two-tier token validation:
 * 1. Check against registered node tokens first (returns nodeId)
 * 2. Check against enrollment token (for new node registration)
 * 3. Reject if neither matches
 */
export function validateTokenTwoTier(
  token: string | undefined | null,
  enrollmentToken: string,
  registeredNodes: Record<string, NodeIdentity>,
): AuthResult {
  if (!token || token.length === 0) {
    return { type: 'rejected' };
  }

  // Check registered node tokens first (priority)
  for (const [nodeId, identity] of Object.entries(registeredNodes)) {
    if (safeCompare(token, identity.token)) {
      return { type: 'registered', nodeId };
    }
  }

  // Check enrollment token
  if (safeCompare(token, enrollmentToken)) {
    return { type: 'enrollment' };
  }

  return { type: 'rejected' };
}

export function ensureEnrollmentToken(currentToken: string): string {
  if (currentToken && currentToken.length > 0) return currentToken;
  return generateAuthToken();
}

/**
 * Ensure the config has an auth token. Generates one if missing.
 * Returns the (possibly newly generated) token.
 */
export function ensureAuthToken(): string {
  const config = getRemoteNodeConfig();
  if (config.authToken) return config.authToken;

  const token = generateAuthToken();
  const { updateRemoteNodeConfig } = require('./remote-node-config') as typeof import('./remote-node-config');
  updateRemoteNodeConfig({ authToken: token });
  return token;
}
