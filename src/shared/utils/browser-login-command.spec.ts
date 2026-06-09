import { describe, expect, it } from 'vitest';
import {
  buildBrowserLoginCommand,
  normalizeLoginUrl,
  assertSafeLoginArg,
} from './browser-login-command';

describe('normalizeLoginUrl', () => {
  it('passes through about:blank', () => {
    expect(normalizeLoginUrl(undefined)).toBe('about:blank');
    expect(normalizeLoginUrl('about:blank')).toBe('about:blank');
  });

  it('accepts http(s) URLs', () => {
    expect(normalizeLoginUrl('https://www.facebook.com')).toBe('https://www.facebook.com/');
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => normalizeLoginUrl('file:///etc/passwd')).toThrow(/http or https/);
    expect(() => normalizeLoginUrl('javascript:alert(1)')).toThrow();
  });

  it('rejects malformed URLs', () => {
    expect(() => normalizeLoginUrl('not a url')).toThrow(/valid http/);
  });
});

describe('assertSafeLoginArg', () => {
  it('rejects shell metacharacters', () => {
    for (const bad of ['a;rm -rf', "a'b", 'a"b', 'a`b', 'a$b', 'a|b', 'a&b', 'a\nb', 'a(b)']) {
      expect(() => assertSafeLoginArg(bad, 'x')).toThrow();
    }
  });

  it('accepts ordinary paths', () => {
    expect(() => assertSafeLoginArg('C:\\Users\\me\\profile', 'x')).not.toThrow();
    expect(() => assertSafeLoginArg('/home/me/.orchestrator/profile', 'x')).not.toThrow();
  });
});

describe('buildBrowserLoginCommand', () => {
  it('builds a PowerShell Start-Process command on win32', () => {
    const { shell, command } = buildBrowserLoginCommand(
      'win32',
      'C:\\Users\\shutu\\.orchestrator\\fb-profile',
      'https://www.facebook.com',
    );
    expect(shell).toBe('powershell.exe');
    expect(command).toContain('Start-Process');
    expect(command).toContain("'--user-data-dir=C:\\Users\\shutu\\.orchestrator\\fb-profile'");
    expect(command).toContain('chrome.exe');
    expect(command).toContain('facebook.com');
  });

  it('builds a POSIX command on darwin/linux', () => {
    const mac = buildBrowserLoginCommand('darwin', '/Users/me/profile', 'about:blank');
    expect(mac.shell).toBe('/bin/zsh');
    expect(mac.command).toContain('--user-data-dir="/Users/me/profile"');
    expect(mac.command).toContain('Google Chrome');
    expect(mac.command.trim().endsWith('&')).toBe(true);

    const linux = buildBrowserLoginCommand('linux', '/home/me/profile', 'about:blank');
    expect(linux.shell).toBe('/bin/sh');
    expect(linux.command).toContain('google-chrome');
  });

  it('honors a custom chrome path', () => {
    const { command } = buildBrowserLoginCommand('linux', '/p', 'about:blank', '/opt/chromium');
    expect(command).toContain('/opt/chromium');
  });

  it('refuses an injection attempt in the profile dir', () => {
    expect(() =>
      buildBrowserLoginCommand('linux', '/p"; rm -rf ~', 'about:blank'),
    ).toThrow(/Profile directory/);
  });

  it('refuses an injection attempt in a custom chrome path', () => {
    expect(() =>
      buildBrowserLoginCommand('linux', '/p', 'about:blank', '/x`reboot`'),
    ).toThrow(/Chrome path/);
  });
});
