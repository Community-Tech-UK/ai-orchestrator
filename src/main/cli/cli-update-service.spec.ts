import { describe, expect, it, vi } from 'vitest';
import { CLI_UPDATE_SPECS, CliUpdateService, type CliUpdateServiceDeps } from './cli-update-service';
import type { CliInfo, CliType, DetectionResult } from './cli-detection';

function makeInfo(type: CliType, path: string, version = '1.0.0'): CliInfo {
  return {
    name: type,
    command: type,
    displayName: type,
    installed: true,
    path,
    version,
  };
}

function makeDetection(overrides: {
  all?: CliInfo[];
  installs?: Partial<Record<CliType, { path: string; version?: string }[]>>;
  one?: Partial<Record<CliType, CliInfo>>;
} = {}): CliUpdateServiceDeps['detection'] {
  const one = overrides.one ?? {};
  const all = overrides.all ?? Object.values(one);
  return {
    clearCache: vi.fn(),
    detectAll: vi.fn(async (): Promise<DetectionResult> => ({
      detected: all,
      available: all.filter((info) => info.installed),
      unavailable: all.filter((info) => !info.installed),
      timestamp: new Date(),
    })),
    detectOne: vi.fn(async (type: CliType) => one[type] ?? makeInfo(type, type)),
    scanAllCliInstalls: vi.fn(async (type: CliType) => overrides.installs?.[type] ?? []),
  };
}

