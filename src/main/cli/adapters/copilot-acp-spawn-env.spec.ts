/**
 * Spawn-level cover for the Copilot ACP path — the DEFAULT path every
 * interactive Copilot session uses.
 *
 * Found by the completion gate on 2026-08-30. `createCopilotAdapter` deleted
 * the six token variables from the `env` object it built, and a config-level
 * test asserted exactly that. But `config.env` is an OVERLAY:
 * `BaseCliAdapter.spawnProcess` computes
 * `{...getSafeEnvForTrustedProcess(), ...config.env}`, and that filter
 * deliberately allowlists ambient `GITHUB_TOKEN`/`GH_TOKEN` through for git
 * tooling. Deleting a key from an overlay cannot remove it from the base, so
 * an ambient token reached the child and — because Copilot reads those
 * variables before its own keychain — silently outranked the routed profile.
 *
 * The lesson this file encodes: assert on what reaches `spawn()`, never on the
 * adapter's constructed config. The old assertion was true while the feature
 * was broken.
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { tmpdir } from 'os';
import type { ChildProcess } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const mocked = { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
  return { ...mocked, default: mocked };
});

import { BaseCliAdapter } from './base-cli-adapter';
import { createCliAdapter } from './adapter-factory';
import { COPILOT_STRIPPED_AUTH_ENV_VARS } from './adapter-spawn-helpers';
import type { ResolvedCopilotAccountRoute } from '../../../shared/types/copilot-account.types';

function makeFakeProc(): ChildProcess {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; pid: number;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.pid = 4242;
  return proc as unknown as ChildProcess;
}

/** The env `child_process.spawn` was actually handed. */
function spawnedEnv(): Record<string, string> {
  const options = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
  return options.env;
}

/** Drives the real base-adapter spawn choke point with a given config. */
function spawnWith(config: Record<string, unknown>): void {
  class Probe extends BaseCliAdapter {
    getName(): string { return 'copilot-acp'; }
    getCapabilities() {
      return {
        streaming: false, toolUse: false, fileAccess: false, shellExecution: false,
        multiTurn: false, vision: false, codeExecution: false, contextWindow: 0,
        outputFormats: [] as string[],
      };
    }
    async checkStatus() { return { available: true }; }
    async sendMessage(): Promise<never> { throw new Error('not used'); }
    sendMessageStream(): AsyncIterable<string> { throw new Error('not used'); }
    parseOutput(): never { throw new Error('not used'); }
    protected buildArgs(): string[] { return []; }
    protected async sendInputImpl(): Promise<void> { /* not used */ }
    run(): void { this.spawnProcess([]); }
  }
  new Probe(config as never).run();
}

const AMBIENT = {
  GH_TOKEN: 'ambient-placeholder',
  GITHUB_TOKEN: 'ambient-placeholder',
  GITHUB_TOKEN_VARNAME: 'GITHUB_TOKEN',
};
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockReturnValue(makeFakeProc());
  for (const [key, value] of Object.entries(AMBIENT)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterEach(() => {
  for (const key of Object.keys(AMBIENT)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('Copilot ACP spawn environment', () => {
  it('keeps ambient GitHub tokens out of the child when envRemove is set', () => {
    spawnWith({
      command: 'copilot',
      cwd: tmpdir(),
      env: { COPILOT_HOME: '/state/copilot-cli-profiles/enterprise' },
      envRemove: COPILOT_STRIPPED_AUTH_ENV_VARS,
    });

    const env = spawnedEnv();
    for (const key of COPILOT_STRIPPED_AUTH_ENV_VARS) {
      expect(env, `${key} must not reach the Copilot child`).not.toHaveProperty(key);
    }
    // The routed profile's home still gets through — the strip is targeted,
    // not a blanket wipe that would break routing itself.
    expect(env['COPILOT_HOME']).toBe('/state/copilot-cli-profiles/enterprise');
  });

  it('demonstrates why omitting the keys from config.env is NOT enough', () => {
    // Same config minus `envRemove`, with the keys absent from `config.env`
    // exactly as the factory built it. This is the shipped-broken shape; it
    // documents that an overlay cannot delete from the base env.
    spawnWith({
      command: 'copilot',
      cwd: tmpdir(),
      env: { COPILOT_HOME: '/state/copilot-cli-profiles/enterprise' },
    });

    const env = spawnedEnv();
    expect(env['GH_TOKEN']).toBe('ambient-placeholder');
    expect(env['GITHUB_TOKEN']).toBe('ambient-placeholder');
  });
});

describe('Copilot ACP spawn environment — through the real factory', () => {
  function legacyRoute(): ResolvedCopilotAccountRoute {
    return {
      profileId: 'legacy',
      source: 'legacy',
      executionNodeId: 'local',
      profileLabel: 'Existing Copilot account',
      expectedLogin: 'octocat',
      host: 'github.com',
    };
  }

  it('no ambient GitHub token reaches the child of a routed Copilot session', () => {
    // End-to-end over the wiring, not the mechanism: builds the adapter exactly
    // as a real interactive session does and inspects the env handed to
    // `child_process.spawn`. A config-level assertion passed while this leaked,
    // because `AcpCliAdapter`'s constructor field-picked `super({...})` and
    // dropped `envRemove` — accepted by the type, discarded at runtime.
    const adapter = createCliAdapter('copilot', {
      workingDirectory: tmpdir(),
      copilotAccountRoute: legacyRoute(),
    });
    (adapter as unknown as { spawnProcess(args: string[]): unknown }).spawnProcess([]);

    const env = spawnedEnv();
    for (const key of COPILOT_STRIPPED_AUTH_ENV_VARS) {
      expect(env, `${key} must not reach the Copilot child`).not.toHaveProperty(key);
    }
    expect(env['COPILOT_HOME']).toBeTruthy();
  });
});
