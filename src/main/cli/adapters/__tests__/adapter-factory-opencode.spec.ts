import { describe, it, expect } from 'vitest';
import { createCliAdapter, getCliDisplayName, mapSettingsToDetectionType } from '../adapter-factory';
import {
  buildOpenCodeConfigContent,
  buildOpenCodePermissionBlock,
  OPENCODE_CONFIG_CONTENT_ENV,
} from '../opencode-adapter-factory';

interface OpenCodeAcpConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  resume?: boolean;
  sessionId?: string;
  sessionConfig?: { model?: string; effort?: string };
  startupGate?: unknown;
  reportedCostOnly?: boolean;
  concurrencyKey?: string;
  mcpServers?: { name: string; args?: string[] }[];
}

const acpConfig = (adapter: unknown): OpenCodeAcpConfig =>
  (adapter as { acpConfig: OpenCodeAcpConfig }).acpConfig;

const injectedConfig = (adapter: unknown): { permission: Record<string, string> } & Record<string, unknown> =>
  JSON.parse(acpConfig(adapter).env?.[OPENCODE_CONFIG_CONTENT_ENV] ?? '{}');

describe('adapter factory — opencode', () => {
  it('names and maps the CLI', () => {
    expect(getCliDisplayName('opencode')).toBe('OpenCode');
    expect(mapSettingsToDetectionType('opencode')).toBe('opencode');
  });

  it('spawns `opencode acp --cwd <dir>` through AcpCliAdapter', () => {
    const adapter = createCliAdapter('opencode', { workingDirectory: '/tmp/work' });
    expect(adapter.constructor.name).toBe('AcpCliAdapter');
    expect(adapter.getName()).toBe('opencode-acp');
    expect(acpConfig(adapter)).toMatchObject({
      command: 'opencode',
      args: ['acp', '--cwd', '/tmp/work'],
      concurrencyKey: 'opencode',
    });
    expect(acpConfig(adapter).startupGate).toEqual(expect.any(Function));
    expect(acpConfig(adapter).reportedCostOnly).toBe(true);
  });

  it('passes resume options through', () => {
    const adapter = createCliAdapter('opencode', {
      workingDirectory: '/tmp',
      resume: true,
      sessionId: 'ses_placeholder',
    });
    expect(acpConfig(adapter)).toMatchObject({ resume: true, sessionId: 'ses_placeholder' });
  });

  it('injects an allow-everything permission block with YOLO on (the default)', () => {
    const permission = injectedConfig(createCliAdapter('opencode', { workingDirectory: '/tmp' })).permission;
    expect(Object.keys(permission)[0]).toBe('*');
    expect(new Set(Object.values(permission))).toEqual(new Set(['allow']));
    expect(permission).toMatchObject({ '*': 'allow', edit: 'allow', bash: 'allow', read: 'allow' });
  });

  it('asks for writes, commands and network access with YOLO off, and allows reads', () => {
    const permission = injectedConfig(createCliAdapter('opencode', { workingDirectory: '/tmp', yoloMode: false })).permission;
    expect(permission).toMatchObject({
      '*': 'ask',
      edit: 'ask',
      bash: 'ask',
      webfetch: 'ask',
      websearch: 'ask',
      task: 'ask',
      external_directory: 'ask',
      read: 'allow',
      list: 'allow',
      glob: 'allow',
      grep: 'allow',
    });
  });

  it('merges into an OPENCODE_CONFIG_CONTENT already in the environment', () => {
    const existing = JSON.stringify({ model: 'opencode/mimo-v2.6-flash-free', permission: { bash: 'deny', custom_tool: 'allow' } });
    const merged = JSON.parse(buildOpenCodeConfigContent(existing, false)) as {
      model: string;
      permission: Record<string, string>;
    };
    expect(merged.model).toBe('opencode/mimo-v2.6-flash-free');
    expect(merged.permission['custom_tool']).toBe('allow');
    expect(merged.permission['bash']).toBe('ask');

    const viaFactory = injectedConfig(createCliAdapter('opencode', {
      workingDirectory: '/tmp',
      env: { [OPENCODE_CONFIG_CONTENT_ENV]: existing },
    }));
    expect(viaFactory['model']).toBe('opencode/mimo-v2.6-flash-free');
    expect(viaFactory.permission['bash']).toBe('allow');
  });

  it('replaces an unparseable existing OPENCODE_CONFIG_CONTENT', () => {
    expect(JSON.parse(buildOpenCodeConfigContent('{not json', true))).toEqual({
      permission: buildOpenCodePermissionBlock(true),
    });
  });

  it('applies an explicit provider/model and mapped effort through sessionConfig', () => {
    const adapter = createCliAdapter('opencode', {
      workingDirectory: '/tmp',
      model: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
      reasoningEffort: 'xhigh',
    });
    expect(acpConfig(adapter).sessionConfig).toEqual({
      model: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
      effort: 'high',
    });
    expect(acpConfig(adapter).args).not.toContain('--model');
  });

  it('keeps OpenCode default when the model is absent, `auto`, or not a provider/model id', () => {
    for (const model of [undefined, 'auto', 'sonnet', 'balanced']) {
      const adapter = createCliAdapter('opencode', { workingDirectory: '/tmp', ...(model ? { model } : {}) });
      expect(acpConfig(adapter).sessionConfig).toBeUndefined();
    }
  });

  it('sends effort alone when no model is chosen, and omits effort OpenCode should decide', () => {
    expect(acpConfig(createCliAdapter('opencode', { workingDirectory: '/tmp', reasoningEffort: 'medium' })).sessionConfig)
      .toEqual({ effort: 'medium' });
    expect(acpConfig(createCliAdapter('opencode', { workingDirectory: '/tmp', reasoningEffort: 'none' })).sessionConfig)
      .toBeUndefined();
  });

  it('adds the chrome-devtools attach server to the ACP mcpServers list', () => {
    const adapter = createCliAdapter('opencode', {
      workingDirectory: '/tmp',
      chromeDevtoolsMcp: { browserUrl: 'http://127.0.0.1:31234' },
    });
    const chromeDevtools = (acpConfig(adapter).mcpServers ?? []).find((server) => server.name === 'chrome-devtools');
    expect(chromeDevtools?.args).toContain('http://127.0.0.1:31234');
  });
});
