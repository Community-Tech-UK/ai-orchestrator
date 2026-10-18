import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliAdapter } from '../adapter-factory';
import {
  _resetHardenedModeScopingForTesting,
  setInstanceHardened,
} from '../../../instance/lifecycle/hardened-mode-scoping';

describe('adapter factory — hardened remote execution', () => {
  const logFixtures: string[] = [];
  beforeEach(() => _resetHardenedModeScopingForTesting());
  afterEach(() => {
    _resetHardenedModeScopingForTesting();
    vi.unstubAllEnvs();
    for (const directory of logFixtures.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('fails closed before constructing a remote adapter for a hardened instance', () => {
    setInstanceHardened('hardened-remote', true);

    expect(() => createCliAdapter(
      'claude',
      {
        instanceId: 'hardened-remote',
        workingDirectory: '/tmp',
      },
      {
        type: 'remote',
        nodeId: 'worker-node',
      },
    )).toThrow('Hardened mode is not supported for remote instances');
  });

  it('refuses the legacy gemini CLI, which was never run jailed', () => {
    setInstanceHardened('hardened-gemini', true);

    expect(() => createCliAdapter('gemini', {
      instanceId: 'hardened-gemini',
      workingDirectory: '/tmp',
    })).toThrow('Hardened mode is not supported for Gemini yet');
  });

  // Hardened probe 2026-09-28: each completed a jailed turn with these grants.
  it.each([
    ['codex', []],
    ['antigravity', []],
    ['grok', ['.grok']],
    ['opencode', ['.local/share/opencode', '.config/opencode', '.cache/opencode', '.local/state/opencode']],
    ['cursor', ['.cursor']],
  ] as const)('builds a hardened %s adapter with only its own extra roots', (cliType, extra) => {
    setInstanceHardened(`hardened-${cliType}`, true);

    const adapter = createCliAdapter(cliType, {
      instanceId: `hardened-${cliType}`,
      workingDirectory: '/tmp/hardened-ws',
    }) as unknown as { hardenedMode: { writableRoots: string[] } | null };

    const roots = adapter.hardenedMode?.writableRoots ?? [];
    expect(roots).toContain('/tmp/hardened-ws');
    for (const relative of extra) expect(roots).toContain(path.join(os.homedir(), relative));
    // Another provider's private state stays read-only.
    if (cliType !== 'grok') expect(roots).not.toContain(path.join(os.homedir(), '.grok'));
  });

  it('grants a routed hardened Copilot session its own account home, and not another provider\'s state', () => {
    const copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-copilot-home-'));
    vi.stubEnv('AI_ORCHESTRATOR_COPILOT_HOME', copilotHome);
    setInstanceHardened('hardened-copilot', true);

    const adapter = createCliAdapter('copilot', {
      instanceId: 'hardened-copilot',
      workingDirectory: '/tmp/hardened-ws',
      copilotAccountRoute: { profileId: 'legacy', source: 'legacy', executionNodeId: 'local' },
    } as never) as unknown as {
      hardenedMode: { writableRoots: string[] } | null;
      getConfig(): { env?: Record<string, string> };
    };

    expect(adapter.getConfig().env?.['COPILOT_HOME']).toBe(copilotHome);
    expect(adapter.hardenedMode?.writableRoots).toContain(copilotHome);
    expect(adapter.hardenedMode?.writableRoots).not.toContain(path.join(os.homedir(), '.grok'));
  });

  it('still builds a hardened local Claude adapter', () => {
    setInstanceHardened('hardened-claude', true);

    const adapter = createCliAdapter('claude', {
      instanceId: 'hardened-claude',
      workingDirectory: '/tmp',
    }) as unknown as { hardenedMode: { writableRoots: string[] } | null };

    expect(adapter.hardenedMode?.writableRoots).toContain('/tmp');
  });

  it('keeps hardened mode a no-op for the tool-free Ollama adapter', () => {
    setInstanceHardened('hardened-ollama', true);

    const adapter = createCliAdapter('ollama', {
      instanceId: 'hardened-ollama',
      workingDirectory: '/tmp',
    }) as unknown as { hardenedMode: { writableRoots: string[] } | null };

    expect(adapter.hardenedMode).toBeNull();
  });

  it('still builds a non-hardened local Codex adapter', () => {
    expect(() => createCliAdapter('codex', {
      instanceId: 'plain-codex',
      workingDirectory: '/tmp',
    })).not.toThrow();
  });

  it.each(['codex', 'claude'] as const)('prepares and grants only the %s session browser log directory', (cliType) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'hardened-browser-logs-'));
    logFixtures.push(fixture);
    const userData = path.join(fixture, 'user-data');
    const logRoot = path.join(userData, 'browser-forwarders');
    const logDirectory = path.join(logRoot, 'current-session');
    setInstanceHardened('current-session', true);

    const adapter = createCliAdapter(cliType, {
      instanceId: 'current-session',
      workingDirectory: '/tmp/hardened-ws',
      browserGatewayMcp: {
        instanceId: 'current-session',
        aioMcpCliPath: '/placeholder/aio-mcp',
        socketPath: '/placeholder/browser.sock',
        logDirectory,
        exists: () => true,
      },
    }) as unknown as { hardenedMode: { writableRoots: string[] } | null };

    expect(fs.statSync(logDirectory).isDirectory()).toBe(true);
    const roots = adapter.hardenedMode?.writableRoots ?? [];
    expect(roots).toContain(logDirectory);
    expect(roots).not.toContain(logRoot);
    expect(roots).not.toContain(userData);
    expect(roots).not.toContain(path.join(logRoot, 'another-session'));
  });

  it('does not add a browser log grant when no bridge is configured', () => {
    setInstanceHardened('no-browser', true);
    const adapter = createCliAdapter('codex', {
      instanceId: 'no-browser',
      workingDirectory: '/tmp/hardened-ws',
    }) as unknown as { hardenedMode: { writableRoots: string[] } | null };

    expect(adapter.hardenedMode?.writableRoots).not.toContainEqual(expect.stringContaining('browser-forwarders'));
  });
});
