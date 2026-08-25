import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression cover for a live, UI-reachable bypass found by the completion
 * gate on 2026-08-25.
 *
 * `CopilotCliAdapter` is the EXEC-mode Copilot path (the CLI verification
 * dashboard reaches it through `CopilotCliProvider`), separate from the
 * ACP adapter the factory builds. It set neither `--config-dir` nor
 * `COPILOT_HOME` and never applied the Copilot token-strip list, so every turn
 * through it ran against the ambient `~/.copilot` account — the shared, racy
 * selection this whole feature exists to replace.
 *
 * Spec §10.3: "Both ACP mode and any exec/server fallback receive the same
 * profile home and sanitized environment."
 */

const resolvedHome = '/state/copilot-cli-profiles/enterprise';

vi.mock('./copilot/copilot-account-home-resolver', () => ({
  resolveCopilotProfileHome: (profileId: string) =>
    profileId === 'legacy' ? '/state/copilot-cli-home' : join('/state/copilot-cli-profiles', profileId),
}));

vi.mock('../copilot-cli-launch', () => ({
  getDefaultCopilotCliLaunch: () => ({
    command: '/usr/local/bin/copilot',
    argsPrefix: [],
    displayCommand: 'copilot',
  }),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { CopilotCliAdapter } from './copilot-cli-adapter';
import { COPILOT_STRIPPED_AUTH_ENV_VARS } from './adapter-spawn-helpers';

/** `buildArgs` and the adapter config are both protected/private. */
function argsOf(adapter: CopilotCliAdapter): string[] {
  return (
    adapter as unknown as { buildArgs(message: { role: string; content: string }): string[] }
  ).buildArgs({ role: 'user', content: 'hello' });
}

function configOf(adapter: CopilotCliAdapter): {
  env?: Record<string, string>;
  envRemove?: readonly string[];
} {
  return (adapter as unknown as { config: { env?: Record<string, string>; envRemove?: readonly string[] } })
    .config;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CopilotCliAdapter — routed account session', () => {
  it('pins the CLI to the resolved profile home via --config-dir', () => {
    const args = argsOf(
      new CopilotCliAdapter({ accountProfileId: 'enterprise', accountHost: 'github.com' }),
    );
    const index = args.indexOf('--config-dir');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(args[index + 1]).toBe(resolvedHome);
  });

  it('sets COPILOT_HOME and COPILOT_GH_HOST on the child environment', () => {
    const config = configOf(
      new CopilotCliAdapter({ accountProfileId: 'enterprise', accountHost: 'ghe.example.com' }),
    );
    expect(config.env?.['COPILOT_HOME']).toBe(resolvedHome);
    expect(config.env?.['COPILOT_GH_HOST']).toBe('ghe.example.com');
  });

  it('removes every ambient GitHub token variable, including GITHUB_TOKEN_VARNAME', () => {
    const config = configOf(new CopilotCliAdapter({ accountProfileId: 'enterprise' }));
    for (const key of COPILOT_STRIPPED_AUTH_ENV_VARS) {
      expect(config.envRemove, key).toContain(key);
    }
    // GITHUB_TOKEN_VARNAME does not match the generic `_TOKEN$` block pattern
    // in env-filter.ts, so the generic filter alone would let it through.
    expect(config.envRemove).toContain('GITHUB_TOKEN_VARNAME');
  });

  it('uses the pre-existing home for the legacy profile', () => {
    const args = argsOf(new CopilotCliAdapter({ accountProfileId: 'legacy' }));
    expect(args[args.indexOf('--config-dir') + 1]).toBe('/state/copilot-cli-home');
  });
});

describe('CopilotCliAdapter — unrouted construction', () => {
  it('stays usable for installation-only probes (no account required)', () => {
    // `checkStatus()` (--version) and `listAvailableModels()` (help config)
    // issue no model request, so spec §10.2 exempts them.
    const adapter = new CopilotCliAdapter();
    expect(configOf(adapter).env?.['COPILOT_HOME']).toBeUndefined();
    expect(argsOf(adapter)).not.toContain('--config-dir');
  });

  it('refuses to send a message without a resolved account', async () => {
    const adapter = new CopilotCliAdapter();
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;
    await expect(
      (
        adapter as unknown as {
          sendInputImpl(message: string): Promise<void>;
        }
      ).sendInputImpl('hello'),
    ).rejects.toThrow(/without a resolved account profile/);
  });

  it('still refuses after a real spawn attempt would have marked it ready', async () => {
    // Guards the ordering: the account check must not sit behind any branch
    // that a spawned-but-unrouted adapter skips.
    const adapter = new CopilotCliAdapter({ workingDir: '/tmp' });
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;
    await expect(
      (adapter as unknown as { sendInputImpl(m: string): Promise<void> }).sendInputImpl('hi'),
    ).rejects.toThrow(/internal routing error/);
  });
});
