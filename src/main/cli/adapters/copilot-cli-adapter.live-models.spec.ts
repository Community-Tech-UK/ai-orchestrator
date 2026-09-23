/**
 * `help config` is a roster compiled into the CLI build, so it lags GitHub
 * (2026-09-23: no `claude-opus-5.5` / `gpt-6-sol` while seats served both).
 * A routed adapter therefore adds the account's live roster; an unrouted one
 * must not, because that request is authenticated (spec §10.3).
 */
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const liveListMock = vi.hoisted(() => vi.fn<(options: { homeDir: string; host?: string }) => Promise<string[]>>());

vi.mock('./copilot/copilot-live-model-list', () => ({
  listCopilotLiveModelIds: liveListMock,
}));

vi.mock('./copilot/copilot-account-home-resolver', () => ({
  resolveCopilotProfileHome: (profileId: string) => `/state/copilot-cli-profiles/${profileId}`,
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

import { CopilotCliAdapter, resetCopilotModelDiscoveryCache } from './copilot-cli-adapter';

const HELP_CONFIG = `
  \`model\`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.
    - "claude-sonnet-5"
    - "claude-opus-5"

  \`contextTier\`: context window tier.
`;

/** A fake `copilot help config` child that exits with the given output. */
function stubHelpConfig(adapter: CopilotCliAdapter, stdout: string, code = 0) {
  return vi
    .spyOn(adapter as unknown as { spawnProcess(args: string[]): unknown }, 'spawnProcess')
    .mockImplementation(() => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        pid: undefined,
        kill: vi.fn(),
      });
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from(stdout));
        proc.emit('close', code);
      });
      return proc;
    });
}

function ids(models: { id: string }[]): string[] {
  return models.map((model) => model.id);
}

beforeEach(() => {
  resetCopilotModelDiscoveryCache();
  liveListMock.mockReset();
});

afterEach(() => {
  resetCopilotModelDiscoveryCache();
});

describe('CopilotCliAdapter.listAvailableModels live roster', () => {
  it('adds live-only ids for a routed profile, queried under that profile home and host', async () => {
    liveListMock.mockResolvedValue(['claude-opus-5', 'claude-opus-5.5', 'gpt-6-sol']);
    const adapter = new CopilotCliAdapter({ accountProfileId: 'enterprise', accountHost: 'ebrd.ghe.com' });
    stubHelpConfig(adapter, HELP_CONFIG);

    const models = ids(await adapter.listAvailableModels({ fallbackToStatic: false }));

    expect(liveListMock).toHaveBeenCalledWith({
      homeDir: '/state/copilot-cli-profiles/enterprise',
      host: 'ebrd.ghe.com',
    });
    // help config order, then live-only ids, then the static catalog.
    expect(models.slice(0, 4)).toEqual(['claude-sonnet-5', 'claude-opus-5', 'claude-opus-5.5', 'gpt-6-sol']);
    expect(models).toContain('auto');
  });

  it('never makes the authenticated request for an unrouted probe', async () => {
    const adapter = new CopilotCliAdapter();
    stubHelpConfig(adapter, HELP_CONFIG);

    const models = ids(await adapter.listAvailableModels({ fallbackToStatic: false }));

    expect(liveListMock).not.toHaveBeenCalled();
    expect(models).toContain('claude-sonnet-5');
    expect(models).not.toContain('claude-opus-5.5');
  });

  it('keeps the help config roster when the live roster fails', async () => {
    liveListMock.mockRejectedValue(new Error('403 Forbidden'));
    const adapter = new CopilotCliAdapter({ accountProfileId: 'personal' });
    stubHelpConfig(adapter, HELP_CONFIG);

    const models = ids(await adapter.listAvailableModels({ fallbackToStatic: false }));

    expect(models).toEqual(expect.arrayContaining(['claude-sonnet-5', 'claude-opus-5']));
  });

  it('uses the live roster when help config cannot be parsed', async () => {
    liveListMock.mockResolvedValue(['gpt-6-sol']);
    const adapter = new CopilotCliAdapter({ accountProfileId: 'enterprise' });
    stubHelpConfig(adapter, 'unexpected output', 0);

    const models = ids(await adapter.listAvailableModels({ fallbackToStatic: false }));

    expect(models).toContain('gpt-6-sol');
  });

  it('still rejects for catalog discovery when neither source produced a roster', async () => {
    liveListMock.mockResolvedValue([]);
    const adapter = new CopilotCliAdapter({ accountProfileId: 'enterprise' });
    stubHelpConfig(adapter, '', 1);

    await expect(adapter.listAvailableModels({ fallbackToStatic: false })).rejects.toThrow(
      'Failed to parse Copilot model list (exit 1)',
    );
  });

  it('caches per profile, so one seat’s roster is never served to another', async () => {
    liveListMock.mockImplementation(async ({ homeDir }) =>
      homeDir.endsWith('/enterprise') ? ['claude-opus-5.5'] : [],
    );
    const enterprise = new CopilotCliAdapter({ accountProfileId: 'enterprise' });
    const personal = new CopilotCliAdapter({ accountProfileId: 'personal' });
    stubHelpConfig(enterprise, HELP_CONFIG);
    stubHelpConfig(personal, HELP_CONFIG);

    expect(ids(await enterprise.listAvailableModels({ fallbackToStatic: false }))).toContain('claude-opus-5.5');
    expect(ids(await personal.listAvailableModels({ fallbackToStatic: false }))).not.toContain('claude-opus-5.5');
  });
});
