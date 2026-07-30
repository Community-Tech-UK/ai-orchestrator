import { describe, expect, it } from 'vitest';
import type { BrowserAllowedOrigin } from '@contracts/types/browser';
import {
  allowedOriginCovers,
  allowedOriginsCover,
  isOriginAllowed,
  normalizeOrigin,
} from './browser-origin-policy';

describe('browser-origin-policy', () => {
  it('normalizes URLs to scheme, host, origin, and default ports', () => {
    expect(normalizeOrigin('https://Example.com/path?q=1')).toEqual({
      scheme: 'https',
      host: 'example.com',
      port: 443,
      origin: 'https://example.com',
    });

    expect(normalizeOrigin('http://localhost:4567')).toEqual({
      scheme: 'http',
      host: 'localhost',
      port: 4567,
      origin: 'http://localhost:4567',
    });

    expect(normalizeOrigin('not a url')).toBeNull();
  });

  it('requires exact scheme matches', () => {
    const allowed: BrowserAllowedOrigin[] = [
      {
        scheme: 'https',
        hostPattern: 'example.com',
        includeSubdomains: false,
      },
    ];

    expect(isOriginAllowed('https://example.com', allowed)).toMatchObject({
      allowed: true,
      origin: 'https://example.com',
    });
    expect(isOriginAllowed('http://example.com', allowed)).toMatchObject({
      allowed: false,
      reason: 'scheme_not_allowed',
    });
  });

  it('matches subdomains only when includeSubdomains is true', () => {
    const withoutSubdomains: BrowserAllowedOrigin[] = [
      {
        scheme: 'https',
        hostPattern: 'example.com',
        includeSubdomains: false,
      },
    ];
    const withSubdomains: BrowserAllowedOrigin[] = [
      {
        scheme: 'https',
        hostPattern: 'example.com',
        includeSubdomains: true,
      },
    ];

    expect(isOriginAllowed('https://sub.example.com', withoutSubdomains).allowed).toBe(false);
    expect(isOriginAllowed('https://sub.example.com', withSubdomains).allowed).toBe(true);
    expect(isOriginAllowed('https://badexample.com', withSubdomains).allowed).toBe(false);
  });

  it('requires explicit localhost ports', () => {
    const allowed: BrowserAllowedOrigin[] = [
      {
        scheme: 'http',
        hostPattern: 'localhost',
        port: 4567,
        includeSubdomains: false,
      },
    ];

    expect(isOriginAllowed('http://localhost:4567', allowed).allowed).toBe(true);
    expect(isOriginAllowed('https://localhost:4567', allowed).allowed).toBe(false);
    expect(isOriginAllowed('http://localhost:3000', allowed)).toMatchObject({
      allowed: false,
      reason: 'port_not_allowed',
    });
  });

  it('strips wildcard prefixes from configured host patterns', () => {
    const allowed: BrowserAllowedOrigin[] = [
      {
        scheme: 'https',
        hostPattern: '*.example.com',
        includeSubdomains: true,
      },
    ];

    expect(isOriginAllowed('https://child.example.com', allowed).allowed).toBe(true);
  });
  it('decides whether one allowed origin pattern covers another', () => {
    const host: BrowserAllowedOrigin = {
      scheme: 'https',
      hostPattern: 'etendersni.gov.uk',
      includeSubdomains: false,
    };
    const wildcard: BrowserAllowedOrigin = { ...host, includeSubdomains: true };

    expect(allowedOriginCovers(wildcard, host)).toBe(true);
    expect(allowedOriginCovers(wildcard, wildcard)).toBe(true);
    expect(allowedOriginCovers(host, host)).toBe(true);
    // A host-only grant cannot stand in for a subdomain-wide request.
    expect(allowedOriginCovers(host, wildcard)).toBe(false);
    // Subdomain-inclusive parents cover narrower children, never the reverse.
    expect(allowedOriginCovers(wildcard, {
      scheme: 'https',
      hostPattern: 'epps.etendersni.gov.uk',
      includeSubdomains: false,
    })).toBe(true);
    expect(allowedOriginCovers({
      scheme: 'https',
      hostPattern: 'epps.etendersni.gov.uk',
      includeSubdomains: true,
    }, host)).toBe(false);
    // Scheme and port must match exactly.
    expect(allowedOriginCovers({ ...wildcard, scheme: 'http' }, host)).toBe(false);
    expect(allowedOriginCovers({ ...wildcard, port: 8443 }, host)).toBe(false);
    expect(allowedOriginCovers({ ...wildcard, port: 443 }, host)).toBe(true);
  });

  it('requires every requested origin to be covered and rejects an empty request', () => {
    const allowed: BrowserAllowedOrigin[] = [
      { scheme: 'https', hostPattern: 'etendersni.gov.uk', includeSubdomains: true },
    ];

    expect(allowedOriginsCover(allowed, allowed)).toBe(true);
    expect(allowedOriginsCover(allowed, [])).toBe(false);
    expect(allowedOriginsCover([], allowed)).toBe(false);
    expect(allowedOriginsCover(allowed, [
      ...allowed,
      { scheme: 'https', hostPattern: 'example.com', includeSubdomains: false },
    ])).toBe(false);
  });
});
