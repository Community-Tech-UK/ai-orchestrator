import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { diagnoseProviderRuntime, type ProviderDiagnosticExec } from './provider-runtime-diagnostics';

function makeExec(results: Record<string, { stdout?: string; stderr?: string; error?: Error }>): ProviderDiagnosticExec {
  return async (file, args) => {
    const key = [file, ...args].join(' ');
    const result = results[key];
    if (!result) {
      throw new Error(`unexpected command: ${key}`);
    }
    if (result.error) {
      throw Object.assign(result.error, {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      });
    }
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
}

describe('diagnoseProviderRuntime', () => {
  it.each(['cursor', 'claude', 'codex', 'antigravity'] as const)(
    'fails closed when the real $provider probe exceeds its deadline then exits zero',
    async (provider) => {
      if (process.platform === 'win32') {
        return;
      }
      const fixtureDir = await mkdtemp(join(tmpdir(), 'aio-provider-timeout-'));
      const executable = provider === 'cursor'
        ? 'cursor-agent'
        : provider === 'antigravity'
          ? 'agy'
          : provider;
      const executablePath = join(fixtureDir, executable);
      const fixture = `#!${process.execPath}\n`
        + "const { basename } = require('node:path');\n"
        + "if (process.argv.includes('--version')) { console.log('fixture 1.2.3'); process.exit(0); }\n"
        + "const name = basename(process.argv[1]);\n"
        + "if (name === 'cursor-agent') console.log(JSON.stringify({ status: 'authenticated', isAuthenticated: true }));\n"
        + "else if (name === 'claude') console.log(JSON.stringify({ loggedIn: true }));\n"
        + "else if (name === 'agy') console.log('Available models:\\ngemini-3.1-pro-high\\tGemini 3.1 Pro (High)');\n"
        + "else console.log('Logged in using ChatGPT');\n"
        + "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50));\n"
        + "setInterval(() => undefined, 1000);\n";
      await writeFile(executablePath, fixture, { mode: 0o755 });
      const startedAt = Date.now();

      try {
        const result = await diagnoseProviderRuntime(provider, {
          env: {
            ...process.env,
            HOME: '/tmp/worker-home',
            PATH: `${fixtureDir}${delimiter}${process.env['PATH'] ?? ''}`,
          },
          authProbeTimeoutMs: 75,
        });

        expect(result.ok).toBe(false);
        expect(result.provider.authenticated).toBe(false);
        expect(Date.now() - startedAt).toBeLessThan(1_500);
      } finally {
        await rm(fixtureDir, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it.each([
    { provider: 'cursor' as const, versionCommand: 'cursor-agent --version' },
    { provider: 'claude' as const, versionCommand: 'claude --version' },
    { provider: 'codex' as const, versionCommand: 'codex --version' },
    { provider: 'antigravity' as const, versionCommand: 'agy --version' },
  ])('fails closed when the $provider version probe times out', async ({
    provider,
    versionCommand,
  }) => {
    const timeoutError = new Error('provider_probe_timeout');
    timeoutError.name = 'TimeoutError';
    const result = await diagnoseProviderRuntime(provider, {
      env: { HOME: '/tmp/worker-home' },
      exec: makeExec({
        'whoami': { stdout: 'worker-user\n' },
        [versionCommand]: { error: timeoutError },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.provider.available).toBe(false);
    expect(result.provider.authenticated).toBe(false);
  });

  it('proves Antigravity auth only with a successful non-interactive model catalogue', async () => {
    const exec = vi.fn<ProviderDiagnosticExec>(async (file, args, options) => {
      const command = [file, ...args].join(' ');
      if (command === 'whoami') return { stdout: 'worker-user\n', stderr: '' };
      if (command === 'agy --version') return { stdout: 'agy 1.2.3\n', stderr: '' };
      if (command === 'agy models') {
        expect(options).toEqual({
          env: {
            HOME: '/tmp/worker-home',
            NO_OPEN_BROWSER: '1',
            WORKER_MARKER: 'present',
          },
          timeout: 4_321,
        });
        return {
          stdout: 'Available models:\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const result = await diagnoseProviderRuntime('antigravity', {
      env: {
        HOME: '/tmp/worker-home',
        NO_OPEN_BROWSER: '0',
        WORKER_MARKER: 'present',
      },
      exec,
      authProbeTimeoutMs: 4_321,
    });

    expect(result.ok).toBe(true);
    expect(result.provider).toEqual({
      provider: 'antigravity',
      available: true,
      authenticated: true,
      version: '1.2.3',
    });
    expect(exec.mock.calls.map(([file, args]) => ({ file, args }))).toEqual([
      { file: 'whoami', args: [] },
      { file: 'agy', args: ['--version'] },
      { file: 'agy', args: ['models'] },
    ]);
  });

  it.each([
    {
      name: 'non-zero completion with an affirmative-looking catalogue',
      authResult: {
        stdout: 'Available models:\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n',
        error: new Error('exit 1'),
      },
    },
    {
      name: 'exit-zero sign-in text beside an affirmative-looking catalogue',
      authResult: {
        stdout: 'Available models:\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\nSign in to continue.\n',
      },
    },
    {
      name: 'hyphenated sign-in text beside an affirmative-looking catalogue',
      authResult: {
        stdout: 'Available models:\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\nPlease sign-in to continue.\n',
      },
    },
    {
      name: 'signed-out text beside an affirmative-looking catalogue',
      authResult: {
        stdout: 'Available models:\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\nYou are signed out.\n',
      },
    },
    {
      name: 'an HTTP authentication error beside an affirmative-looking catalogue',
      authResult: {
        stdout: 'Available models:\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n401 Unauthorized\n',
      },
    },
    {
      name: 'an error 401 marker before an affirmative-looking catalogue',
      authResult: {
        stdout: 'Error 401\nAvailable models:\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n',
      },
    },
    {
      name: 'an authenticate instruction after an affirmative-looking catalogue',
      authResult: {
        stdout: 'Available models:\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\nPlease authenticate to continue.\n',
      },
    },
    {
      name: 'a case-and-spacing-variant error marker interleaved with catalogue rows',
      authResult: {
        stdout: 'Available models:\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n  eRrOr    401  \nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n',
      },
    },
    {
      name: 'an error marker on stderr after an affirmative stdout catalogue',
      authResult: {
        stdout: 'Available models:\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n',
        stderr: '  ERROR: token unavailable\n',
      },
    },
    {
      name: 'an embedded error marker after an affirmative-looking catalogue',
      authResult: {
        stdout: 'Available models:\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\nProbe status: ERROR\n',
      },
    },
    {
      name: 'punctuation-separated authentication-required text after a catalogue row',
      authResult: {
        stdout: 'Available models:\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\nAUTHENTICATION: REQUIRED\n',
      },
    },
    {
      name: 'logged-out text before a catalogue row',
      authResult: {
        stdout: 'You are logged out.\nAvailable models:\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n',
      },
    },
    {
      name: 'an expired access token interleaved with catalogue rows',
      authResult: {
        stdout: 'gemini-3.1-pro-high\tGemini 3.1 Pro (High)\nAccess token has expired.\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n',
      },
    },
    {
      name: 'dot-separated sign-in text after a catalogue row',
      authResult: {
        stdout: 'Available models:\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\nPlease sign.in to continue.\n',
      },
    },
    {
      name: 'authorization-required text before a catalogue row',
      authResult: {
        stdout: 'Authorization required\nAvailable models:\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n',
      },
    },
    {
      name: 'authorization-failed text after a catalogue row',
      authResult: {
        stdout: 'gemini-3.1-pro-high\tGemini 3.1 Pro (High)\nAuthorization failed\n',
      },
    },
    {
      name: 'auth-expired text before a catalogue row',
      authResult: {
        stdout: 'Auth expired\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n',
      },
    },
    {
      name: 'authentication-expired text after a catalogue row',
      authResult: {
        stdout: 'gemini-3.1-pro-high\tGemini 3.1 Pro (High)\nAuthentication expired\n',
      },
    },
    {
      name: 'session-expired text before a catalogue row',
      authResult: {
        stdout: 'Session expired\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n',
      },
    },
    {
      name: 'access-denied text after a catalogue row',
      authResult: {
        stdout: 'gemini-3.1-pro-high\tGemini 3.1 Pro (High)\nAccess denied\n',
      },
    },
    {
      name: 'sign-out text before a catalogue row',
      authResult: {
        stdout: 'Sign out\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n',
      },
    },
    {
      name: 'standalone signout text before a catalogue row',
      authResult: {
        stdout: 'signout\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n',
      },
    },
    {
      name: 'standalone signout text after a catalogue row',
      authResult: {
        stdout: 'gemini-3.1-pro-high\tGemini 3.1 Pro (High)\nsignout\n',
      },
    },
    {
      name: 'standalone expired text before a catalogue row',
      authResult: {
        stdout: 'expired\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n',
      },
    },
    {
      name: 'standalone expired text after a catalogue row',
      authResult: {
        stdout: 'gemini-3.1-pro-high\tGemini 3.1 Pro (High)\nexpired\n',
      },
    },
    {
      name: 'the stale Gemini 3.5 Flash High catalogue pair',
      authResult: {
        stdout: 'gemini-3.5-flash-high\tGemini 3.5 Flash (High)\n',
      },
    },
    {
      name: 'the stale Gemini 3.5 Flash Medium catalogue pair',
      authResult: {
        stdout: 'gemini-3.5-flash-medium\tGemini 3.5 Flash (Medium)\n',
      },
    },
    {
      name: 'the stale Gemini 3.5 Flash Low catalogue pair',
      authResult: {
        stdout: 'gemini-3.5-flash-low\tGemini 3.5 Flash (Low)\n',
      },
    },
    {
      name: 'a CSI-coloured error marker on stderr',
      authResult: {
        stdout: 'Available models:\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n',
        stderr: '\u001B[31mERROR\u001B[0m: token unavailable\n',
      },
    },
    {
      name: 'a CSI-coloured fatal marker after a catalogue row',
      authResult: {
        stdout: 'Available models:\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n\u001B[1;31mFATAL\u001B[0m\n',
      },
    },
    {
      name: 'a CSI-coloured unauthorized marker on stderr',
      authResult: {
        stdout: 'Available models:\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n',
        stderr: '\u001B[33mUnauthorized\u001B[0m\n',
      },
    },
    {
      name: 'an auth-required marker split by multiple CSI sequences',
      authResult: {
        stdout: 'gemini-3.1-pro-high\tGemini 3.1 Pro (High)\nAUTH\u001B[31m\u001B[0m REQUIRED\n',
      },
    },
    {
      name: 'an unauthorized marker split by multiple CSI sequences',
      authResult: {
        stdout: 'gemini-3.1-pro-high\tGemini 3.1 Pro (High)\nUna\u001B[31mutho\u001B[0mrized\n',
      },
    },
    {
      name: 'an authentication-required marker split by an OSC sequence',
      authResult: {
        stdout: 'gemini-3.1-pro-high\tGemini 3.1 Pro (High)\nAUTH\u001B]0;probe status\u0007ENTICATION: REQUIRED\n',
      },
    },
    {
      name: 'an unauthorized marker whose next character is consumed as an ESC command',
      authResult: {
        stdout: 'gemini-3.1-pro-high\tGemini 3.1 Pro (High)\nUna\u001Burthorized\n',
      },
    },
    {
      name: 'an unauthorized marker whose next character is consumed as a C1 CSI command',
      authResult: {
        stdout: 'gemini-3.1-pro-high\tGemini 3.1 Pro (High)\nUna\u009Burthorized\n',
      },
    },
    {
      name: 'logged-out text split by a zero-width format character',
      authResult: {
        stdout: 'gemini-3.1-pro-high\tGemini 3.1 Pro (High)\nYou are log\u200Bged out.\n',
      },
    },
    {
      name: 'a fatal marker split by a zero-width format character',
      authResult: {
        stdout: 'gemini-3.1-pro-high\tGemini 3.1 Pro (High)\nfa\u200Btal\n',
      },
    },
    {
      name: 'a known display label without its exact catalogue ID pair',
      authResult: { stdout: 'Available models:\nGemini 3.1 Pro (High)\n' },
    },
    {
      name: 'an invented future-looking Gemini row',
      authResult: { stdout: 'Available models:\nGemini 99 Imaginary (High)\n' },
    },
    {
      name: 'an invented future-looking Claude row',
      authResult: { stdout: 'Available models:\nClaude Imaginary 99.9 (Thinking)\n' },
    },
    {
      name: 'an invented future-looking GPT-OSS row',
      authResult: { stdout: 'Available models:\nGPT-OSS 999B (Medium)\n' },
    },
    {
      name: 'empty exit-zero output',
      authResult: { stdout: '  \n', stderr: '\n' },
    },
    {
      name: 'malformed exit-zero output',
      authResult: { stdout: 'Antigravity CLI is ready.\n', stderr: '' },
    },
    {
      name: 'an error sentence that merely names a model',
      authResult: { stdout: 'Failed to load Gemini 3.1 Pro (High)\n', stderr: '' },
    },
  ])('fails closed for Antigravity auth on $name', async ({ authResult }) => {
    const exec = vi.fn<ProviderDiagnosticExec>(makeExec({
      'whoami': { stdout: 'worker-user\n' },
      'agy --version': { stdout: 'agy 1.2.3\n' },
      'agy models': authResult,
    }));
    const result = await diagnoseProviderRuntime('antigravity', {
      env: { HOME: '/tmp/worker-home' },
      exec,
    });

    expect(result.ok).toBe(false);
    expect(result.provider).toEqual({
      provider: 'antigravity',
      available: true,
      authenticated: false,
      version: '1.2.3',
      remediation: 'Sign in to Antigravity CLI in the worker user context, then run provider diagnostics again.',
    });
    expect(exec.mock.calls.map(([file, args]) => ({ file, args }))).toEqual([
      { file: 'whoami', args: [] },
      { file: 'agy', args: ['--version'] },
      { file: 'agy', args: ['models'] },
    ]);
  });

  it('accepts exact catalogue pairs with legitimate list and selection metadata', async () => {
    const result = await diagnoseProviderRuntime('antigravity', {
      env: { HOME: '/tmp/worker-home' },
      exec: makeExec({
        'whoami': { stdout: 'worker-user\n' },
        'agy --version': { stdout: 'agy 1.2.3\n' },
        'agy models': {
          stdout: 'Available models:\n1. gemini-3.1-pro-high\tGemini 3.1 Pro (High) [current]\n• claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking) (selected)\nCatalogue metadata: 2 models available; status ready.\n',
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.provider.authenticated).toBe(true);
  });

  it('accepts the exact current agy 1.2.2 catalogue row grammar', async () => {
    const result = await diagnoseProviderRuntime('antigravity', {
      env: { HOME: '/tmp/worker-home' },
      exec: makeExec({
        'whoami': { stdout: 'worker-user\n' },
        'agy --version': { stdout: '1.2.2\n' },
        'agy models': {
          stdout: [
            'Fetching available models...',
            'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
            'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
            'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
            'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
            'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)',
            'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)',
            'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
            'gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)',
            'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)',
            'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
            'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
            'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
            'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
            'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
            '',
          ].join('\n'),
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.provider.authenticated).toBe(true);
  });

  it('accepts a CSI-coloured exact current catalogue row', async () => {
    const result = await diagnoseProviderRuntime('antigravity', {
      env: { HOME: '/tmp/worker-home' },
      exec: makeExec({
        'whoami': { stdout: 'worker-user\n' },
        'agy --version': { stdout: '1.2.2\n' },
        'agy models': {
          stdout: 'Fetching available models...\n\u001B[32mgemini-3.8-flash-high\tGemini 3.8 Flash (High)\u001B[0m\n',
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.provider.authenticated).toBe(true);
  });

  it('reads Copilot login state without spawning an authentication prompt', async () => {
    const exec = vi.fn<ProviderDiagnosticExec>(makeExec({
      'whoami': { stdout: 'worker-user\n' },
      'copilot --version': { stdout: 'GitHub Copilot CLI 1.0.56\n' },
    }));
    const readFile = vi.fn(async () => JSON.stringify({
      lastLoggedInUser: { host: 'github.com', login: 'worker-user' },
      loggedInUsers: [{ host: 'github.com', login: 'worker-user' }],
    }));

    const result = await diagnoseProviderRuntime('copilot', {
      env: { HOME: '/tmp/worker-home' },
      exec,
      readFile,
    });

    expect(result.provider.authenticated).toBe(true);
    expect(exec.mock.calls.map(([file, args]) => [file, ...args].join(' '))).toEqual([
      'whoami',
      'copilot --version',
    ]);
    expect(readFile).toHaveBeenCalledWith(join('/tmp/worker-home', '.copilot', 'config.json'));
  });

  it('reports signed-out Cursor without permitting the status probe to open a browser', async () => {
    const exec = vi.fn<ProviderDiagnosticExec>(async (file, args, options) => {
      const command = [file, ...args].join(' ');
      if (command === 'whoami') return { stdout: 'worker-user\n', stderr: '' };
      if (command === 'cursor-agent --version') return { stdout: 'Cursor Agent 1.2.3\n', stderr: '' };
      if (command === 'cursor-agent status --format json') {
        expect(options?.env?.['NO_OPEN_BROWSER']).toBe('1');
        return {
          stdout: '{"status":"unauthenticated","isAuthenticated":false,"hasAccessToken":false,"hasRefreshToken":false,"userInfo":null}\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const result = await diagnoseProviderRuntime('cursor', {
      env: { HOME: '/tmp/worker-home' },
      exec,
    });

    expect(result.ok).toBe(false);
    expect(result.provider).toMatchObject({
      provider: 'cursor',
      available: true,
      authenticated: false,
      version: '1.2.3',
    });
    expect(exec.mock.calls.map(([file, args]) => [file, ...args].join(' '))).not.toContain(
      'cursor-agent login',
    );
  });

  it('reports Cursor authenticated only from an explicit authenticated status payload', async () => {
    const result = await diagnoseProviderRuntime('cursor', {
      env: { HOME: '/tmp/worker-home' },
      exec: makeExec({
        'whoami': { stdout: 'worker-user\n' },
        'cursor-agent --version': { stdout: 'Cursor Agent 1.2.3\n' },
        'cursor-agent status --format json': {
          stdout: '{"status":"authenticated","isAuthenticated":true,"hasAccessToken":true,"hasRefreshToken":true,"userInfo":{}}\n',
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.provider).toEqual({
      provider: 'cursor',
      available: true,
      authenticated: true,
      version: '1.2.3',
    });
  });

  it('uses Claude and Codex non-interactive auth status commands when available', async () => {
    const claude = await diagnoseProviderRuntime('claude', {
      env: { HOME: '/tmp/worker-home' },
      exec: makeExec({
        'whoami': { stdout: 'worker-user\n' },
        'claude --version': { stdout: '2.3.4\n' },
        'claude auth status': { stdout: '{"loggedIn":true,"account":"not-returned"}\n' },
      }),
    });
    const codex = await diagnoseProviderRuntime('codex', {
      env: { HOME: '/tmp/worker-home' },
      exec: makeExec({
        'whoami': { stdout: 'worker-user\n' },
        'codex --version': { stdout: 'codex-cli 5.6.7\n' },
        'codex login status': { stderr: 'Not logged in\n' },
      }),
    });

    expect(claude.ok).toBe(true);
    expect(claude.provider).toEqual({
      provider: 'claude',
      available: true,
      authenticated: true,
      version: '2.3.4',
    });
    expect(codex.ok).toBe(false);
    expect(codex.provider).toMatchObject({
      provider: 'codex',
      available: true,
      authenticated: false,
      version: '5.6.7',
    });
  });

  it.each([
    {
      provider: 'cursor' as const,
      versionCommand: 'cursor-agent --version',
      versionOutput: 'Cursor Agent 1.2.3\n',
      authCommand: 'cursor-agent status --format json',
      affirmativeOutput: '{"status":"authenticated","isAuthenticated":true}\n',
    },
    {
      provider: 'claude' as const,
      versionCommand: 'claude --version',
      versionOutput: '2.3.4\n',
      authCommand: 'claude auth status',
      affirmativeOutput: '{"loggedIn":true}\n',
    },
    {
      provider: 'codex' as const,
      versionCommand: 'codex --version',
      versionOutput: 'codex-cli 5.6.7\n',
      authCommand: 'codex login status',
      affirmativeOutput: 'Logged in using ChatGPT\n',
    },
  ])('fails closed when a rejected $provider auth probe captures affirmative output', async ({
    provider,
    versionCommand,
    versionOutput,
    authCommand,
    affirmativeOutput,
  }) => {
    const result = await diagnoseProviderRuntime(provider, {
      env: { HOME: '/tmp/worker-home' },
      exec: makeExec({
        'whoami': { stdout: 'worker-user\n' },
        [versionCommand]: { stdout: versionOutput },
        [authCommand]: {
          stdout: affirmativeOutput,
          error: new Error('exit 1'),
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.provider.authenticated).toBe(false);
  });

  it.each([
    {
      provider: 'cursor' as const,
      versionCommand: 'cursor-agent --version',
      versionOutput: 'Cursor Agent 1.2.3\n',
      authCommand: 'cursor-agent status --format json',
      affirmativeOutput: '{"status":"authenticated","isAuthenticated":true}\n',
    },
    {
      provider: 'claude' as const,
      versionCommand: 'claude --version',
      versionOutput: '2.3.4\n',
      authCommand: 'claude auth status',
      affirmativeOutput: '{"loggedIn":true}\n',
    },
    {
      provider: 'codex' as const,
      versionCommand: 'codex --version',
      versionOutput: 'codex-cli 5.6.7\n',
      authCommand: 'codex login status',
      affirmativeOutput: 'Logged in using ChatGPT\n',
    },
  ])('fails closed when a timed-out $provider auth probe captures affirmative output', async ({
    provider,
    versionCommand,
    versionOutput,
    authCommand,
    affirmativeOutput,
  }) => {
    const timeoutError = new Error('timed out');
    timeoutError.name = 'TimeoutError';
    const result = await diagnoseProviderRuntime(provider, {
      env: { HOME: '/tmp/worker-home' },
      exec: makeExec({
        'whoami': { stdout: 'worker-user\n' },
        [versionCommand]: { stdout: versionOutput },
        [authCommand]: {
          stderr: affirmativeOutput,
          error: timeoutError,
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.provider.authenticated).toBe(false);
  });

  it('bounds worker identity strings before returning diagnostics', async () => {
    const result = await diagnoseProviderRuntime('antigravity', {
      env: { HOME: `/tmp/${'h'.repeat(5_000)}` },
      exec: makeExec({
        'whoami': { stdout: `${'u'.repeat(5_000)}\n` },
        'agy --version': { stdout: 'agy 1.2.3\n' },
      }),
    });

    expect(Buffer.byteLength(result.identity.username ?? '', 'utf8')).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(result.identity.homeDir ?? '', 'utf8')).toBeLessThanOrEqual(2_048);
  });

  it('reports Copilot authentication failure from the worker service identity', async () => {
    const result = await diagnoseProviderRuntime('copilot', {
      platform: 'win32',
      env: {
        USERPROFILE: 'C:\\Windows\\ServiceProfiles\\ai-orchestrator-worker',
      },
      exec: makeExec({
        'whoami': { stdout: 'nt service\\ai-orchestrator-worker\r\n' },
        'copilot --version': { stdout: 'GitHub Copilot CLI 1.0.56\r\n' },
      }),
      readFile: async () => JSON.stringify({ loggedInUsers: [] }),
    });

    expect(result.ok).toBe(false);
    expect(result.identity.username).toBe('nt service\\ai-orchestrator-worker');
    expect(result.identity.serviceAccountLikely).toBe(true);
    expect(result.provider.available).toBe(true);
    expect(result.provider.authenticated).toBe(false);
    expect(result.provider.remediation).toContain('Run the worker provider runner as your Windows user');
  });

  it('fails closed when the Copilot config is missing', async () => {
    const result = await diagnoseProviderRuntime('copilot', {
      platform: 'darwin',
      env: { HOME: '/tmp/worker-home' },
      exec: makeExec({
        'whoami': { stdout: 'worker-user\n' },
        'copilot --version': { stdout: 'GitHub Copilot CLI 1.0.56\n' },
      }),
      readFile: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
    });

    expect(result.ok).toBe(false);
    expect(result.provider.authenticated).toBe(false);
  });

  it('fails closed when the Copilot config is malformed', async () => {
    const result = await diagnoseProviderRuntime('copilot', {
      env: { HOME: '/tmp/worker-home' },
      exec: makeExec({
        'whoami': { stdout: 'worker-user\n' },
        'copilot --version': { stdout: 'GitHub Copilot CLI 1.0.56\n' },
      }),
      readFile: async () => '{ malformed',
    });

    expect(result.ok).toBe(false);
    expect(result.provider.authenticated).toBe(false);
  });

  it('fails closed when multiple Copilot users have no unambiguous active user', async () => {
    const result = await diagnoseProviderRuntime('copilot', {
      env: { HOME: '/tmp/worker-home' },
      exec: makeExec({
        'whoami': { stdout: 'worker-user\n' },
        'copilot --version': { stdout: 'GitHub Copilot CLI 1.0.56\n' },
      }),
      readFile: async () => JSON.stringify({
        loggedInUsers: [
          { host: 'github.com', login: 'user-one' },
          { host: 'github.com', login: 'user-two' },
        ],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.provider.authenticated).toBe(false);
  });
});
