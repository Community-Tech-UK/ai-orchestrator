/**
 * Fail-closed cover for the EXEC Copilot path (`CopilotCliProvider`, the CLI
 * verification dashboard).
 *
 * Found by the completion gate on 2026-08-30. `assertRoutableCopilotLaunchShape`
 * existed and was wired into the ACP factory, but the exec path resolved its
 * launch independently and never called it. On a machine with only
 * `gh copilot` (no standalone `copilot` binary) and more than one profile, that
 * path launched `gh copilot --`, which authenticates with the HOST-WIDE GitHub
 * CLI account — an account no `COPILOT_HOME` can override.
 *
 * Existence is not wiring: the guard passing its own unit tests said nothing
 * about whether this path called it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ghLaunch = { command: 'gh', argsPrefix: ['copilot'], displayCommand: 'gh copilot' };
const standaloneLaunch = {
  command: '/usr/local/bin/copilot',
  argsPrefix: [] as string[],
  displayCommand: 'copilot',
};
const launch = { current: ghLaunch as { command: string; argsPrefix: string[]; displayCommand: string } };
const profileCount = { current: 2 };

vi.mock('../copilot-cli-launch', () => ({
  getDefaultCopilotCliLaunch: () => launch.current,
}));

vi.mock('./copilot/copilot-account-home-resolver', () => ({
  resolveCopilotProfileHome: () => '/state/copilot-cli-home',
}));

vi.mock('../../providers/copilot/copilot-account-routing-service', () => ({
  getCopilotAccountRoutingService: () => ({
    listProfiles: () => Array.from({ length: profileCount.current }, (_, i) => ({ id: `p${i}` })),
  }),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { CopilotCliAdapter } from './copilot-cli-adapter';

/** `spawnProcess` is the single choke point where the launch is resolved. */
function resolveLaunch(adapter: CopilotCliAdapter): void {
  (adapter as unknown as { ensureLaunchResolved(): void })['ensureLaunchResolved']();
}

function makeAdapter(): CopilotCliAdapter {
  return new CopilotCliAdapter({
    workingDirectory: '/w',
    copilotAccountRoute: {
      profileId: 'legacy',
      source: 'legacy',
      executionNodeId: 'local',
      profileLabel: 'Existing Copilot account',
      expectedLogin: 'octocat',
      host: 'github.com',
    },
  } as never);
}

beforeEach(() => {
  launch.current = ghLaunch;
  profileCount.current = 2;
});

describe('CopilotCliAdapter — gh copilot fallback', () => {
  it('refuses to launch through gh copilot when several profiles exist', () => {
    expect(() => resolveLaunch(makeAdapter())).toThrow(/cannot be pinned to a Copilot account profile/);
  });

  it('still allows gh copilot on a single-profile install', () => {
    // The guard must not break the pre-feature single-account setup, which has
    // no second account to leak to.
    profileCount.current = 1;
    expect(() => resolveLaunch(makeAdapter())).not.toThrow();
  });

  it('allows the standalone binary regardless of profile count', () => {
    launch.current = standaloneLaunch;
    expect(() => resolveLaunch(makeAdapter())).not.toThrow();
  });
});
