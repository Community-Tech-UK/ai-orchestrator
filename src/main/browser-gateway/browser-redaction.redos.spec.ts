import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _setToolOutputDirForTesting } from '../util/tool-output-truncation';
import { boundBrowserText, redactBrowserText } from './browser-redaction';

// The original five-pattern pipeline, kept verbatim as the behavioural
// reference. The first pattern (authorization: whitespace split across two
// adjacent `\s*`) and the third (an unterminated quoted key) backtracked
// quadratically, so redactBrowserText now uses linear equivalents; the fuzz
// tests below prove the two agree on small inputs where the old one is safe.
function legacyRedactBrowserText(value: string): string {
  const REDACTED = '[REDACTED]';
  let redacted = value;
  redacted = redacted.replace(
    /\b(authorization|proxy-authorization)\s*:\s*(?:Bearer|Basic|Digest)?\s*[A-Za-z0-9._~+/=-]+/gi,
    (_match, key: string) => `${key}: ${REDACTED}`,
  );
  redacted = redacted.replace(
    /\b(cookie|set-cookie)\s*:\s*[^\r\n]+/gi,
    (_match, key: string) => `${key}: ${REDACTED}`,
  );
  redacted = redacted.replace(
    /"([^"]*(?:authorization|cookie|set-cookie|token|password|secret|key|session)[^"]*)"\s*:\s*"[^"]*"/gi,
    (_match, key: string) => `"${key}": "${REDACTED}"`,
  );
  redacted = redacted.replace(
    /\b([A-Za-z0-9_-]*(?:authorization|cookie|set-cookie|token|password|secret|key|session)[A-Za-z0-9_-]*)\s*=\s*([^\s&]+)/gi,
    (_match, key: string) => `${key}=${REDACTED}`,
  );
  redacted = redacted.replace(
    /\b([A-Za-z0-9_-]*(?:authorization|cookie|set-cookie|token|password|secret|key|session)[A-Za-z0-9_-]*)\s*:\s*([^\s]+)/gi,
    (_match, key: string) => `${key}: ${REDACTED}`,
  );
  return redacted;
}

/** Small deterministic PRNG (mulberry32) so a failure reproduces from its seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  '"', '"', '"', ' ', ' ', '\n', ':', ':', '=', '&', '-', '_', 'a', 'b', '1',
  'key', 'Key', 'token', 'TOKEN', 'password', 'secret', 'session', 'cookie',
  'set-cookie', 'authorization', 'Authorization', 'Bearer ', 'x', '{', '}', ',', 'é', '.',
];

function randomInput(next: () => number): string {
  const length = 1 + Math.floor(next() * 40);
  let out = '';
  for (let i = 0; i < length; i += 1) out += FRAGMENTS[Math.floor(next() * FRAGMENTS.length)];
  return out;
}

const AUTH_KEYS = [
  'authorization', 'Authorization', 'AUTHORIZATION', 'proxy-authorization', 'Proxy-Authorization',
  'PROXY-AUTHORIZATION', 'x-authorization', 'proxy-', 'authorizations',
];
const AUTH_WS = ['', '', ' ', ' ', '  ', '\t', '\n', '\r\n', ' \n ', '     '];
const AUTH_SCHEMES = ['', '', 'Bearer', 'bearer', 'BEARER', 'Basic', 'basic', 'Digest', 'DIGEST', 'Bearerx', 'Basicbasic', 'Bear', 'Token'];
const AUTH_TOKENS = ['', 'abc', 'a.b-c_d~e+f/g=', 'Bearer', 'x=', '-', '!', '!abc', 'abc!def', '"q"', 'été', 'Digest', 'basic1'];
const AUTH_COLONS = [':', ':', ':', ' :', ': :', '', '='];

function pick<T>(items: readonly T[], next: () => number): T {
  return items[Math.floor(next() * items.length)] as T;
}

/**
 * Authorization-shaped input: one or more `key ws : ws scheme ws token` groups
 * with varied whitespace, case, a missing scheme or token, and unrelated
 * fragments in between, so every branch of the authorization pattern is hit.
 */
function randomAuthorizationInput(next: () => number): string {
  const groups = 1 + Math.floor(next() * 3);
  let out = '';
  for (let g = 0; g < groups; g += 1) {
    if (next() < 0.3) out += pick(FRAGMENTS, next);
    out += pick(AUTH_KEYS, next) + pick(AUTH_WS, next) + pick(AUTH_COLONS, next) + pick(AUTH_WS, next);
    out += pick(AUTH_SCHEMES, next) + pick(AUTH_WS, next) + pick(AUTH_TOKENS, next);
    if (next() < 0.4) out += pick(AUTH_WS, next) + pick(FRAGMENTS, next);
  }
  return out;
}

