import { describe, it, expect } from 'vitest';
import { CopilotQuotaProbe, type CopilotConfigReader } from './copilot-quota-probe';

/** Build a fake reader that returns content / errors deterministically. */
function fakeReader(opts: { content?: string; throws?: NodeJS.ErrnoException }): CopilotConfigReader {
  return async () => {
    if (opts.throws) throw opts.throws;
    return opts.content ?? '';
  };
}

const LOGGED_IN_CONFIG = JSON.stringify({
  lastLoggedInUser: { host: 'https://github.com', login: 'octocat' },
  loggedInUsers: [{ host: 'https://github.com', login: 'octocat' }],
  trustedFolders: [],
});

const LOGGED_OUT_CONFIG_EMPTY_USERS = JSON.stringify({
  loggedInUsers: [],
});

const LOGGED_OUT_CONFIG_NO_FIELD = JSON.stringify({
  // Lacks `loggedInUsers` entirely
  trustedFolders: [],
});

describe('CopilotQuotaProbe', () => {
  describe('happy path — logged in', () => {
    it('returns ok=true with plan=unknown when loggedInUsers has entries', async () => {
      const probe = new CopilotQuotaProbe({ readFile: fakeReader({ content: LOGGED_IN_CONFIG }) });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap).not.toBeNull();
      expect(snap!.provider).toBe('copilot');
      expect(snap!.ok).toBe(true);
      expect(snap!.plan).toBe('unknown');
      expect(snap!.source).toBe('cli-result');
      expect(snap!.windows).toEqual([]);
      expect(snap!.error).toBeUndefined();
    });

    it('parses Copilot CLI\'s JSONC format (line comments at top)', async () => {
      const realCopilotConfig = `// User settings belong in settings.json.
// This file is managed automatically.
${LOGGED_IN_CONFIG}`;
      const probe = new CopilotQuotaProbe({ readFile: fakeReader({ content: realCopilotConfig }) });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(true);
    });

    it('does not strip "//" inside string values like URLs', async () => {
      // Regression: a previous implementation chopped lines anywhere // appeared,
      // corrupting "https://github.com" mid-string.
      const probe = new CopilotQuotaProbe({
        readFile: fakeReader({
          content: JSON.stringify({
            loggedInUsers: [{ host: 'https://github.com', login: 'octocat' }],
          }),
        }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(true);
    });
  });

  describe('logged-out states', () => {
    it('returns ok=false when loggedInUsers is empty', async () => {
      const probe = new CopilotQuotaProbe({
        readFile: fakeReader({ content: LOGGED_OUT_CONFIG_EMPTY_USERS }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toMatch(/not signed in|logged out/i);
    });

    it('returns ok=false when loggedInUsers field is missing', async () => {
      const probe = new CopilotQuotaProbe({
        readFile: fakeReader({ content: LOGGED_OUT_CONFIG_NO_FIELD }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
    });

    it('returns ok=false when config file does not exist (ENOENT)', async () => {
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
      const probe = new CopilotQuotaProbe({ readFile: fakeReader({ throws: enoent }) });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toMatch(/not signed in|not installed/i);
    });
  });

  describe('failure modes', () => {
    it('returns ok=false on permission error', async () => {
      const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' }) as NodeJS.ErrnoException;
      const probe = new CopilotQuotaProbe({ readFile: fakeReader({ throws: eacces }) });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toMatch(/permission|EACCES/i);
    });

    it('returns ok=false on malformed JSON', async () => {
      const probe = new CopilotQuotaProbe({
        readFile: fakeReader({ content: 'not json{{{' }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toMatch(/parse|json/i);
    });

    it('returns ok=false when loggedInUsers is the wrong type', async () => {
      const probe = new CopilotQuotaProbe({
        readFile: fakeReader({ content: JSON.stringify({ loggedInUsers: 'oops' }) }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
    });
  });

  describe('reader invocation', () => {
    it('reads from ~/.copilot/config.json when no configDir override', async () => {
      const calls: string[] = [];
      const probe = new CopilotQuotaProbe({
        readFile: async (p) => {
          calls.push(p);
          return LOGGED_IN_CONFIG;
        },
      });
      await probe.probe({ signal: new AbortController().signal });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(/\.copilot\/config\.json$/);
    });

    it('honours a configDir override', async () => {
      const calls: string[] = [];
      const probe = new CopilotQuotaProbe({
        configDir: '/tmp/custom-copilot',
        readFile: async (p) => {
          calls.push(p);
          return LOGGED_IN_CONFIG;
        },
      });
      await probe.probe({ signal: new AbortController().signal });
      expect(calls[0]).toBe('/tmp/custom-copilot/config.json');
    });

    it('returns the provider id "copilot"', () => {
      const probe = new CopilotQuotaProbe({ readFile: fakeReader({ content: LOGGED_IN_CONFIG }) });
      expect(probe.provider).toBe('copilot');
    });
  });

  describe('snapshot fields', () => {
    it('sets takenAt to a recent timestamp', async () => {
      const before = Date.now();
      const probe = new CopilotQuotaProbe({ readFile: fakeReader({ content: LOGGED_IN_CONFIG }) });
      const snap = await probe.probe({ signal: new AbortController().signal });
      const after = Date.now();
      expect(snap!.takenAt).toBeGreaterThanOrEqual(before);
      expect(snap!.takenAt).toBeLessThanOrEqual(after);
    });
  });
});
