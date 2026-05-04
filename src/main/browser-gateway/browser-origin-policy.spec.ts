import { describe, expect, it } from 'vitest';
import type { BrowserAllowedOrigin } from '@contracts/types/browser';
import { isOriginAllowed, normalizeOrigin } from './browser-origin-policy';

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
});