describe('redactBrowserText stays equivalent to the original patterns', () => {
  it('matches the original on the documented cases', () => {
    const samples = [
      'Authorization: Bearer auth-token\nCookie: sid=123\nX-Api-Key: secret-key\ntoken=abc123 password: hunter2 "sessionId": "sess-1" safe=value',
      '{"a":"b","token":"t1","nested":{"api_key" : "k2","safe":"v"}}',
      '"x":"token":"v"',
      '"no keyword":"value" "Session-Id"   :   "abc"',
      '"key" "key":"v',
      '"password":""',
    ];
    for (const sample of samples) {
      expect(redactBrowserText(sample)).toBe(legacyRedactBrowserText(sample));
    }
  });

  it('matches the original on hyphenated and spaced key forms', () => {
    const samples = [
      'x-api-key=abc123 y_token : def --session-id=zz -key=1 a-b-c=1 my-secret-token:val&token=1&x=2',
      'keys=1 monkey: banana tokens  =  v  &key=v key-=v -=v',
      'Set-Cookie: a=b; Path=/\nauthorization=Bearer abc',
      'safe-name=value other:thing',
    ];
    for (const sample of samples) {
      expect(redactBrowserText(sample)).toBe(legacyRedactBrowserText(sample));
    }
  });

  it('matches the original on 60000 seeded random inputs', () => {
    const next = prng(0x17b);
    for (let i = 0; i < 60_000; i += 1) {
      const input = randomInput(next);
      const expected = legacyRedactBrowserText(input);
      const actual = redactBrowserText(input);
      if (actual !== expected) {
        throw new Error(`diverged on input ${JSON.stringify(input)}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
      }
    }
  });

  it('matches the original on the documented authorization cases', () => {
    const samples = [
      'Authorization: Bearer abc.def',
      'Authorization:Bearer abc',
      'authorization :   basic   dXNlcjpwYXNz== trailing',
      'Proxy-Authorization: Digest   realm',
      'AUTHORIZATION:\t\n  Bearer\n token9',
      // scheme word with nothing after it: the scheme is consumed as the token
      'Authorization: Bearer',
      'Authorization: Bearer   !',
      'Authorization: Bearer   \n',
      'Authorization: Bearerx y',
      // no scheme, no token, or a non-token character
      'Authorization:   !',
      'Authorization:',
      'Authorization:    ',
      'Authorization: !Bearer abc',
      'x-authorization: abc proxy-authorization: def',
      'authorization=Bearer abc',
    ];
    for (const sample of samples) {
      expect(redactBrowserText(sample)).toBe(legacyRedactBrowserText(sample));
    }
  });

  it('matches the original on 80000 seeded authorization-shaped random inputs', () => {
    const next = prng(0xa07);
    let redactedCount = 0;
    const runs = 80_000;
    for (let i = 0; i < runs; i += 1) {
      const input = randomAuthorizationInput(next);
      const expected = legacyRedactBrowserText(input);
      const actual = redactBrowserText(input);
      if (actual !== expected) {
        throw new Error(`diverged on input ${JSON.stringify(input)}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
      }
      if (expected !== input) redactedCount += 1;
    }
    // Guard against a generator that stops producing redactable inputs, which
    // would make the equivalence vacuous.
    expect(redactedCount).toBeGreaterThan(runs / 4);
  });
});

describe('redactBrowserText runs in linear time on adversarial input', () => {
  const SIZE = 400_000;
  // The quadratic patterns cost about 5 s at 100K characters, so tens of
  // seconds at 400K; a linear pass takes single-digit milliseconds. 1,500 ms
  // leaves two orders of magnitude of headroom for a loaded CI host or a
  // parallel test fork while still failing clearly on any quadratic regression.
  const BUDGET_MS = 1_500;

  function timeRedaction(input: string): number {
    const started = performance.now();
    redactBrowserText(input);
    return performance.now() - started;
  }

  it('redacts an unterminated quoted key of repeated keyword words quickly', () => {
    const input = '"' + 'key '.repeat(SIZE / 4);
    expect(timeRedaction(input)).toBeLessThan(BUDGET_MS);
  });

  it('redacts many unterminated quoted keys quickly', () => {
    const input = '"key '.repeat(SIZE / 5);
    expect(timeRedaction(input)).toBeLessThan(BUDGET_MS);
  });

  it('redacts a long hyphenated keyword run with no value quickly (equals and colon forms)', () => {
    expect(timeRedaction('key-'.repeat(SIZE / 4))).toBeLessThan(BUDGET_MS);
    expect(timeRedaction('a-token-'.repeat(SIZE / 8))).toBeLessThan(BUDGET_MS);
    expect(timeRedaction('key-'.repeat(SIZE / 8) + ' '.repeat(SIZE / 2))).toBeLessThan(BUDGET_MS);
  });

  it('redacts an authorization header followed by a long whitespace run quickly', () => {
    expect(timeRedaction('Authorization:' + ' '.repeat(SIZE) + '!')).toBeLessThan(BUDGET_MS);
    expect(timeRedaction('Authorization:' + ' '.repeat(SIZE))).toBeLessThan(BUDGET_MS);
    expect(timeRedaction('proxy-authorization:' + '\t \n'.repeat(SIZE / 3) + '!')).toBeLessThan(BUDGET_MS);
  });

  it('redacts an authorization scheme word followed by a long whitespace run quickly', () => {
    expect(timeRedaction('Authorization: Bearer' + ' '.repeat(SIZE) + '!')).toBeLessThan(BUDGET_MS);
    expect(timeRedaction('Authorization:' + ' '.repeat(SIZE / 2) + 'Basic' + ' '.repeat(SIZE / 2))).toBeLessThan(BUDGET_MS);
    expect(timeRedaction('authorization' + ' '.repeat(SIZE))).toBeLessThan(BUDGET_MS);
  });

  it('redacts many repeated authorization headers quickly', () => {
    expect(timeRedaction('authorization: '.repeat(SIZE / 15))).toBeLessThan(BUDGET_MS);
    expect(timeRedaction('authorization:  !'.repeat(SIZE / 17))).toBeLessThan(BUDGET_MS);
    expect(timeRedaction('proxy-authorization '.repeat(SIZE / 20))).toBeLessThan(BUDGET_MS);
    expect(timeRedaction(('Authorization: Bearer' + ' '.repeat(100) + '!').repeat(SIZE / 122))).toBeLessThan(BUDGET_MS);
  });

  it('redacts cookie headers with long whitespace and newline runs quickly', () => {
    expect(timeRedaction('cookie:' + ' '.repeat(SIZE))).toBeLessThan(BUDGET_MS);
    expect(timeRedaction('cookie: ' + '\n'.repeat(SIZE))).toBeLessThan(BUDGET_MS);
    expect(timeRedaction('set-cookie:' + ' \n'.repeat(SIZE / 2))).toBeLessThan(BUDGET_MS);
    expect(timeRedaction('cookie:\n'.repeat(SIZE / 8))).toBeLessThan(BUDGET_MS);
    expect(timeRedaction(('cookie' + ' '.repeat(50)).repeat(SIZE / 56))).toBeLessThan(BUDGET_MS);
  });

  it('redacts quoted keys with long whitespace around the colon quickly', () => {
    expect(timeRedaction('"key"' + ' '.repeat(SIZE / 2) + ':' + ' '.repeat(SIZE / 2) + 'x')).toBeLessThan(BUDGET_MS);
    expect(timeRedaction('"key": '.repeat(SIZE / 7))).toBeLessThan(BUDGET_MS);
    expect(timeRedaction('"key":"'.repeat(SIZE / 7))).toBeLessThan(BUDGET_MS);
    expect(timeRedaction('"' + 'x'.repeat(SIZE) + 'key')).toBeLessThan(BUDGET_MS);
  });

  it('redacts keyword pairs with long whitespace runs and no value quickly (equals and colon forms)', () => {
    expect(timeRedaction('key=' + ' '.repeat(SIZE) + '&')).toBeLessThan(BUDGET_MS);
    expect(timeRedaction('key:' + ' '.repeat(SIZE))).toBeLessThan(BUDGET_MS);
    expect(timeRedaction('key' + ' '.repeat(SIZE))).toBeLessThan(BUDGET_MS);
    expect(timeRedaction(('key=' + ' '.repeat(100) + '&').repeat(SIZE / 105))).toBeLessThan(BUDGET_MS);
    expect(timeRedaction('a'.repeat(SIZE) + 'key')).toBeLessThan(BUDGET_MS);
    expect(timeRedaction('set-cooki'.repeat(SIZE / 9))).toBeLessThan(BUDGET_MS);
  });

  it('bounds a 1,000,000-character adversarial page quickly (redaction plus truncation)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-redos-bound-'));
    _setToolOutputDirForTesting(dir);
    try {
      for (const page of [
        'Authorization:' + ' '.repeat(1_000_000) + '!',
        '"' + 'key '.repeat(250_000),
        'key-'.repeat(250_000),
        'cookie:' + ' '.repeat(1_000_000),
      ]) {
        const started = performance.now();
        boundBrowserText(page);
        expect(performance.now() - started).toBeLessThan(BUDGET_MS * 2);
      }
    } finally {
      _setToolOutputDirForTesting(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still redacts a sensitive pair that follows a long unterminated prefix', () => {
    const input = '"' + 'key '.repeat(1_000) + '" "token": "abc123"';
    expect(redactBrowserText(input)).toContain('"token": "[REDACTED]"');
    expect(redactBrowserText(input)).not.toContain('abc123');
  });

  it('still redacts an authorization header that follows a long whitespace-only header', () => {
    const input = 'Authorization:' + ' '.repeat(100_000) + '!\nAuthorization: Bearer secret-value';
    expect(redactBrowserText(input)).toContain('Authorization: [REDACTED]');
    expect(redactBrowserText(input)).not.toContain('secret-value');
  });
});
