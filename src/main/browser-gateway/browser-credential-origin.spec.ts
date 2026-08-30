/**
 * The value of this file is the round-trip: every origin the CLI accepts is fed
 * through the REAL authorization matcher and must actually authorize the live
 * URL it was meant to cover. A parser that agrees with itself proves nothing;
 * the defect this guards against is a grant that reports success and can never
 * match, which surfaces hours later as `origin_not_authorized`.
 */
import { describe, expect, it } from 'vitest';
import {
  CredentialAuthorizationService,
  InMemoryCredentialAuthorizationStore,
} from './browser-credential-authorization-store';
import {
  normaliseAuthorizationOrigin,
  normaliseBindableOrigin,
  parseCredentialOrigin,
} from './browser-credential-origin';

const NOW = 1_700_000_000_000;

/** Authorize `raw` through the real service, then ask about `liveUrl`. */
function authorizes(raw: string, liveUrl: string): boolean {
  const service = new CredentialAuthorizationService(
    new InMemoryCredentialAuthorizationStore(),
    () => NOW,
  );
  service.create(
    {
      profileId: 'scope',
      allowedOrigins: [parseCredentialOrigin(raw)],
      purposes: ['login'],
      vaultFolder: 'AIO-Agent',
      expiresAt: NOW + 1000,
    },
    'auth-1',
  );
  return service.check({ profileId: 'scope', origin: liveUrl, purpose: 'login' }).authorized;
}

describe('parseCredentialOrigin: accepted forms actually match at fill time', () => {
  it('matches an exact origin and refuses its subdomains', () => {
    expect(authorizes('https://procontract.due-north.com', 'https://procontract.due-north.com/rfx'))
      .toBe(true);
    expect(authorizes('https://due-north.com', 'https://portal.due-north.com/')).toBe(false);
  });

  it('matches subdomains under a wildcard', () => {
    expect(authorizes('https://*.due-north.com', 'https://procontract.due-north.com/x')).toBe(true);
    expect(authorizes('https://*.due-north.com', 'https://due-north.com/x')).toBe(true);
    expect(authorizes('https://*.due-north.com', 'https://due-north.com.evil.test/x')).toBe(false);
  });

  it('normalises case so an upper-case host still matches', () => {
    expect(authorizes('https://ProContract.Due-North.com', 'https://procontract.due-north.com/'))
      .toBe(true);
  });

  it('punycodes an international host so it matches the live URL', () => {
    // Stored as the raw unicode form this could never match, because the
    // browser reports `new URL(...).host` in punycode.
    expect(parseCredentialOrigin('https://exämple.com').hostPattern).toBe('xn--exmple-cua.com');
    expect(authorizes('https://exämple.com', 'https://exämple.com/login')).toBe(true);
  });

  it('drops a trailing dot rather than storing a host that never matches', () => {
    expect(parseCredentialOrigin('https://example.gov.uk.').hostPattern).toBe('example.gov.uk');
    expect(authorizes('https://example.gov.uk.', 'https://example.gov.uk/')).toBe(true);
  });

  it('keeps http distinct from https', () => {
    expect(authorizes('https://a.example.com', 'http://a.example.com/')).toBe(false);
    expect(authorizes('http://a.example.com', 'http://a.example.com/')).toBe(true);
  });
});

