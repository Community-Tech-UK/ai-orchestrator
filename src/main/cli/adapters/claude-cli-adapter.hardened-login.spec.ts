import { tmpdir } from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const prepareMock = vi.hoisted(() => vi.fn());
vi.mock('./claude-hardened-login', () => ({
  prepareHardenedClaudeLoginEnv: (...args: unknown[]) => prepareMock(...args),
}));

import { ClaudeCliAdapter } from './claude-cli-adapter';

interface HandOffInternals {
  prepareHardenedLogin(): Promise<void>;
  hardenedSpawnEnv(env: NodeJS.ProcessEnv): Record<string, string> | undefined;
  buildSpawnEnv(): NodeJS.ProcessEnv;
}

function internals(adapter: ClaudeCliAdapter): HandOffInternals {
  return adapter as unknown as HandOffInternals;
}

describe('ClaudeCliAdapter hardened login hand-off', () => {
  const handedIn = { CLAUDE_CODE_OAUTH_TOKEN: 'handed-in-placeholder' };

  beforeEach(() => {
    prepareMock.mockReset();
    prepareMock.mockResolvedValue(handedIn);
  });

  it('does nothing for a session that is not hardened', async () => {
    const adapter = new ClaudeCliAdapter({ workingDirectory: tmpdir() });

    await internals(adapter).prepareHardenedLogin();

    expect(prepareMock).not.toHaveBeenCalled();
    expect(internals(adapter).hardenedSpawnEnv(internals(adapter).buildSpawnEnv())).toBeUndefined();
  });

  it('reads the login for the config dir the spawn will use and hands it in', async () => {
    const adapter = new ClaudeCliAdapter({ workingDirectory: tmpdir() });
    adapter.configureHardenedMode({ writableRoots: [tmpdir()] });
    const env = internals(adapter).buildSpawnEnv();

    await internals(adapter).prepareHardenedLogin();

    expect(prepareMock).toHaveBeenCalledWith(env['CLAUDE_CONFIG_DIR']);
    expect(internals(adapter).hardenedSpawnEnv(env)).toEqual(handedIn);
  });

  it('withholds the login when the spawn resolves a different config dir from the one read', async () => {
    const adapter = new ClaudeCliAdapter({ workingDirectory: tmpdir() });
    adapter.configureHardenedMode({ writableRoots: [tmpdir()] });
    await internals(adapter).prepareHardenedLogin();

    expect(internals(adapter).hardenedSpawnEnv({ CLAUDE_CONFIG_DIR: '/some/other/profile' })).toBeUndefined();
  });

  it('hands in nothing when no login could be prepared', async () => {
    prepareMock.mockResolvedValue(null);
    const adapter = new ClaudeCliAdapter({ workingDirectory: tmpdir() });
    adapter.configureHardenedMode({ writableRoots: [tmpdir()] });

    await internals(adapter).prepareHardenedLogin();

    expect(internals(adapter).hardenedSpawnEnv(internals(adapter).buildSpawnEnv())).toBeUndefined();
  });
});
