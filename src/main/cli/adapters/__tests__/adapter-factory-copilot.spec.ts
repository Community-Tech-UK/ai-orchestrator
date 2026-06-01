import { readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliAdapter, getCliDisplayName, mapSettingsToDetectionType } from '../adapter-factory';
import { PermissionRegistry } from '../../../orchestration/permission-registry';

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

  function readAdditionalMcpConfig(adapter: ReturnType<typeof createCliAdapter>) {
    const args = adapter.getConfig().args ?? [];
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
    const adapter = createCliAdapter('copilot', { workingDirectory: '/tmp' });
    expect(adapter.constructor.name).toBe('AcpCliAdapter');
    expect(adapter.getName()).toBe('copilot-acp');
  });

  it('passes resume session options through to the ACP adapter', () => {
    const adapter = createCliAdapter('copilot', {
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
      workingDirectory: '/tmp',
      model: 'claude-opus-4.7',
    });
    const args = adapter.getConfig().args ?? [];
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe('claude-opus-4.7');
    // Core ACP flags must still be present.
    expect(args).toContain('--acp');
    expect(args).toContain('--stdio');
  });

  it('disables Copilot ask_user in ACP mode so prompt turns stay autonomous', () => {
    const adapter = createCliAdapter('copilot', { workingDirectory: '/tmp' });
    const args = adapter.getConfig().args ?? [];
    expect(args).toContain('--no-ask-user');
  });

  it('isolates Copilot CLI state from the default VS Code-visible Copilot home', () => {
    const adapter = createCliAdapter('copilot', { workingDirectory: '/tmp' });
    const args = adapter.getConfig().args ?? [];
    const configDirIdx = args.indexOf('--config-dir');
    expect(configDirIdx).toBeGreaterThanOrEqual(0);
    expect(args[configDirIdx + 1]).toBe(testCopilotHome);
    expect(args).toContain('--no-remote');

    const env = adapter.getConfig().env ?? {};
    expect(env['COPILOT_HOME']).toBe(testCopilotHome);
  });

  it('allows callers to opt back into normal Copilot persistence explicitly', () => {
    const adapter = createCliAdapter('copilot', {
      workingDirectory: '/tmp',
      ephemeral: false,
    });
    const args = adapter.getConfig().args ?? [];
    const env = adapter.getConfig().env ?? {};
    expect(args).not.toContain('--config-dir');
    expect(args).not.toContain('--no-remote');
    expect(env['COPILOT_HOME']).toBeUndefined();
  });

  it('omits --model when no model is specified so copilot uses its configured default', () => {
    const adapter = createCliAdapter('copilot', { workingDirectory: '/tmp' });
    const args = adapter.getConfig().args ?? [];
    expect(args).not.toContain('--model');
  });

  it('preserves the literal "auto" sentinel when model === "auto"', () => {
    const adapter = createCliAdapter('copilot', {
      workingDirectory: '/tmp',
      model: 'auto',
    });
    const args = adapter.getConfig().args ?? [];
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

    const adapter = createCliAdapter('copilot', { workingDirectory: '/tmp' });
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
    const adapter = createCliAdapter('copilot', { workingDirectory: '/tmp' });
    const env = adapter.getConfig().env ?? {};
    expect(env['NODE_OPTIONS']).toMatch(/--use-openssl-ca/);
  });

  it('passes Browser Gateway MCP config to Copilot through --additional-mcp-config', () => {
    const adapter = createCliAdapter('copilot', {
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
      acpConfig: { mcpServers?: Array<{ name: string }> };
    }).acpConfig.mcpServers).toEqual([]);
  });

  it('adds Browser Gateway usage guidance to provider system prompts when browser tools are enabled', () => {
    const adapter = createCliAdapter('copilot', {
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
  });

  it('merges caller-provided Copilot MCP servers with Browser Gateway', () => {
    const adapter = createCliAdapter('copilot', {
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

    const settingsPath = adapter.getConfig().env?.['GEMINI_CLI_SYSTEM_SETTINGS_PATH'];
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
      acpConfig: { mcpServers?: Array<{ name: string; env?: Array<{ name: string; value: string }> }> };
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
      const adapter = createCliAdapter('copilot', { workingDirectory: '/tmp' });
      const nodeOptions = adapter.getConfig().env?.['NODE_OPTIONS'] ?? '';
      expect(nodeOptions).toContain('--max-old-space-size=4096');
      expect(nodeOptions).toContain('--use-openssl-ca');
      // No duplicate when re-spawned with the flag already present.
      process.env['NODE_OPTIONS'] = nodeOptions;
      const again = createCliAdapter('copilot', { workingDirectory: '/tmp' });
      const againOptions = again.getConfig().env?.['NODE_OPTIONS'] ?? '';
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
