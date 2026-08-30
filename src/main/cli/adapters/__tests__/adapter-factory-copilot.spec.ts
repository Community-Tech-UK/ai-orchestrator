import { readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliAdapter, getCliDisplayName, mapSettingsToDetectionType } from '../adapter-factory';
import { PermissionRegistry } from '../../../orchestration/permission-registry';
import { CHROME_DEVTOOLS_MCP_VERSION } from '../../../browser-gateway/chrome-devtools-mcp-config';
import type { CliAdapterConfig } from '../base-cli-adapter.types';
import type { ResolvedCopilotAccountRoute } from '../../../../shared/types/copilot-account.types';

/**
 * Every Copilot spawn now requires a resolved account route — the factory
 * fails closed without one (see `requireCopilotAccountRoute`). These tests use
 * the legacy profile, whose home is the pre-existing `copilot-cli-home`
 * directory, so the isolation assertions below stay byte-identical to the
 * pre-routing behaviour.
 */
function legacyRoute(
  overrides: Partial<ResolvedCopilotAccountRoute> = {},
): ResolvedCopilotAccountRoute {
  return {
    profileId: 'legacy',
    source: 'legacy',
    executionNodeId: 'local',
    profileLabel: 'Existing Copilot account',
    expectedLogin: 'octocat',
    host: 'github.com',
    ...overrides,
  };
}

const CHROME_DEVTOOLS_MCP_PACKAGE = `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`;