describe('CliUpdateService', () => {
  it('uses the active Node install npm for Codex updates', async () => {
    const detection = makeDetection({
      one: {
        codex: makeInfo('codex', '/Users/test/.nvm/versions/node/v22/bin/codex', '0.123.0'),
      },
      installs: {
        codex: [{ path: '/Users/test/.nvm/versions/node/v22/bin/codex', version: '0.123.0' }],
      },
    });

    const service = new CliUpdateService({
      detection,
      exists: (path) => path.endsWith('/npm'),
      platform: 'darwin',
    });

    await expect(service.getUpdatePlan('codex')).resolves.toMatchObject({
      cli: 'codex',
      supported: true,
      command: '/Users/test/.nvm/versions/node/v22/bin/npm',
      args: ['install', '-g', '@openai/codex@latest'],
    });
  });

  it('does not reuse a stale detectOne version for a different scanned active path', async () => {
    const detection = makeDetection({
      one: {
        claude: makeInfo('claude', 'C:\\Users\\test\\AppData\\Roaming\\nvm\\v22.10.0\\claude.cmd', '2.1.100'),
      },
      installs: {
        claude: [
          { path: 'C:\\Program Files\\nodejs\\claude.cmd' },
          { path: 'C:\\Users\\test\\AppData\\Roaming\\nvm\\v22.10.0\\claude.cmd', version: '2.1.100' },
        ],
      },
    });

    const service = new CliUpdateService({
      detection,
      exists: (path) => path === 'C:\\Program Files\\nodejs\\claude.cmd',
      platform: 'win32',
    });

    await expect(service.getUpdatePlan('claude')).resolves.toMatchObject({
      cli: 'claude',
      activePath: 'C:\\Program Files\\nodejs\\claude.cmd',
      currentVersion: undefined,
      command: 'C:\\Program Files\\nodejs\\claude.cmd',
    });
  });

  it('uses Cursor Agent native updater', async () => {
    const detection = makeDetection({
      one: {
        cursor: makeInfo('cursor', '/Users/test/.local/bin/cursor-agent', '2026.1.0'),
      },
      installs: {
        cursor: [{ path: '/Users/test/.local/bin/cursor-agent', version: '2026.1.0' }],
      },
    });

    const service = new CliUpdateService({
      detection,
      exists: (path) => path === '/Users/test/.local/bin/cursor-agent',
      platform: 'darwin',
    });

    await expect(service.getUpdatePlan('cursor')).resolves.toMatchObject({
      cli: 'cursor',
      supported: true,
      command: '/Users/test/.local/bin/cursor-agent',
      args: ['update'],
    });
  });

  it('uses the Grok native updater and knows its npm package for latest-version checks', async () => {
    // `grok` was in SUPPORTED_CLIS with no CLI_UPDATE_SPECS entry, so CLI
    // Health answered "no automatic updater is configured" and skipped it.
    const detection = makeDetection({
      one: {
        grok: makeInfo('grok', '/Users/test/.nvm/versions/node/v24/bin/grok', '1.0.5'),
      },
      installs: {
        grok: [{ path: '/Users/test/.nvm/versions/node/v24/bin/grok', version: '1.0.5' }],
      },
    });

    const service = new CliUpdateService({
      detection,
      exists: (path) => path === '/Users/test/.nvm/versions/node/v24/bin/grok',
      platform: 'darwin',
    });

    await expect(service.getUpdatePlan('grok')).resolves.toMatchObject({
      cli: 'grok',
      supported: true,
      strategy: 'self-update',
      command: '/Users/test/.nvm/versions/node/v24/bin/grok',
      args: ['update'],
    });
    expect(CLI_UPDATE_SPECS.grok?.npmPackage).toBe('@xai-official/grok');
  });

  it('uses `opencode upgrade` and knows the opencode-ai npm package', async () => {
    const path = '/Users/test/.nvm/versions/node/v24/bin/opencode';
    const detection = makeDetection({
      one: { opencode: makeInfo('opencode', path, '1.18.29') },
      installs: { opencode: [{ path, version: '1.18.29' }] },
    });

    const service = new CliUpdateService({ detection, exists: (candidate) => candidate === path, platform: 'darwin' });

    await expect(service.getUpdatePlan('opencode')).resolves.toMatchObject({
      cli: 'opencode',
      supported: true,
      strategy: 'self-update',
      command: path,
      args: ['upgrade'],
    });
    expect(CLI_UPDATE_SPECS.opencode?.npmPackage).toBe('opencode-ai');
  });

  it('updates the selected OpenCode 2 install even when v1 is first in a scan', async () => {
    const selected = '/opt/opencode2';
    const detection = makeDetection({ one: { opencode: makeInfo('opencode', selected, '2.0.30') },
      installs: { opencode: [{ path: '/opt/opencode', version: '1.19.1' }, { path: selected, version: '2.0.30' }] } });
    const service = new CliUpdateService({ detection, exists: () => true, resolveOpenCodeLatestVersion: async () => '2.0.31' });
    await expect(service.getUpdatePlan('opencode')).resolves.toMatchObject({ command: selected, currentVersion: '2.0.30', args: ['upgrade', '2.0.31'] });
  });

  it('does not self-update an app-managed OpenCode binary', async () => {
    const path = '/Applications/OpenCode.app/Contents/Resources/opencode-cli';
    const service = new CliUpdateService({ detection: makeDetection({ one: { opencode: makeInfo('opencode', path, '2.0.30') } }), exists: () => true });
    await expect(service.getUpdatePlan('opencode')).resolves.toMatchObject({ supported: false, reason: expect.stringMatching(/desktop app/) });
  });

  it('uses the GitHub CLI extension updater when Copilot is provided by gh', async () => {
    const detection = makeDetection({
      one: {
        copilot: makeInfo('copilot', '/opt/homebrew/bin/gh', '1.0.0'),
      },
    });

    const service = new CliUpdateService({
      detection,
      platform: 'darwin',
      resolveCopilotLaunch: () => ({
        command: '/opt/homebrew/bin/gh',
        argsPrefix: ['copilot', '--'],
        displayCommand: 'gh copilot',
        path: '/opt/homebrew/bin/gh',
      }),
    });

    await expect(service.getUpdatePlan('copilot')).resolves.toMatchObject({
      cli: 'copilot',
      supported: true,
      command: '/opt/homebrew/bin/gh',
      args: ['extension', 'upgrade', 'github/gh-copilot'],
    });
  });

  it('skips app-bundled Ollama installs when no safe updater is available', async () => {
    const detection = makeDetection({
      one: {
        ollama: makeInfo('ollama', '/Applications/Ollama.app/Contents/MacOS/ollama', '0.13.0'),
      },
      installs: {
        ollama: [{ path: '/Applications/Ollama.app/Contents/MacOS/ollama', version: '0.13.0' }],
      },
    });

    const service = new CliUpdateService({ detection, platform: 'darwin' });

    await expect(service.getUpdatePlan('ollama')).resolves.toMatchObject({
      cli: 'ollama',
      supported: false,
    });
  });

  it('uses the official install script for a standalone /usr/local/bin/ollama symlink', async () => {
    const appBinary = '/Applications/Ollama.app/Contents/Resources/ollama';
    const detection = makeDetection({
      one: {
        ollama: makeInfo('ollama', '/usr/local/bin/ollama', '0.30.4'),
      },
      installs: {
        ollama: [{ path: '/usr/local/bin/ollama', version: '0.30.4' }],
      },
    });

    const service = new CliUpdateService({
      detection,
      platform: 'darwin',
      realpath: (p) => (p === '/usr/local/bin/ollama' ? appBinary : p),
    });

    await expect(service.getUpdatePlan('ollama')).resolves.toMatchObject({
      cli: 'ollama',
      supported: true,
      command: '/bin/sh',
      args: ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'],
      strategy: 'install-script',
    });
  });

  it('uses brew upgrade for a Homebrew Cellar Ollama install', async () => {
    const cellarPath = '/opt/homebrew/Cellar/ollama/0.5.0/bin/ollama';
    const detection = makeDetection({
      one: {
        ollama: makeInfo('ollama', '/opt/homebrew/bin/ollama', '0.5.0'),
      },
      installs: {
        ollama: [{ path: '/opt/homebrew/bin/ollama', version: '0.5.0' }],
      },
    });

    const service = new CliUpdateService({
      detection,
      platform: 'darwin',
      exists: (p) => p === '/opt/homebrew/bin/brew',
      realpath: (p) => (p === '/opt/homebrew/bin/ollama' ? cellarPath : p),
    });

    await expect(service.getUpdatePlan('ollama')).resolves.toMatchObject({
      cli: 'ollama',
      supported: true,
      command: '/opt/homebrew/bin/brew',
      args: ['upgrade', 'ollama'],
      strategy: 'homebrew',
    });
  });

  it('runs update commands sequentially for installed CLIs and refreshes versions', async () => {
    const detection = makeDetection({
      all: [makeInfo('codex', '/node/bin/codex', '0.123.0')],
      one: {
        codex: makeInfo('codex', '/node/bin/codex', '0.124.0'),
      },
      installs: {
        codex: [{ path: '/node/bin/codex', version: '0.123.0' }],
      },
    });
    const execFileAsync = vi.fn(async () => ({ stdout: 'updated', stderr: '' }));
    const service = new CliUpdateService({
      detection,
      execFileAsync,
      exists: (path) => path === '/node/bin/npm',
      platform: 'darwin',
    });

    const results = await service.updateAllInstalled();

    expect(execFileAsync).toHaveBeenCalledWith(
      '/node/bin/npm',
      ['install', '-g', '@openai/codex@latest'],
      expect.any(Number),
      expect.any(Object),
      'darwin',
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      cli: 'codex',
      status: 'updated',
      beforeVersion: '0.123.0',
      afterVersion: '0.124.0',
    });
  });
});