describe('parseCredentialOrigin: refusals', () => {
  it('refuses a wildcard over a public suffix', () => {
    // The dangerous case. Under a naive rule `*.com` is a login grant over most
    // of the web, and `*.uk` would cover hmrc.gov.uk.
    expect(() => parseCredentialOrigin('https://*.com')).toThrow(/public suffix/);
    expect(() => parseCredentialOrigin('https://*.uk')).toThrow(/public suffix/);
    expect(() => parseCredentialOrigin('https://*.co.uk')).toThrow(/public suffix/);
    expect(() => parseCredentialOrigin('https://*.gov.uk')).toThrow(/public suffix/);
  });

  it('allows a wildcard over a real organisation domain and below it', () => {
    expect(parseCredentialOrigin('https://*.due-north.com')).toMatchObject({
      hostPattern: 'due-north.com',
      includeSubdomains: true,
    });
    expect(parseCredentialOrigin('https://*.dev.due-north.com')).toMatchObject({
      hostPattern: 'dev.due-north.com',
      includeSubdomains: true,
    });
  });

  it('refuses embedded credentials', () => {
    expect(() => parseCredentialOrigin('https://user@evil.test')).toThrow(/credentials/);
  });

  it('keeps a non-default port, because a ported origin authorizes correctly', () => {
    // Corrected 2026-08-29: an earlier version refused ports on the false
    // premise that they could never be authorized. `originMatches` compares
    // hostPattern against `new URL(pageUrl).host`, which includes a non-default
    // port, so refusing them removed a working capability outright.
    expect(parseCredentialOrigin('https://portal.example.gov.uk:8443')).toMatchObject({
      hostPattern: 'portal.example.gov.uk:8443',
    });
    expect(authorizes('https://portal.example.gov.uk:8443', 'https://portal.example.gov.uk:8443/x'))
      .toBe(true);
    expect(authorizes('https://portal.example.gov.uk:8443', 'https://portal.example.gov.uk/x'))
      .toBe(false);
  });

  it('drops only the scheme default port, under the right scheme', () => {
    // Parsing under a hardcoded https:// applied the wrong default-port rule and
    // silently rebound http://host:443 to http://host.
    expect(parseCredentialOrigin('https://a.example.com:443').hostPattern).toBe('a.example.com');
    expect(parseCredentialOrigin('http://a.example.com:80').hostPattern).toBe('a.example.com');
    expect(parseCredentialOrigin('http://a.example.com:443').hostPattern).toBe('a.example.com:443');
    expect(parseCredentialOrigin('https://a.example.com:80').hostPattern).toBe('a.example.com:80');
  });

  it('drops a path, query or fragment rather than refusing the paste', () => {
    // Changed deliberately: refusing these regressed the panel, which accepted a
    // pasted address-bar URL and produced a working binding because the vault's
    // own normalisation strips them.
    for (const raw of [
      'https://a.example.com/login',
      'https://a.example.com?x=1',
      'https://a.example.com#f',
    ]) {
      expect(parseCredentialOrigin(raw), raw).toMatchObject({ hostPattern: 'a.example.com' });
    }
  });

  it('refuses empty labels and a bare host', () => {
    expect(() => parseCredentialOrigin('https://.example.com')).toThrow(/empty label/);
    expect(() => parseCredentialOrigin('https://a..com')).toThrow(/empty label/);
    expect(() => parseCredentialOrigin('a.example.com')).toThrow();
  });

  it('refuses a non-leading wildcard and a non-http scheme', () => {
    expect(() => parseCredentialOrigin('https://por*al.example.com')).toThrow(/wildcard/);
    expect(() => parseCredentialOrigin('ftp://a.example.com')).toThrow();
  });

  it('refuses a doubled wildcard instead of collapsing it', () => {
    // Two strips in sequence (one before URL parsing, one after IDNA mapping)
    // each removed one `*.`, so the non-leading-wildcard guard never saw it and
    // the grant came out WIDER than any reading of the input.
    expect(() => parseCredentialOrigin('https://*.*.example.com')).toThrow(/wildcard/);
  });

  it('refuses port 0, which no browser can reach', () => {
    expect(() => parseCredentialOrigin('https://example.com:0')).toThrow(/never match/);
  });

  it('refuses a wildcard over an IP address', () => {
    expect(() => parseCredentialOrigin('https://*.127.0.0.1')).toThrow();
  });
});

