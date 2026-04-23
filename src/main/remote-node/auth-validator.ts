import * as crypto from 'crypto';
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
