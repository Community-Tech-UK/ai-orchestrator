import { describe, it, expect } from 'vitest';
import { createCliAdapter, getCliDisplayName, mapSettingsToDetectionType } from '../adapter-factory';

describe('adapter factory — cursor', () => {
  it('getCliDisplayName returns Cursor CLI', () => {
    expect(getCliDisplayName('cursor')).toBe('Cursor CLI');
  });
  it('mapSettingsToDetectionType accepts cursor', () => {
    expect(mapSettingsToDetectionType('cursor')).toBe('cursor');
  });
  it('createCliAdapter(cursor, ...) instantiates AcpCliAdapter with a cursor provider name', () => {
    const adapter = createCliAdapter('cursor', { workingDirectory: '/tmp' });
    expect(adapter.constructor.name).toBe('AcpCliAdapter');
    expect(adapter.getName()).toBe('cursor-acp');
  });

  it('passes resume session options through to the ACP adapter', () => {
    const adapter = createCliAdapter('cursor', {
      workingDirectory: '/tmp',
      resume: true,
      sessionId: 'cursor-session-1',
    });
    expect((adapter as unknown as {
      acpConfig: { resume?: boolean; sessionId?: string };
    }).acpConfig).toMatchObject({
      resume: true,
      sessionId: 'cursor-session-1',
    });
  });

  // Regression: the ACP layer holds `model` in config but never forwards it to
  // the subprocess, and `session/new` carries no model field. cursor-agent must
  // be launched with `acp --model <id>` or the session silently runs the binary
  // default while the UI shows the chosen model. Verified against the live CLI:
  // `session/new` reports currentModelId === the forwarded `--model`.
  const cursorArgs = (adapter: unknown): string[] =>
    (adapter as { acpConfig: { args?: string[] } }).acpConfig.args ?? [];

  it('forwards the selected model to cursor-agent as `acp --model <id>`', () => {
    const adapter = createCliAdapter('cursor', {
      workingDirectory: '/tmp',
      model: 'composer-2.5',
    });
    const args = cursorArgs(adapter);
    expect(args[0]).toBe('acp');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('composer-2.5');
  });

  it('omits --model for the `auto` sentinel (lets Cursor pick)', () => {
    const auto = cursorArgs(createCliAdapter('cursor', { workingDirectory: '/tmp', model: 'auto' }));
    expect(auto).not.toContain('--model');

    const none = cursorArgs(createCliAdapter('cursor', { workingDirectory: '/tmp' }));
    expect(none).not.toContain('--model');
  });

  it('adds the chrome-devtools attach server to the Cursor ACP mcpServers list', () => {
    const adapter = createCliAdapter('cursor', {
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

  it('adds inline Orchestrator Tools MCP config to the Cursor ACP mcpServers list', () => {
    const adapter = createCliAdapter('cursor', {
      workingDirectory: '/tmp',
      mcpConfig: [
        JSON.stringify({
          mcpServers: {
            orchestrator: {
              command: '/tmp/aio-mcp',
              args: ['orchestrator-tools'],
              env: {
                AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: '/tmp/orchestrator-tools.sock',
                AI_ORCHESTRATOR_INSTANCE_ID: 'instance-cursor',
              },
            },
          },
        }),
      ],
    });
    const servers = (adapter as unknown as {
      acpConfig: {
        mcpServers?: Array<{
          name: string;
          command: string;
          args?: string[];
          env?: Array<{ name: string; value: string }>;
        }>;
      };
    }).acpConfig.mcpServers ?? [];
    const orchestrator = servers.find((server) => server.name === 'orchestrator');

    expect(orchestrator).toMatchObject({
      name: 'orchestrator',
      command: '/tmp/aio-mcp',
      args: ['orchestrator-tools'],
    });
    expect(orchestrator?.env).toEqual(
      expect.arrayContaining([
        {
          name: 'AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET',
          value: '/tmp/orchestrator-tools.sock',
        },
        { name: 'AI_ORCHESTRATOR_INSTANCE_ID', value: 'instance-cursor' },
      ]),
    );
  });
});