describe('normaliseBindableOrigin', () => {
  it('returns a normalised concrete origin for enrolment', () => {
    expect(normaliseBindableOrigin('https://ProContract.Due-North.com/'))
      .toBe('https://procontract.due-north.com');
  });

  it('refuses a wildcard, because a binding is to one login', () => {
    expect(() => normaliseBindableOrigin('https://*.due-north.com')).toThrow(/wildcard cannot be enrolled/);
  });

  it('keeps a port, so enrol and authorize agree', () => {
    // The vault stores `host:port` too (normalizeOrigin uses url.host), so both
    // sides must keep it or a ported portal can never be completed.
    expect(normaliseBindableOrigin('https://portal.example.gov.uk:8443'))
      .toBe('https://portal.example.gov.uk:8443');
  });
});

describe('normaliseAuthorizationOrigin', () => {
  it('passes an already-normalised origin through unchanged', () => {
    const origin = {
      scheme: 'https' as const,
      hostPattern: 'procontract.due-north.com',
      includeSubdomains: false,
    };
    expect(normaliseAuthorizationOrigin(origin)).toEqual(origin);
  });

  it('normalises rather than rejects the forms the panel has always accepted', () => {
    // The panel's host field applies no normalisation, and the fill-time matcher
    // lowercases and honours a leading '*.' regardless of the checkbox. Rejecting
    // these would break inputs that work today.
    expect(normaliseAuthorizationOrigin({
      scheme: 'https',
      hostPattern: 'ProContract.Due-North.com',
      includeSubdomains: false,
    })).toEqual({
      scheme: 'https',
      hostPattern: 'procontract.due-north.com',
      includeSubdomains: false,
    });

    expect(normaliseAuthorizationOrigin({
      scheme: 'https',
      hostPattern: '*.due-north.com',
      includeSubdomains: false,
    })).toEqual({
      scheme: 'https',
      hostPattern: 'due-north.com',
      includeSubdomains: true,
    });
  });

  it('refuses a backslash, which WHATWG treats as a separator', () => {
    // The slash-only guard let `https:\\host` through and stored the
    // hostPattern `https`, reproducing the exact bug the guard was added for.
    expect(() => normaliseAuthorizationOrigin({
      scheme: 'https', hostPattern: 'https:\\portal.example.com', includeSubdomains: false,
    })).toThrow(/takes a host, not a URL/);
    expect(() => normaliseAuthorizationOrigin({
      scheme: 'https', hostPattern: 'evil.com\\path', includeSubdomains: false,
    })).toThrow(/takes a host, not a URL/);
    expect(() => normaliseAuthorizationOrigin({
      scheme: 'https', hostPattern: 'a.example.com\\@evil.com', includeSubdomains: false,
    })).toThrow(/takes a host, not a URL/);
  });

  it('refuses a URL pasted into the host field', () => {
    // Rendering `https://` + `https://portal.example.com` parsed as scheme plus
    // path and silently stored the hostPattern `https`, which matched
    // `https://https/` and nothing the operator meant.
    expect(() => normaliseAuthorizationOrigin({
      scheme: 'https', hostPattern: 'https://portal.example.com', includeSubdomains: false,
    })).toThrow(/takes a host, not a URL/);
    expect(() => normaliseAuthorizationOrigin({
      scheme: 'https', hostPattern: 'portal.example.com/login', includeSubdomains: false,
    })).toThrow(/takes a host, not a URL/);
    // `?` and `#` were falling through to the shape regex and being silently
    // truncated, contradicting both the docs and this error message.
    expect(() => normaliseAuthorizationOrigin({
      scheme: 'https', hostPattern: 'example.com?x=1', includeSubdomains: false,
    })).toThrow(/takes a host, not a URL/);
    expect(() => normaliseAuthorizationOrigin({
      scheme: 'https', hostPattern: 'example.com#f', includeSubdomains: false,
    })).toThrow(/takes a host, not a URL/);
  });

  it('keeps a ported host that the panel could always create', () => {
    expect(normaliseAuthorizationOrigin({
      scheme: 'https', hostPattern: 'portal.example.gov.uk:8443', includeSubdomains: false,
    })).toMatchObject({ hostPattern: 'portal.example.gov.uk:8443' });
  });

  it('still refuses what is unsafe or unmatchable, including straight over RPC', () => {
    // This is the direct-RPC bypass: a caller that never touches the CLI.
    expect(() => normaliseAuthorizationOrigin({
      scheme: 'https', hostPattern: 'com', includeSubdomains: true,
    })).toThrow(/public suffix/);
    expect(() => normaliseAuthorizationOrigin({
      scheme: 'https', hostPattern: 'user@evil.test', includeSubdomains: false,
    })).toThrow(/credentials/);
    expect(() => normaliseAuthorizationOrigin({
      scheme: 'https', hostPattern: 'example..com', includeSubdomains: false,
    })).toThrow(/empty label/);
  });

  it('never narrows a wildcard the caller asked for', () => {
    expect(normaliseAuthorizationOrigin({
      scheme: 'https', hostPattern: '*.due-north.com', includeSubdomains: true,
    })).toMatchObject({ includeSubdomains: true });
  });
});

