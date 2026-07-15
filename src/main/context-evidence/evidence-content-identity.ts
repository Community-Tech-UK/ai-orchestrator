import { timingSafeEqual } from 'node:crypto';

const KEYED_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

/** Constant-time comparison for keyed evidence content identities. */
export function evidenceContentIdentityMatches(actual: string, expected: string): boolean {
  const actualValid = KEYED_DIGEST_PATTERN.test(actual);
  const expectedValid = KEYED_DIGEST_PATTERN.test(expected);
  const actualBytes = actualValid ? Buffer.from(actual, 'hex') : Buffer.alloc(32);
  const expectedBytes = expectedValid ? Buffer.from(expected, 'hex') : Buffer.alloc(32);
  return timingSafeEqual(actualBytes, expectedBytes) && actualValid && expectedValid;
}
