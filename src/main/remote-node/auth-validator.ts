import * as crypto from 'crypto';
import { getRemoteNodeConfig } from './remote-node-config';

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
