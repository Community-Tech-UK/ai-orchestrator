import { describe, expect, it } from 'vitest';
import {
  formatHostForUrl,
  formatHostPort,
  isAllInterfacesHost,
  stripIpv4MappedPrefix,
  toListenHost,
} from './host-address';

describe('host-address', () => {
  it('listens on the IPv6 wildcard when the setting is the IPv4 wildcard, and leaves everything else alone', () => {
    expect(toListenHost('0.0.0.0')).toBe('::');
    expect(toListenHost(' 0.0.0.0 ')).toBe('::');
    expect(toListenHost('::')).toBe('::');
    expect(toListenHost('127.0.0.1')).toBe('127.0.0.1');
    expect(toListenHost('192.168.1.5')).toBe('192.168.1.5');
  });

  it('recognises every all-interfaces spelling', () => {
    expect(['0.0.0.0', '::', '[::]'].every(isAllInterfacesHost)).toBe(true);
    expect(isAllInterfacesHost('127.0.0.1')).toBe(false);
  });

  it('strips the IPv4-mapped prefix a dual-stack listener adds', () => {
    expect(stripIpv4MappedPrefix('::ffff:192.168.0.156')).toBe('192.168.0.156');
    expect(stripIpv4MappedPrefix('::FFFF:100.68.10.5')).toBe('100.68.10.5');
    expect(stripIpv4MappedPrefix('fd7a:115c:a1e0::1')).toBe('fd7a:115c:a1e0::1');
    expect(stripIpv4MappedPrefix('192.168.0.156')).toBe('192.168.0.156');
  });

  it('brackets IPv6 hosts in URLs and nothing else', () => {
    expect(formatHostForUrl('fd7a:115c:a1e0::1234')).toBe('[fd7a:115c:a1e0::1234]');
    expect(formatHostForUrl('[fd7a:115c:a1e0::1234]')).toBe('[fd7a:115c:a1e0::1234]');
    expect(formatHostForUrl('192.168.0.156')).toBe('192.168.0.156');
    expect(formatHostForUrl('mac.tail1234.ts.net')).toBe('mac.tail1234.ts.net');
    expect(formatHostPort('fd00::1', 4878)).toBe('[fd00::1]:4878');
    expect(formatHostPort('192.168.0.156', 4878)).toBe('192.168.0.156:4878');
  });
});
