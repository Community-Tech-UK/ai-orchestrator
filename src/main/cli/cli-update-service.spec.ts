import { describe, expect, it, vi } from 'vitest';
import { CliUpdateService, type CliUpdateServiceDeps } from './cli-update-service';
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
