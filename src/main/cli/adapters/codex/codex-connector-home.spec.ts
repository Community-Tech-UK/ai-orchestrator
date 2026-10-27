import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexCliAdapter } from '../codex-cli-adapter';
import '../codex-cli-adapter.test-helpers';

describe('Codex connector home at runtime', () => {
  const fixtures: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
  });

  it.each([
    { appServerAvailable: true, failsInitialization: false, retainsUser: true },
    { appServerAvailable: false, failsInitialization: false, retainsUser: false },
    { appServerAvailable: true, failsInitialization: true, retainsUser: false },
  ])('keeps injected connectors and applies the correct user-server policy: %j', async (mode) => {
    const fixture = mkdtempSync(join(tmpdir(), 'codex-connectors-spec-'));
    fixtures.push(fixture);
    mkdirSync(join(fixture, '.codex'));
    writeFileSync(join(fixture, '.codex', 'config.toml'), '[mcp_servers.user]\ncommand = "PLACEHOLDER_USER"');
    vi.stubEnv('HOME', fixture);
    const adapter = new CodexCliAdapter({ mcpServersConfigToml: '[mcp_servers.connector]\ncommand = "PLACEHOLDER_CONNECTOR"' });
    const access = adapter as unknown as {
      initAppServerMode(): Promise<void>;
      config: { env: Record<string, string> };
      cleanupCodexHome(): void;
    };
    vi.spyOn(adapter, 'checkStatus').mockResolvedValue({
      available: true, authenticated: true, path: 'codex', metadata: { appServerAvailable: mode.appServerAvailable },
    });
    vi.spyOn(access, 'initAppServerMode').mockImplementation(async () => {
      if (mode.failsInitialization) throw new Error('PLACEHOLDER_INITIALIZATION_FAILURE');
    });
    try {
      await adapter.spawn();
      const config = readFileSync(join(access.config.env['CODEX_HOME']!, 'config.toml'), 'utf8');
      expect(config).toContain('PLACEHOLDER_CONNECTOR');
      expect(config.includes('PLACEHOLDER_USER')).toBe(mode.retainsUser);
    } finally { access.cleanupCodexHome(); }
  });
});