describe('adapter factory — copilot', () => {
  const testCopilotHome = join(tmpdir(), 'ai-orchestrator-test-copilot-home');
  const testAioMcp = '/tmp/aio-mcp';
  const originalOrchestratorCopilotHome = process.env['AI_ORCHESTRATOR_COPILOT_HOME'];
  const originalCopilotHome = process.env['COPILOT_HOME'];

  function browserGatewayMcp(provider?: string) {
    return {
      aioMcpCliPath: testAioMcp,
      socketPath: '/tmp/browser-gateway.sock',
      instanceId: 'instance-browser',
      ...(provider ? { provider } : {}),
      exists: () => true,
    };
  }

  // Not every `CliAdapter` union member exposes `getConfig()` (e.g. RemoteCliAdapter),
  // but every adapter constructed in this file (copilot/gemini/cursor) does.
  function configOf(adapter: ReturnType<typeof createCliAdapter>): CliAdapterConfig {
    return (adapter as unknown as { getConfig(): CliAdapterConfig }).getConfig();
  }

  function readAdditionalMcpConfig(adapter: ReturnType<typeof createCliAdapter>) {
    const args = configOf(adapter).args ?? [];
    const configIdx = args.indexOf('--additional-mcp-config');
    expect(configIdx).toBeGreaterThanOrEqual(0);
    return JSON.parse(args[configIdx + 1]);
  }

  beforeEach(() => {
    process.env['AI_ORCHESTRATOR_COPILOT_HOME'] = testCopilotHome;
    delete process.env['COPILOT_HOME'];
  });

  afterEach(() => {
    if (originalOrchestratorCopilotHome === undefined) {
      delete process.env['AI_ORCHESTRATOR_COPILOT_HOME'];
    } else {
      process.env['AI_ORCHESTRATOR_COPILOT_HOME'] = originalOrchestratorCopilotHome;
    }

    if (originalCopilotHome === undefined) {
      delete process.env['COPILOT_HOME'];
    } else {
      process.env['COPILOT_HOME'] = originalCopilotHome;
    }
  });

  it('getCliDisplayName returns GitHub Copilot', () => {
    expect(getCliDisplayName('copilot')).toBe('GitHub Copilot');
  });

  it('mapSettingsToDetectionType accepts copilot', () => {
    expect(mapSettingsToDetectionType('copilot')).toBe('copilot');
  });

  it('createCliAdapter(copilot, ...) instantiates AcpCliAdapter with a copilot provider name', () => {
    const adapter = createCliAdapter('copilot', { workingDirectory: '/tmp', copilotAccountRoute: legacyRoute() });
    expect(adapter.constructor.name).toBe('AcpCliAdapter');
    expect(adapter.getName()).toBe('copilot-acp');
  });

  it('passes resume session options through to the ACP adapter', () => {
    const adapter = createCliAdapter('copilot', {
      copilotAccountRoute: legacyRoute(),
      workingDirectory: '/tmp',
      resume: true,
      sessionId: 'copilot-session-1',
    });

    expect((adapter as unknown as {
      acpConfig: { resume?: boolean; sessionId?: string };
    }).acpConfig).toMatchObject({
      resume: true,
      sessionId: 'copilot-session-1',
    });
  });

  it('passes --model <id> to the copilot subprocess when a model is specified', () => {
    // Regression: AcpCliAdapter silently dropped options.model, leaving the
    // copilot subprocess on its own default model while the orchestrator UI
    // showed the user's selection.
    const adapter = createCliAdapter('copilot', {
      copilotAccountRoute: legacyRoute(),
      workingDirectory: '/tmp',
      model: 'claude-opus-4.7',
    });
    const args = configOf(adapter).args ?? [];
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe('claude-opus-4.7');
    // Core ACP flags must still be present.
    expect(args).toContain('--acp');
    expect(args).toContain('--stdio');
  });

  it('disables Copilot ask_user in ACP mode so prompt turns stay autonomous', () => {
    const adapter = createCliAdapter('copilot', { workingDirectory: '/tmp', copilotAccountRoute: legacyRoute() });
    const args = configOf(adapter).args ?? [];
    expect(args).toContain('--no-ask-user');
  });

  it('isolates Copilot CLI state from the default VS Code-visible Copilot home', () => {
    const adapter = createCliAdapter('copilot', { workingDirectory: '/tmp', copilotAccountRoute: legacyRoute() });
    const args = configOf(adapter).args ?? [];
    const configDirIdx = args.indexOf('--config-dir');
    expect(configDirIdx).toBeGreaterThanOrEqual(0);
    expect(args[configDirIdx + 1]).toBe(testCopilotHome);
    expect(args).toContain('--no-remote');

    const env = configOf(adapter).env ?? {};
    expect(env['COPILOT_HOME']).toBe(testCopilotHome);
  });

  it('applies the profile home even when ephemeral is false', () => {
    // `ephemeral: false` used to drop --config-dir and COPILOT_HOME entirely,
    // sending the child to ~/.copilot — an account this app never resolved.
    // It now controls only the --no-remote session-visibility flag.
    const adapter = createCliAdapter('copilot', {
      copilotAccountRoute: legacyRoute(),
      workingDirectory: '/tmp',
      ephemeral: false,
    });
    const args = configOf(adapter).args ?? [];
    const env = configOf(adapter).env ?? {};
    const configDirIdx = args.indexOf('--config-dir');
    expect(configDirIdx).toBeGreaterThanOrEqual(0);
    expect(args[configDirIdx + 1]).toBe(testCopilotHome);
    expect(env['COPILOT_HOME']).toBe(testCopilotHome);
    expect(args).not.toContain('--no-remote');
  });


  it('fails closed when no account route was resolved', () => {
    // The factory is synchronous and routing needs git/fs I/O, so resolution
    // happens in attachCopilotRoute(). A missing route means a spawn path
    // escaped the resolver — running Copilot under an unknown account is the
    // exact failure this feature exists to prevent.
    expect(() => createCliAdapter('copilot', { workingDirectory: '/tmp' })).toThrow(
      /without a resolved account profile \(local spawn\)/,
    );
  });

  it('strips every ambient GitHub token variable from the child environment', () => {
    const tokenVars = [
      'COPILOT_GITHUB_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GITHUB_COPILOT_GITHUB_TOKEN',
      'GITHUB_COPILOT_API_TOKEN',
      'GITHUB_TOKEN_VARNAME',
    ];
    const saved: Record<string, string | undefined> = {};
    for (const key of tokenVars) {
      saved[key] = process.env[key];
      process.env[key] = 'placeholder-not-a-real-token';
    }
    try {
      const adapter = createCliAdapter('copilot', {
        copilotAccountRoute: legacyRoute(),
        workingDirectory: '/tmp',
        // A caller-supplied env is layered over the sanitized base by
        // mergeSpawnEnv, so it must be re-stripped too.
        env: { GITHUB_TOKEN: 'placeholder-not-a-real-token', KEEP_ME: '1' },
      });
      const env = configOf(adapter).env ?? {};
      for (const key of tokenVars) {
        expect(env[key], key).toBeUndefined();
      }
      expect(env['KEEP_ME']).toBe('1');
      // Absence from `config.env` is NOT enough, and asserting only that is how
      // this shipped broken: `config.env` is an overlay spread over the ambient
      // safe env, which allowlists GITHUB_TOKEN/GH_TOKEN through. Only
      // `envRemove` — applied by the base adapter AFTER that merge — actually
      // keeps them out of the child. See copilot-acp-spawn-env.spec.ts for the
      // spawn-level proof.
      const envRemove = configOf(adapter).envRemove ?? [];
      for (const key of tokenVars) {
        expect(envRemove, `${key} must be in envRemove`).toContain(key);
      }
      // The openssl-ca workaround must survive the sanitization.
      expect(env['NODE_OPTIONS']).toMatch(/--use-openssl-ca/);
    } finally {
      for (const key of tokenVars) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
  });

  it('sets COPILOT_GH_HOST from the profile so an ambient GH_HOST cannot retarget Copilot', () => {
    const originalGhHost = process.env['GH_HOST'];
    process.env['GH_HOST'] = 'ghe.attacker.example';
    try {
      const adapter = createCliAdapter('copilot', {
        copilotAccountRoute: legacyRoute({ host: 'ghe.example.com' }),
        workingDirectory: '/tmp',
      });
      const env = configOf(adapter).env ?? {};
      // githubGetHost(COPILOT_GH_HOST, GH_HOST) — the higher-priority variable
      // is what wins, so GH_HOST is left alone deliberately.
      expect(env['COPILOT_GH_HOST']).toBe('ghe.example.com');
    } finally {
      if (originalGhHost === undefined) {
        delete process.env['GH_HOST'];
      } else {
        process.env['GH_HOST'] = originalGhHost;
      }
    }
  });

  it('omits --model when no model is specified so copilot uses its configured default', () => {
    const adapter = createCliAdapter('copilot', { workingDirectory: '/tmp', copilotAccountRoute: legacyRoute() });
    const args = configOf(adapter).args ?? [];
    expect(args).not.toContain('--model');
  });

  it('preserves the literal "auto" sentinel when model === "auto"', () => {
    const adapter = createCliAdapter('copilot', {
      copilotAccountRoute: legacyRoute(),
      workingDirectory: '/tmp',
      model: 'auto',
    });
    const args = configOf(adapter).args ?? [];
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe('auto');
  });

  it('wires the PermissionRegistry singleton into the ACP adapter', () => {
    // Regression: without this wiring the Copilot ACP agent's
    // session/request_permission RPCs have no timeout and the prompt turn
    // hangs forever if the UI doesn't surface the permission dialog.
    PermissionRegistry._resetForTesting();
    const registry = PermissionRegistry.getInstance();

    const adapter = createCliAdapter('copilot', {
      copilotAccountRoute: legacyRoute(),
      workingDirectory: '/tmp',
      instanceId: 'inst-wiring-test',
    });

    // The adapter stashes the registry and context in its private config; we
    // exercise the observable contract: a permission request routed through
    // the registry should be picked up by the adapter's handler. The shape is
    // already covered exhaustively in acp-cli-adapter.spec.ts — here we only
    // verify the factory plumbed it through at all.
    expect((adapter as unknown as {
      acpConfig: { permissionRegistry: unknown; permissionContext: { instanceId: string } };
    }).acpConfig.permissionRegistry).toBe(registry);
    expect((adapter as unknown as {
      acpConfig: { permissionContext: { instanceId: string } };
    }).acpConfig.permissionContext.instanceId).toBe('inst-wiring-test');

    PermissionRegistry._resetForTesting();
  });

  it('falls back to an ephemeral instanceId when none is supplied', () => {
    PermissionRegistry._resetForTesting();

    const adapter = createCliAdapter('copilot', { workingDirectory: '/tmp', copilotAccountRoute: legacyRoute() });
    const instanceId = (adapter as unknown as {
      acpConfig: { permissionContext: { instanceId: string } };
    }).acpConfig.permissionContext.instanceId;

    expect(instanceId).toMatch(/^acp-ephemeral-copilot-/);

    PermissionRegistry._resetForTesting();
  });

  it('injects --use-openssl-ca into NODE_OPTIONS to avoid the macOS keychain SIGSEGV', () => {
    // Regression: Copilot children were crashing in
    // node::crypto::ReadMacOSKeychainCertificates on macOS 26.
    // The factory now always prepends the --use-openssl-ca flag.
    const adapter = createCliAdapter('copilot', { workingDirectory: '/tmp', copilotAccountRoute: legacyRoute() });
    const env = configOf(adapter).env ?? {};
    expect(env['NODE_OPTIONS']).toMatch(/--use-openssl-ca/);
  });

  it('passes Browser Gateway MCP config to Copilot through --additional-mcp-config', () => {
    const adapter = createCliAdapter('copilot', {
      copilotAccountRoute: legacyRoute(),
      workingDirectory: '/tmp',
      instanceId: 'instance-browser',
      browserGatewayMcp: browserGatewayMcp(),
    });

    const config = readAdditionalMcpConfig(adapter);
    const browserGateway = config.mcpServers['browser-gateway'];

    expect(browserGateway).toMatchObject({
      command: testAioMcp,
      args: ['browser-gateway'],
      env: {
        AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: '/tmp/browser-gateway.sock',
        AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: 'instance-browser',
        AI_ORCHESTRATOR_BROWSER_PROVIDER: 'copilot',
      },
    });
    expect((adapter as unknown as {
      acpConfig: { mcpServers?: { name: string }[] };
    }).acpConfig.mcpServers).toEqual([]);
  });

  it('passes inline Orchestrator Tools MCP config to Copilot through --additional-mcp-config', () => {
    const adapter = createCliAdapter('copilot', {
      copilotAccountRoute: legacyRoute(),
      workingDirectory: '/tmp',
      instanceId: 'instance-tools',
      mcpConfig: [
        JSON.stringify({
          mcpServers: {
            orchestrator: {
              command: testAioMcp,
              args: ['orchestrator-tools'],
              env: {
                AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: '/tmp/orchestrator-tools.sock',
                AI_ORCHESTRATOR_INSTANCE_ID: 'instance-tools',
              },
            },
          },
        }),
      ],
    });

    const config = readAdditionalMcpConfig(adapter);
    expect(config.mcpServers.orchestrator).toEqual({
      command: testAioMcp,
      args: ['orchestrator-tools'],
      env: {
        AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: '/tmp/orchestrator-tools.sock',
        AI_ORCHESTRATOR_INSTANCE_ID: 'instance-tools',
      },
    });
  });

  it('passes chrome-devtools attach config to Copilot through --additional-mcp-config', () => {
    // chrome-devtools' command is `npx` on POSIX and `cmd /c npx` on Windows;
    // pin POSIX so the canonical command is asserted regardless of host.
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const adapter = createCliAdapter('copilot', {
        copilotAccountRoute: legacyRoute(),
        workingDirectory: '/tmp',
        instanceId: 'instance-browser',
        chromeDevtoolsMcp: { browserUrl: 'http://127.0.0.1:31234' },
      });

      const config = readAdditionalMcpConfig(adapter);
      expect(config.mcpServers['chrome-devtools']).toMatchObject({
        command: 'npx',
        args: ['-y', CHROME_DEVTOOLS_MCP_PACKAGE, '--browserUrl', 'http://127.0.0.1:31234'],
      });
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('adds the chrome-devtools attach workflow guidance to the system prompt when attach is set', () => {
    const adapter = createCliAdapter('copilot', {
      copilotAccountRoute: legacyRoute(),
      workingDirectory: '/tmp',
      instanceId: 'instance-browser',
      systemPrompt: 'Base instructions.',
      chromeDevtoolsMcp: { browserUrl: 'http://127.0.0.1:31234' },
    });

    const systemPrompt = (adapter as unknown as {
      acpConfig: { systemPrompt?: string };
    }).acpConfig.systemPrompt ?? '';

    expect(systemPrompt).toContain('Base instructions.');
    expect(systemPrompt).toContain('chrome-devtools attached to a managed browser profile');
    expect(systemPrompt).toContain('open and sign into the managed profile');
  });

  it('adds Browser Gateway usage guidance to provider system prompts when browser tools are enabled', () => {
    const adapter = createCliAdapter('copilot', {
      copilotAccountRoute: legacyRoute(),
      workingDirectory: '/tmp',
      instanceId: 'instance-browser',
      systemPrompt: 'Base instructions.',
      browserGatewayMcp: browserGatewayMcp(),
    });

    const systemPrompt = (adapter as unknown as {
      acpConfig: { systemPrompt?: string };
    }).acpConfig.systemPrompt ?? '';

    expect(systemPrompt).toContain('Base instructions.');
    expect(systemPrompt).toContain('browser.find_or_open');
    expect(systemPrompt).toContain('authenticated Chrome tabs');
    expect(systemPrompt).toContain('Do not use Browser Gateway managed profiles for authenticated user sessions.');
    expect(systemPrompt).toContain('ask the user to share the current tab');
    expect(systemPrompt).toContain('Do not tell the user to open /browser');
    expect(systemPrompt).toContain('browser.query_elements');
    expect(systemPrompt).toContain('chrome-devtools.*');
    expect(systemPrompt).toContain('cannot see the user\'s shared authenticated tabs');
  });

  it('merges caller-provided Copilot MCP servers with Browser Gateway', () => {
    const adapter = createCliAdapter('copilot', {
      copilotAccountRoute: legacyRoute(),
      workingDirectory: '/tmp',
      mcpServers: [
        {
          name: 'existing',
          command: 'node',
          args: ['existing.js'],
          env: [{ name: 'EXISTING_ENV', value: '1' }],
        },
      ],
      browserGatewayMcp: browserGatewayMcp(),
    });

    const config = readAdditionalMcpConfig(adapter);

    expect(Object.keys(config.mcpServers)).toEqual(['existing', 'browser-gateway']);
    expect(config.mcpServers.existing).toEqual({
      command: 'node',
      args: ['existing.js'],
      env: { EXISTING_ENV: '1' },
    });
  });

  it('passes Browser Gateway MCP config to Codex through generated TOML', () => {
    const adapter = createCliAdapter('codex', {
      workingDirectory: '/tmp',
      instanceId: 'instance-browser',
      browserGatewayMcp: browserGatewayMcp('codex'),
    });

    const mcpConfigToml = (adapter as unknown as {
      cliConfig: { mcpServersConfigToml?: string };
    }).cliConfig.mcpServersConfigToml;

    expect(mcpConfigToml).toContain('[mcp_servers."browser-gateway"]');
    expect(mcpConfigToml).toContain('AI_ORCHESTRATOR_BROWSER_PROVIDER = "codex"');
  });

  it('passes Browser Gateway MCP config to Gemini through a temporary system settings file', () => {
    const adapter = createCliAdapter('gemini', {
      workingDirectory: '/tmp',
      instanceId: 'instance-browser',
      browserGatewayMcp: browserGatewayMcp('gemini'),
    });

    const settingsPath = configOf(adapter).env?.['GEMINI_CLI_SYSTEM_SETTINGS_PATH'];
    expect(settingsPath).toBeTruthy();
    const settings = JSON.parse(readFileSync(settingsPath!, 'utf-8'));
    expect(settings.mcpServers['browser-gateway'].env).toMatchObject({
      AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: '/tmp/browser-gateway.sock',
      AI_ORCHESTRATOR_BROWSER_PROVIDER: 'gemini',
    });
  });

  it('passes Browser Gateway MCP servers to Cursor ACP with array env entries', () => {
    const adapter = createCliAdapter('cursor', {
      workingDirectory: '/tmp',
      instanceId: 'instance-browser',
      browserGatewayMcp: browserGatewayMcp('cursor'),
    });

    const mcpServers = (adapter as unknown as {
      acpConfig: { mcpServers?: { name: string; env?: { name: string; value: string }[] }[] };
    }).acpConfig.mcpServers ?? [];

    const browserGateway = mcpServers.find((server) => server.name === 'browser-gateway');
    expect(browserGateway?.env).toEqual(
      expect.arrayContaining([
        { name: 'AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET', value: '/tmp/browser-gateway.sock' },
        { name: 'AI_ORCHESTRATOR_BROWSER_PROVIDER', value: 'cursor' },
      ]),
    );
  });

  it('preserves pre-existing NODE_OPTIONS and does not duplicate the flag', () => {
    const originalNodeOptions = process.env['NODE_OPTIONS'];
    process.env['NODE_OPTIONS'] = '--max-old-space-size=4096';
    try {
      const adapter = createCliAdapter('copilot', { workingDirectory: '/tmp', copilotAccountRoute: legacyRoute() });
      const nodeOptions = configOf(adapter).env?.['NODE_OPTIONS'] ?? '';
      expect(nodeOptions).toContain('--max-old-space-size=4096');
      expect(nodeOptions).toContain('--use-openssl-ca');
      // No duplicate when re-spawned with the flag already present.
      process.env['NODE_OPTIONS'] = nodeOptions;
      const again = createCliAdapter('copilot', { workingDirectory: '/tmp', copilotAccountRoute: legacyRoute() });
      const againOptions = configOf(again).env?.['NODE_OPTIONS'] ?? '';
      expect(againOptions.match(/--use-openssl-ca/g)?.length ?? 0).toBe(1);
    } finally {
      if (originalNodeOptions === undefined) {
        delete process.env['NODE_OPTIONS'];
      } else {
        process.env['NODE_OPTIONS'] = originalNodeOptions;
      }
    }
  });
});
