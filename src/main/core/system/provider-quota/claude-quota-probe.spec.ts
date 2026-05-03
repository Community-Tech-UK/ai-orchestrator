import { describe, it, expect } from 'vitest';
import { ClaudeQuotaProbe, type ClaudeAuthStatusExec } from './claude-quota-probe';

/** Build an exec stub that returns the given stdout/stderr/exit code. */
function fakeExec(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  throws?: Error;
}): ClaudeAuthStatusExec {
  return async () => {
    if (opts.throws) throw opts.throws;
    return {
      stdout: opts.stdout ?? '',
      stderr: opts.stderr ?? '',
      exitCode: opts.exitCode ?? 0,
    };
  };
}

const LOGGED_IN_MAX = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'user@example.com',
  orgId: 'org-123',
  orgName: 'Example Co',
  subscriptionType: 'max',
});

const LOGGED_IN_PRO = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'user@example.com',
  subscriptionType: 'pro',
});

const LOGGED_IN_API_KEY = JSON.stringify({
  loggedIn: true,
  authMethod: 'apiKey',
  apiProvider: 'anthropic',
  // No subscriptionType — API-key users
});

const LOGGED_OUT = JSON.stringify({ loggedIn: false });

describe('ClaudeQuotaProbe', () => {
  describe('happy path — logged-in subscription', () => {
    it('returns ok=true with plan=max for a Max subscription', async () => {
      const probe = new ClaudeQuotaProbe({ exec: fakeExec({ stdout: LOGGED_IN_MAX }) });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap).not.toBeNull();
      expect(snap!.provider).toBe('claude');
      expect(snap!.ok).toBe(true);
      expect(snap!.plan).toBe('max');
      expect(snap!.source).toBe('cli-result');
      expect(snap!.windows).toEqual([]);
      expect(snap!.error).toBeUndefined();
    });

    it('returns ok=true with plan=pro for a Pro subscription', async () => {
      const probe = new ClaudeQuotaProbe({ exec: fakeExec({ stdout: LOGGED_IN_PRO }) });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(true);
      expect(snap!.plan).toBe('pro');
    });

    it('returns ok=true with plan=api when no subscriptionType (API key user)', async () => {
      const probe = new ClaudeQuotaProbe({ exec: fakeExec({ stdout: LOGGED_IN_API_KEY }) });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(true);
      expect(snap!.plan).toBe('api');
    });
  });

  describe('logged out', () => {
    it('returns ok=false with informative error', async () => {
      const probe = new ClaudeQuotaProbe({ exec: fakeExec({ stdout: LOGGED_OUT }) });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap).not.toBeNull();
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toMatch(/not signed in|logged out/i);
      expect(snap!.windows).toEqual([]);
    });
  });

  describe('failure modes', () => {
    it('returns ok=false when exec throws ENOENT (claude not installed)', async () => {
      const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
      const probe = new ClaudeQuotaProbe({ exec: fakeExec({ throws: enoent }) });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toMatch(/not found|not installed/i);
    });

    it('returns ok=false when exec throws a generic error', async () => {
      const probe = new ClaudeQuotaProbe({
        exec: fakeExec({ throws: new Error('boom') }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toContain('boom');
    });

    it('returns ok=false on non-zero exit code', async () => {
      const probe = new ClaudeQuotaProbe({
        exec: fakeExec({ stdout: '', stderr: 'auth: not configured', exitCode: 1 }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toMatch(/auth: not configured|exit/i);
    });

    it('returns ok=false on malformed JSON', async () => {
      const probe = new ClaudeQuotaProbe({
        exec: fakeExec({ stdout: 'not json at all' }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toMatch(/parse|json/i);
    });

    it('returns ok=false on unexpected JSON shape', async () => {
      const probe = new ClaudeQuotaProbe({
        exec: fakeExec({ stdout: JSON.stringify({ foo: 'bar' }) }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toMatch(/unexpected|invalid/i);
    });
  });

  describe('exec invocation', () => {
    it('passes the configured cliCommand and the auth-status args', async () => {
      const calls: { command: string; args: string[] }[] = [];
      const probe = new ClaudeQuotaProbe({
        cliCommand: '/custom/path/to/claude',
        exec: async (command, args) => {
          calls.push({ command, args });
          return { stdout: LOGGED_IN_MAX, stderr: '', exitCode: 0 };
        },
      });
      await probe.probe({ signal: new AbortController().signal });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe('/custom/path/to/claude');
      expect(calls[0].args).toEqual(['auth', 'status', '--json']);
    });

    it('forwards the AbortSignal to the exec call', async () => {
      let received: AbortSignal | undefined;
      const probe = new ClaudeQuotaProbe({
        exec: async (_c, _a, { signal }) => {
          received = signal;
          return { stdout: LOGGED_IN_MAX, stderr: '', exitCode: 0 };
        },
      });
      const ac = new AbortController();
      await probe.probe({ signal: ac.signal });
      expect(received).toBe(ac.signal);
    });

    it('passes the expanded CLI PATH to exec', async () => {
      let pathEnv = '';
      const probe = new ClaudeQuotaProbe({
        env: { HOME: '/Users/alice', PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv,
        platform: 'darwin',
        exec: async (_c, _a, { env }) => {
          pathEnv = env['PATH'] ?? '';
          return { stdout: LOGGED_IN_MAX, stderr: '', exitCode: 0 };
        },
      });
      await probe.probe({ signal: new AbortController().signal });
      expect(pathEnv).toContain('/Users/alice/.local/bin');
      expect(pathEnv).toContain('/Users/alice/.nvm/versions/node/current/bin');
      expect(pathEnv).toContain('/usr/bin:/bin');
    });

    it('returns the provider id "claude"', () => {
      const probe = new ClaudeQuotaProbe({ exec: fakeExec({ stdout: LOGGED_IN_MAX }) });
      expect(probe.provider).toBe('claude');
    });
  });

  describe('snapshot fields', () => {
    it('sets takenAt to a recent timestamp', async () => {
      const before = Date.now();
      const probe = new ClaudeQuotaProbe({ exec: fakeExec({ stdout: LOGGED_IN_MAX }) });
      const snap = await probe.probe({ signal: new AbortController().signal });
      const after = Date.now();
      expect(snap!.takenAt).toBeGreaterThanOrEqual(before);
      expect(snap!.takenAt).toBeLessThanOrEqual(after);
    });
  });
});
