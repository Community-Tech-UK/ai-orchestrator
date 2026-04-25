import { describe, it, expect } from 'vitest';
import { GeminiQuotaProbe, type GeminiFileReader } from './gemini-quota-probe';

/**
 * Build a fake reader that returns content per file path.
 * Pass `null` for a path to simulate ENOENT.
 */
function fakeReader(map: Record<string, string | null>): GeminiFileReader {
  return async (filePath) => {
    for (const [pattern, value] of Object.entries(map)) {
      if (filePath.endsWith(pattern)) {
        if (value === null) {
          const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          throw err;
        }
        return value;
      }
    }
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    throw err;
  };
}

const ACCOUNTS_LOGGED_IN = JSON.stringify({
  active: 'user@example.com',
  old: [],
});

const ACCOUNTS_LOGGED_OUT = JSON.stringify({
  active: '',
  old: ['previous@example.com'],
});

const SETTINGS_OAUTH = JSON.stringify({
  security: { auth: { selectedType: 'oauth-personal' } },
});

const SETTINGS_API = JSON.stringify({
  security: { auth: { selectedType: 'gemini-api-key' } },
});

describe('GeminiQuotaProbe', () => {
  describe('happy path — logged in', () => {
    it('returns ok=true with plan="personal" for oauth-personal', async () => {
      const probe = new GeminiQuotaProbe({
        readFile: fakeReader({
          'google_accounts.json': ACCOUNTS_LOGGED_IN,
          'settings.json': SETTINGS_OAUTH,
        }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.provider).toBe('gemini');
      expect(snap!.ok).toBe(true);
      expect(snap!.plan).toBe('personal');
      expect(snap!.windows).toEqual([]);
    });

    it('returns ok=true with plan="api" for API-key auth', async () => {
      const probe = new GeminiQuotaProbe({
        readFile: fakeReader({
          'google_accounts.json': ACCOUNTS_LOGGED_IN,
          'settings.json': SETTINGS_API,
        }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(true);
      expect(snap!.plan).toBe('api');
    });

    it('falls back to plan="unknown" when settings missing', async () => {
      const probe = new GeminiQuotaProbe({
        readFile: fakeReader({
          'google_accounts.json': ACCOUNTS_LOGGED_IN,
          'settings.json': null,
        }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(true);
      expect(snap!.plan).toBe('unknown');
    });

    it('falls back to plan="unknown" when selectedType is unrecognised', async () => {
      const probe = new GeminiQuotaProbe({
        readFile: fakeReader({
          'google_accounts.json': ACCOUNTS_LOGGED_IN,
          'settings.json': JSON.stringify({
            security: { auth: { selectedType: 'future-auth-method' } },
          }),
        }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(true);
      expect(snap!.plan).toBe('unknown');
    });
  });

  describe('logged-out states', () => {
    it('returns ok=false when active email is empty', async () => {
      const probe = new GeminiQuotaProbe({
        readFile: fakeReader({
          'google_accounts.json': ACCOUNTS_LOGGED_OUT,
          'settings.json': SETTINGS_OAUTH,
        }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toMatch(/not signed in|logged out/i);
    });

    it('returns ok=false when accounts file does not exist', async () => {
      const probe = new GeminiQuotaProbe({
        readFile: fakeReader({
          'google_accounts.json': null,
          'settings.json': SETTINGS_OAUTH,
        }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toMatch(/not signed in|not installed/i);
    });

    it('returns ok=false when active is missing from accounts file', async () => {
      const probe = new GeminiQuotaProbe({
        readFile: fakeReader({
          'google_accounts.json': JSON.stringify({ old: [] }),
          'settings.json': SETTINGS_OAUTH,
        }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
    });
  });

  describe('failure modes', () => {
    it('returns ok=false on permission error', async () => {
      const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      const probe = new GeminiQuotaProbe({
        readFile: async () => { throw eacces; },
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toMatch(/permission|EACCES/i);
    });

    it('returns ok=false on malformed accounts JSON', async () => {
      const probe = new GeminiQuotaProbe({
        readFile: fakeReader({
          'google_accounts.json': 'not json{',
          'settings.json': SETTINGS_OAUTH,
        }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toMatch(/parse|json/i);
    });
  });

  describe('reader invocation', () => {
    it('reads from ~/.gemini/google_accounts.json by default', async () => {
      const calls: string[] = [];
      const probe = new GeminiQuotaProbe({
        readFile: async (p) => {
          calls.push(p);
          if (p.endsWith('google_accounts.json')) return ACCOUNTS_LOGGED_IN;
          if (p.endsWith('settings.json')) return SETTINGS_OAUTH;
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
      });
      await probe.probe({ signal: new AbortController().signal });
      expect(calls.some((p) => p.endsWith('.gemini/google_accounts.json'))).toBe(true);
    });

    it('honours a configDir override', async () => {
      const calls: string[] = [];
      const probe = new GeminiQuotaProbe({
        configDir: '/tmp/custom-gemini',
        readFile: async (p) => {
          calls.push(p);
          if (p.endsWith('google_accounts.json')) return ACCOUNTS_LOGGED_IN;
          if (p.endsWith('settings.json')) return SETTINGS_OAUTH;
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
      });
      await probe.probe({ signal: new AbortController().signal });
      expect(calls.some((p) => p === '/tmp/custom-gemini/google_accounts.json')).toBe(true);
    });

    it('returns provider id "gemini"', () => {
      const probe = new GeminiQuotaProbe({
        readFile: fakeReader({
          'google_accounts.json': ACCOUNTS_LOGGED_IN,
          'settings.json': SETTINGS_OAUTH,
        }),
      });
      expect(probe.provider).toBe('gemini');
    });
  });
});
