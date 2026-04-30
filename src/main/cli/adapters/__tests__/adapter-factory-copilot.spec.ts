import { describe, expect, it } from 'vitest';
import { createCliAdapter, getCliDisplayName, mapSettingsToDetectionType } from '../adapter-factory';
import { PermissionRegistry } from '../../../orchestration/permission-registry';

describe('adapter factory — copilot', () => {
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
