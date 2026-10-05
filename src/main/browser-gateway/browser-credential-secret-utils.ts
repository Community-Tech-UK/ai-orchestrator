import { createHash, randomInt } from 'node:crypto';

const PASSWORD_CHARSETS = {
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  lower: 'abcdefghijkmnpqrstuvwxyz',
  digit: '23456789',
  symbol: '!@#$%^&*()-_=+[]',
};

/** Crypto-strong, policy-compliant password (>=1 of each class), length 20. */
export function generateStrongPassword(length = 20): string {
  const all =
    PASSWORD_CHARSETS.upper +
    PASSWORD_CHARSETS.lower +
    PASSWORD_CHARSETS.digit +
    PASSWORD_CHARSETS.symbol;
  const required = [
    pick(PASSWORD_CHARSETS.upper),
    pick(PASSWORD_CHARSETS.lower),
    pick(PASSWORD_CHARSETS.digit),
    pick(PASSWORD_CHARSETS.symbol),
  ];
  const chars = [...required];
  while (chars.length < length) {
    chars.push(pick(all));
  }
  // Fisher–Yates with a CSPRNG so the required chars are not positionally fixed.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join('');
}

function pick(charset: string): string {
  return charset[randomInt(charset.length)] as string;
}

/**
 * Non-reversible digest of a secret, for worker-side fill verification. The
 * broker compares the digest of the vault value with the digest of the value it
 * read back from the page IN-PROCESS; neither plaintext nor this digest is ever
 * returned to the model, logged, or written to audit.
 */
export function secretVerificationDigest(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

/** Both plaintexts stay in-process; only the verification boolean escapes. */
export function verifyFilledSecret(expected: string, readback: string | undefined): boolean {
  if (typeof readback !== 'string' || readback.length === 0) {
    return false;
  }
  return secretVerificationDigest(expected) === secretVerificationDigest(readback);
}

export function originsMatch(a: string, b: string): boolean {
  return normalizeOrigin(a) === normalizeOrigin(b);
}

function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return value.trim().toLowerCase().replace(/\/+$/, '');
  }
}

export function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}