describe('guard ordering: Unicode normalisation must not create what the checks look for', () => {
  // IDNA/UTS-46 mapping turns these into the exact characters the shape checks
  // exist to catch. Checking the raw string and trusting it is how a
  // registry-wide wildcard gets past a guard written to stop one.
  it('catches a fullwidth asterisk that becomes a wildcard after mapping', () => {
    expect(() => parseCredentialOrigin('https://\uFF0A.com')).toThrow(/public suffix/);
    expect(() => parseCredentialOrigin('https://\uFF0A.co.uk')).toThrow(/public suffix/);
  });

  it('catches a percent-encoded asterisk', () => {
    expect(() => parseCredentialOrigin('https://%2A.com')).toThrow(/public suffix/);
  });

  it('catches ideographic full stops that become empty labels', () => {
    expect(() => parseCredentialOrigin('https://example\u3002\u3002com')).toThrow(/empty label/);
  });

  it('catches a doubled trailing dot', () => {
    expect(() => parseCredentialOrigin('https://example.com..')).toThrow(/empty label/);
  });

  it('is self-consistent: anything it accepts survives its own re-check', () => {
    // A parser whose own output fails its own assertion is the bug, not the
    // assertion.
    for (const raw of [
      'https://procontract.due-north.com',
      'https://*.due-north.com',
      'https://ProContract.Due-North.com/',
      'https://ex\u00E4mple.com',
      'https://example.gov.uk.',
      'https://*.dev.due-north.com',
      'http://a.example.com',
      'https://portal.example.gov.uk:8443',
    ]) {
      const parsed = parseCredentialOrigin(raw);
      expect(() => normaliseAuthorizationOrigin(parsed), raw).not.toThrow();
      expect(normaliseAuthorizationOrigin(parsed), raw).toEqual(parsed);
    }
  });
});

describe('multi-tenant public suffixes', () => {
  // Structurally identical to *.com: a grant over every tenant of a shared host,
  // including one an attacker can register in minutes.
  it('refuses a wildcard over a private multi-tenant suffix', () => {
    for (const raw of [
      'https://*.github.io',
      'https://*.pages.dev',
      'https://*.vercel.app',
      'https://*.workers.dev',
      'https://*.blogspot.com',
    ]) {
      expect(() => parseCredentialOrigin(raw), raw).toThrow(/public suffix/);
    }
  });

  it('still allows a wildcard over a real organisation domain on such a host', () => {
    expect(parseCredentialOrigin('https://*.myorg.github.io')).toMatchObject({
      hostPattern: 'myorg.github.io',
      includeSubdomains: true,
    });
  });
});

describe('pasted address-bar URLs', () => {
  it('accepts a URL with a path, as the vault binding normalisation already does', () => {
    // Rejecting this regressed the panel: it accepted a pasted URL and the
    // binding worked, because normalizeOrigin strips the path.
    expect(normaliseBindableOrigin('https://portal.example.gov.uk/login'))
      .toBe('https://portal.example.gov.uk');
    expect(parseCredentialOrigin('https://portal.example.gov.uk/login?a=b#c'))
      .toMatchObject({ hostPattern: 'portal.example.gov.uk' });
  });
});
