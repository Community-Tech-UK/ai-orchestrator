import { describe, it, expect } from 'vitest';
import { createCliAdapter, getCliDisplayName, mapSettingsToDetectionType } from '../adapter-factory';

describe('adapter factory — grok', () => {
  it('getCliDisplayName returns Grok Build', () => {
    expect(getCliDisplayName('grok')).toBe('Grok Build');
  });

  it('mapSettingsToDetectionType accepts grok', () => {
    expect(mapSettingsToDetectionType('grok')).toBe('grok');
  });

  it('createCliAdapter(grok, ...) instantiates AcpCliAdapter with a grok provider name', () => {
    const adapter = createCliAdapter('grok', { workingDirectory: '/tmp' });
    expect(adapter.constructor.name).toBe('AcpCliAdapter');
    expect(adapter.getName()).toBe('grok-acp');
  });

  it('passes resume session options through to the ACP adapter', () => {
    const adapter = createCliAdapter('grok', {
      workingDirectory: '/tmp',
      resume: true,
      sessionId: 'grok-session-1',
    });
    expect((adapter as unknown as {
      acpConfig: { resume?: boolean; sessionId?: string };
    }).acpConfig).toMatchObject({
      resume: true,
      sessionId: 'grok-session-1',
    });
  });

  const grokArgs = (adapter: unknown): string[] =>
    (adapter as { acpConfig: { args?: string[] } }).acpConfig.args ?? [];

  it('spawns `grok agent -m <id> --always-approve stdio`', () => {
    const args = grokArgs(createCliAdapter('grok', {
      workingDirectory: '/tmp',
      model: 'grok-4.6',
    }));
    expect(args[0]).toBe('agent');
    expect(args).toContain('-m');
    expect(args[args.indexOf('-m') + 1]).toBe('grok-4.6');
    expect(args).toContain('--always-approve');
    expect(args.at(-1)).toBe('stdio');
  });

  it('repairs a retired model at the spawn boundary, not just at session create', () => {
    // Hibernate wake, restart, and native resume all rebuild spawn options from
    // the persisted `instance.currentModel`. An instance stored before xAI
    // retired grok-4.5 would otherwise keep re-sending an id the CLI rejects
    // with "unknown model id" (exit 1) and could never come back.
    const args = grokArgs(createCliAdapter('grok', {
      workingDirectory: '/tmp',
      model: 'grok-4.5',
    }));
    expect(args[args.indexOf('-m') + 1]).toBe('grok-4.6');
  });

  it('omits -m entirely when no model is requested, so the CLI picks its own default', () => {
    const args = grokArgs(createCliAdapter('grok', { workingDirectory: '/tmp' }));
    expect(args).not.toContain('-m');
    expect(args.at(-1)).toBe('stdio');
  });

  it('omits -m for the `auto` sentinel', () => {
    const auto = grokArgs(createCliAdapter('grok', { workingDirectory: '/tmp', model: 'auto' }));
    expect(auto).not.toContain('-m');
    expect(auto.at(-1)).toBe('stdio');
  });

  it('forwards mapped reasoning effort before stdio', () => {
    const args = grokArgs(createCliAdapter('grok', {
      workingDirectory: '/tmp',
      model: 'grok-4.6',
      reasoningEffort: 'medium',
    }));
    expect(args).toContain('--reasoning-effort');
    expect(args[args.indexOf('--reasoning-effort') + 1]).toBe('medium');
    expect(args.indexOf('--reasoning-effort')).toBeLessThan(args.indexOf('stdio'));
  });

  it('maps xhigh/max reasoning effort to high', () => {
    const args = grokArgs(createCliAdapter('grok', {
      workingDirectory: '/tmp',
      reasoningEffort: 'xhigh',
    }));
    expect(args[args.indexOf('--reasoning-effort') + 1]).toBe('high');
  });

  it('skips --always-approve when yoloMode is false', () => {
    const args = grokArgs(createCliAdapter('grok', {
      workingDirectory: '/tmp',
      yoloMode: false,
    }));
    expect(args).not.toContain('--always-approve');
    expect(args.at(-1)).toBe('stdio');
  });

  it('adds the chrome-devtools attach server to the Grok ACP mcpServers list', () => {
    const adapter = createCliAdapter('grok', {
      workingDirectory: '/tmp',
      chromeDevtoolsMcp: { browserUrl: 'http://127.0.0.1:31234' },
    });
    const servers = (adapter as unknown as {
      acpConfig: { mcpServers?: { name: string; args?: string[] }[] };
    }).acpConfig.mcpServers ?? [];
    const chromeDevtools = servers.find((server) => server.name === 'chrome-devtools');
    expect(chromeDevtools).toBeDefined();
    expect(chromeDevtools?.args).toContain('--browserUrl');
    expect(chromeDevtools?.args).toContain('http://127.0.0.1:31234');
  });
});
