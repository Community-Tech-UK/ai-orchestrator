import { describe, it, expect } from 'vitest';
import { CodexQuotaProbe, type CodexLoginStatusExec } from './codex-quota-probe';

function fakeExec(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  throws?: Error;
}): CodexLoginStatusExec {
  return async () => {
    if (opts.throws) throw opts.throws;
    return {
      stdout: opts.stdout ?? '',
      stderr: opts.stderr ?? '',
      exitCode: opts.exitCode ?? 0,
    };
  };
}

describe('CodexQuotaProbe', () => {
  describe('logged-in states', () => {
    it('detects ChatGPT subscription auth', async () => {
      const probe = new CodexQuotaProbe({
        exec: fakeExec({ stdout: 'Logged in using ChatGPT\n' }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(true);
      expect(snap!.provider).toBe('codex');
      expect(snap!.plan).toBe('chatgpt');
      expect(snap!.windows).toEqual([]);
    });

    it('detects API-key auth', async () => {
      const probe = new CodexQuotaProbe({
        exec: fakeExec({ stdout: 'Logged in using API key\n' }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(true);
      expect(snap!.plan).toBe('api');
    });

    it('falls back to plan="unknown" for unrecognised "Logged in using …" variants', async () => {
      const probe = new CodexQuotaProbe({
        exec: fakeExec({ stdout: 'Logged in using Some Future Method\n' }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(true);
      expect(snap!.plan).toBe('unknown');
    });

    it('handles trailing whitespace and CRLF', async () => {
      const probe = new CodexQuotaProbe({
        exec: fakeExec({ stdout: '  Logged in using ChatGPT  \r\n' }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(true);
      expect(snap!.plan).toBe('chatgpt');
    });

    it('falls back to stderr when stdout is empty (Codex CLI 0.125 behaviour)', async () => {
      // Regression: real `codex login status` writes its line to stderr.
      const probe = new CodexQuotaProbe({
        exec: fakeExec({ stdout: '', stderr: 'Logged in using ChatGPT\n', exitCode: 0 }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(true);
      expect(snap!.plan).toBe('chatgpt');
    });
  });

  describe('logged-out states', () => {
    it('detects "Not logged in" output (typical phrasing)', async () => {
      const probe = new CodexQuotaProbe({
        exec: fakeExec({ stdout: 'Not logged in\n' }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toMatch(/not logged in|signed out|not signed in/i);
    });

    it('detects empty stdout as logged-out', async () => {
      const probe = new CodexQuotaProbe({
        exec: fakeExec({ stdout: '' }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
    });

    it('treats unrecognised text as logged-out', async () => {
      const probe = new CodexQuotaProbe({
        exec: fakeExec({ stdout: 'Some completely unexpected response' }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
    });
  });

  describe('failure modes', () => {
    it('returns ok=false when CLI is not installed (ENOENT)', async () => {
      const enoent = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
      const probe = new CodexQuotaProbe({ exec: fakeExec({ throws: enoent }) });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toMatch(/not found|not installed/i);
    });

    it('returns ok=false on non-zero exit code', async () => {
      const probe = new CodexQuotaProbe({
        exec: fakeExec({ stdout: '', stderr: 'error: not initialised', exitCode: 2 }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toMatch(/not initialised|exit/i);
    });

    it('returns ok=false on generic exec error', async () => {
      const probe = new CodexQuotaProbe({
        exec: fakeExec({ throws: new Error('boom') }),
      });
      const snap = await probe.probe({ signal: new AbortController().signal });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toContain('boom');
    });
  });

  describe('exec invocation', () => {
    it('uses the configured cliCommand and "login status" args', async () => {
      const calls: { command: string; args: string[] }[] = [];
      const probe = new CodexQuotaProbe({
        cliCommand: '/custom/codex',
        exec: async (command, args) => {
          calls.push({ command, args });
          return { stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0 };
        },
      });
      await probe.probe({ signal: new AbortController().signal });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe('/custom/codex');
      expect(calls[0].args).toEqual(['login', 'status']);
    });

    it('forwards the AbortSignal to exec', async () => {
      let received: AbortSignal | undefined;
      const probe = new CodexQuotaProbe({
        exec: async (_c, _a, { signal }) => {
          received = signal;
          return { stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0 };
        },
      });
      const ac = new AbortController();
      await probe.probe({ signal: ac.signal });
      expect(received).toBe(ac.signal);
    });

    it('passes the expanded CLI PATH to exec', async () => {
      let pathEnv = '';
      const probe = new CodexQuotaProbe({
        env: { HOME: '/Users/alice', PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv,
        platform: 'darwin',
        exec: async (_c, _a, { env }) => {
          pathEnv = env['PATH'] ?? '';
          return { stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0 };
        },
      });
      await probe.probe({ signal: new AbortController().signal });
      expect(pathEnv).toContain('/Users/alice/.local/bin');
      expect(pathEnv).toContain('/Users/alice/.nvm/versions/node/current/bin');
      expect(pathEnv).toContain('/usr/bin:/bin');
    });

    it('returns provider id "codex"', () => {
      const probe = new CodexQuotaProbe({
        exec: fakeExec({ stdout: 'Logged in using ChatGPT' }),
      });
      expect(probe.provider).toBe('codex');
    });
  });
});