describe('OpenCode updates stay on the installed major', () => {
  const selected = '/opt/opencode2';
  it.each([null, '3.0.0', '1.19.1', '2.1', '2.0.31-preview', '2.0.31+build', '2.01.31', ' 2.0.31', '2.0.31\n', '2.0.31; echo unsafe'])('skips updates when the next stable 2.x target is not confirmed: %j', async (latest) => {
    const execute = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const service = new CliUpdateService({ detection: makeDetection({ one: { opencode: makeInfo('opencode', selected, '2.0.30') } }),
      exists: () => true, resolveOpenCodeLatestVersion: async () => latest, execFileAsync: execute });
    await expect(service.updateOne('opencode')).resolves.toMatchObject({ status: 'skipped', message: expect.stringMatching(/2\.x|same major/i) });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'unknown', '2', '2.0', '2.0.30-preview', '3.0.0', '01.0.0'])('refuses an unknown or unsupported installed version: %j', async (current) => {
    const info = { ...makeInfo('opencode', selected), version: current };
    const service = new CliUpdateService({ detection: makeDetection({ one: { opencode: info } }), exists: () => true,
      resolveOpenCodeLatestVersion: async () => '2.0.31' });
    await expect(service.getUpdatePlan('opencode')).resolves.toMatchObject({ supported: false, reason: expect.stringMatching(/installed version|version.*confirm/i) });
  });

  it.each([
    ['/opt/homebrew/Cellar/opencode-v2/2.0.30/bin/opencode', '/opt/homebrew/Cellar/opencode-v2/2.0.30/bin/opencode'],
    ['/opt/homebrew/bin/opencode2', '/opt/homebrew/Cellar/opencode-v2/2.0.30/bin/opencode'],
    ['/usr/local/bin/opencode', '/usr/local/Cellar/opencode/2.0.30/bin/opencode'],
  ])('skips Homebrew OpenCode 2 because its native updater ignores a pinned target: %s', async (path, resolved) => {
    const service = new CliUpdateService({ detection: makeDetection({ one: { opencode: makeInfo('opencode', path, '2.0.30') } }),
      exists: () => true, realpath: () => resolved, resolveOpenCodeLatestVersion: async () => '2.0.31' });
    await expect(service.getUpdatePlan('opencode')).resolves.toMatchObject({ supported: false, reason: expect.stringMatching(/Homebrew.*major|major.*Homebrew/i) });
  });

  it('resolves symlinks before deciding whether the desktop app owns the binary', async () => {
    const service = new CliUpdateService({ detection: makeDetection({ one: { opencode: makeInfo('opencode', selected, '2.0.30') } }),
      exists: () => true, realpath: () => '/Applications/OpenCode.app/Contents/Resources/opencode-cli', resolveOpenCodeLatestVersion: async () => '2.0.31' });
    await expect(service.getUpdatePlan('opencode')).resolves.toMatchObject({ supported: false, reason: expect.stringMatching(/desktop app/i) });
  });

  it('uses the selected install with a validated pinned version when running the update', async () => {
    const execute = vi.fn(async (_file: string, args: string[]) => ({ stdout: args[0] === '--version' ? 'opencode v2.0.30\n' : 'updated', stderr: '' }));
    const detection = makeDetection({ one: { opencode: makeInfo('opencode', selected, '2.0.30') }, installs: { opencode: [{ path: '/opt/opencode', version: '1.19.1' }] } });
    const service = new CliUpdateService({ detection, exists: () => true, realpath: path => path, resolveOpenCodeLatestVersion: async () => 'v2.0.31', execFileAsync: execute });
    await expect(service.updateOne('opencode')).resolves.toMatchObject({ status: 'updated', beforeVersion: '2.0.30' });
    expect(execute).toHaveBeenCalledWith(selected, ['upgrade', '2.0.31'], expect.any(Number), expect.any(Object), expect.any(String));
    expect(execute.mock.calls.map(([file, args]) => [file, args])).toEqual([[selected, ['--version']], [selected, ['upgrade', '2.0.31']]]);
  });

  it('fails closed during update all when the version lookup fails', async () => {
    const execute = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const service = new CliUpdateService({ detection: makeDetection({ one: { opencode: makeInfo('opencode', selected, '2.0.30') } }), exists: () => true,
      resolveOpenCodeLatestVersion: async () => { throw new Error('registry unavailable'); }, execFileAsync: execute });
    await expect(service.updateAllInstalled()).resolves.toEqual([expect.objectContaining({ cli: 'opencode', status: 'skipped' })]);
    expect(execute).not.toHaveBeenCalled();
  });
});


describe('OpenCode 2 updates do not downgrade the active install', () => {
  it.each([['2.0.30', '2.0.29'], ['2.1.0', '2.0.40']])('skips an older target %s -> %s', async (current, latest) => {
    const execute = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const service = new CliUpdateService({ detection: makeDetection({ one: { opencode: makeInfo('opencode', '/opt/opencode2', current) } }),
      exists: () => true, resolveOpenCodeLatestVersion: async () => latest, execFileAsync: execute });
    await expect(service.updateOne('opencode')).resolves.toMatchObject({ status: 'skipped', message: expect.stringMatching(/older|downgrade/i) });
    expect(execute).not.toHaveBeenCalled();
  });
  it('compares numeric version parts rather than text ordering', async () => {
    const service = new CliUpdateService({ detection: makeDetection({ one: { opencode: makeInfo('opencode', '/opt/opencode2', '2.0.99') } }),
      exists: () => true, resolveOpenCodeLatestVersion: async () => '2.0.100' });
    await expect(service.getUpdatePlan('opencode')).resolves.toMatchObject({ supported: true, args: ['upgrade', '2.0.100'] });
  });
});
