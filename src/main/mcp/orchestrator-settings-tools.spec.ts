import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types/settings.types';

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: loggerMocks.info,
    warn: vi.fn(),
  }),
}));

import {
  SETTINGS_TOOL_POLICY,
  createSettingsToolDefinitions,
  getSettingsToolPolicy,
} from './orchestrator-settings-tools';

function cloneSettings(): AppSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppSettings;
}

function makeSettingsManager(initial: Partial<AppSettings> = {}) {
  const values: AppSettings = { ...cloneSettings(), ...initial };
  return {
    values,
    getAll: vi.fn(() => ({ ...values })),
    get: vi.fn(<K extends keyof AppSettings>(key: K) => values[key]),
    set: vi.fn(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      values[key] = (
        key === 'defaultCli' && value === 'openai' ? 'codex' : value
      ) as AppSettings[K];
    }),
    resetOne: vi.fn(<K extends keyof AppSettings>(key: K) => {
      values[key] = DEFAULT_SETTINGS[key];
    }),
  };
}

function toolByName(name: string, settings = makeSettingsManager(), overrides: {
  broadcastSettingsChange?: (payload: unknown) => void;
  updateNodeConfig?: (args: unknown) => Promise<unknown>;
} = {}) {
  const tools = createSettingsToolDefinitions({
    settingsManager: settings,
    broadcastSettingsChange: overrides.broadcastSettingsChange,
    updateNodeConfig: overrides.updateNodeConfig,
  });
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Missing tool: ${name}`);
  }
  return { tool, settings };
}

describe('orchestrator settings MCP tools', () => {
  it('classifies every AppSettings key explicitly', () => {
    expect(Object.keys(SETTINGS_TOOL_POLICY).sort()).toEqual(
      Object.keys(DEFAULT_SETTINGS).sort(),
    );
  });

  it('ships safe Microsoft Graph calendar defaults and explicit tool policies', () => {
    const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
    const policies = SETTINGS_TOOL_POLICY as unknown as Record<
      string,
      { tier: string; restartRequired: boolean }
    >;

    expect(defaults).toMatchObject({
      graphClientId: 'fdbb0672-4089-48dc-bcc5-7121a331fcfc',
      graphAuthority: 'https://login.microsoftonline.com/60b0a25e-b75d-4d9e-b797-1805ec311dfb',
      graphScopesJson: JSON.stringify([
        'Calendars.ReadWrite',
        'offline_access',
        'openid',
        'profile',
        'User.Read',
      ]),
      graphAgentWritableAccountsJson: JSON.stringify(['james@communitytech.co.uk']),
    });
    expect(policies['graphClientId']).toMatchObject({ tier: 'read-only' });
    expect(policies['graphAuthority']).toMatchObject({ tier: 'read-only' });
    expect(policies['graphScopesJson']).toMatchObject({ tier: 'read-only' });
    expect(policies['graphAgentWritableAccountsJson']).toMatchObject({ tier: 'read-only' });
  });

  it('redacts secret settings in list_settings and marks read-only keys unwritable', async () => {
    const { tool } = toolByName('list_settings', makeSettingsManager({
      remoteNodesEnrollmentToken: 'redaction-test-value',
      defaultYoloMode: false,
      theme: 'light',
    }));

    const result = await tool.handler({}) as {
      settings: {
        key: keyof AppSettings;
        value: unknown;
        writable: boolean;
        policyTier: string;
      }[];
    };

    expect(result.settings.find((setting) => setting.key === 'theme')).toMatchObject({
      value: 'light',
      writable: true,
      policyTier: 'open',
    });
    expect(result.settings.find((setting) => setting.key === 'defaultYoloMode')).toMatchObject({
      writable: false,
      policyTier: 'read-only',
    });
    expect(result.settings.find((setting) => setting.key === 'remoteNodesEnrollmentToken')).toMatchObject({
      value: '[redacted]',
      writable: false,
      policyTier: 'secret',
    });
  });

  it('treats auxiliary endpoint config as secret because it can reference bearer credentials', async () => {
    const endpointConfig = JSON.stringify([{
      id: 'cloud',
      label: 'Cloud',
      provider: 'openai-compatible',
      baseUrl: 'https://llm.example.test',
      apiKeyEnv: 'AUX_API_KEY',
      source: 'manual',
      enabled: true,
    }]);
    const settings = makeSettingsManager({ auxiliaryLlmEndpointsJson: endpointConfig });
    const { tool: listTool } = toolByName('list_settings', settings);
    const listResult = await listTool.handler({}) as {
      settings: {
        key: keyof AppSettings;
        value: unknown;
        defaultValue: unknown;
        writable: boolean;
        policyTier: string;
      }[];
    };

    expect(listResult.settings.find((setting) => setting.key === 'auxiliaryLlmEndpointsJson'))
      .toMatchObject({
        value: '[redacted]',
        defaultValue: '[redacted]',
        writable: false,
        policyTier: 'secret',
      });

    const { tool: getTool } = toolByName('get_setting', settings);
    await expect(getTool.handler({ key: 'auxiliaryLlmEndpointsJson' })).rejects.toThrow(
      /secret setting/,
    );

    const { tool: setTool } = toolByName('set_setting', settings);
    await expect(
      setTool.handler({ key: 'auxiliaryLlmEndpointsJson', value: [] }),
    ).rejects.toThrow(/secret setting/);
  });

  it('filters list_settings by category', async () => {
    const { tool } = toolByName('list_settings');

    const result = await tool.handler({ category: 'display' }) as {
      settings: { key: keyof AppSettings; category: string }[];
    };

    expect(result.settings.some((setting) => setting.key === 'theme')).toBe(true);
    expect(result.settings.every((setting) => setting.category === 'display')).toBe(true);
  });

  it('refuses to read secret settings', async () => {
    const { tool } = toolByName('get_setting', makeSettingsManager({
      remoteNodesEnrollmentToken: 'redaction-test-value',
    }));

    await expect(tool.handler({ key: 'remoteNodesEnrollmentToken' })).rejects.toThrow(
      /secret setting/,
    );
  });

  it('refuses writes to read-only and secret settings', async () => {
    const settings = makeSettingsManager();
    const { tool } = toolByName('set_setting', settings);

    await expect(tool.handler({ key: 'defaultYoloMode', value: true })).rejects.toThrow(
      /read-only/,
    );
    await expect(
      tool.handler({ key: 'remoteNodesEnrollmentToken', value: 'redaction-test-value' }),
    ).rejects.toThrow(/secret setting/);
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('prevents ordinary MCP tools from weakening Computer Use policy', async () => {
    const settings = makeSettingsManager();
    const { tool } = toolByName('set_setting', settings);

    await expect(tool.handler({
      key: 'computerUseRequireApprovalForInput',
      value: false,
    })).rejects.toThrow(/read-only/);
    await expect(tool.handler({
      key: 'computerUseAllowedAppsJson',
      value: '["com.example.untrusted"]',
    })).rejects.toThrow(/read-only/);
  });

  it('sets open settings, broadcasts the raw AppSettings value, and reports audit-safe values', async () => {
    const broadcast = vi.fn();
    const settings = makeSettingsManager({ theme: 'dark' });
    const { tool } = toolByName('set_setting', settings, { broadcastSettingsChange: broadcast });

    const result = await tool.handler({ key: 'theme', value: 'light' });

    expect(settings.set).toHaveBeenCalledWith('theme', 'light');
    expect(broadcast).toHaveBeenCalledWith({ key: 'theme', value: 'light' });
    expect(result).toMatchObject({
      ok: true,
      key: 'theme',
      oldValue: 'dark',
      newValue: 'light',
      restartRequired: false,
    });
  });

  it('reports and broadcasts the normalized value persisted by SettingsManager', async () => {
    const broadcast = vi.fn();
    const settings = makeSettingsManager({ defaultCli: 'auto' });
    const { tool } = toolByName('set_setting', settings, { broadcastSettingsChange: broadcast });

    const result = await tool.handler({ key: 'defaultCli', value: 'openai' });

    expect(settings.set).toHaveBeenCalledWith('defaultCli', 'openai');
    expect(settings.get).toHaveBeenLastCalledWith('defaultCli');
    expect(broadcast).toHaveBeenCalledWith({ key: 'defaultCli', value: 'codex' });
    expect(result).toMatchObject({
      ok: true,
      key: 'defaultCli',
      oldValue: 'auto',
      newValue: 'codex',
    });
  });

  it('round-trips writable JSON blob settings as real objects for tool callers', async () => {
    const broadcast = vi.fn();
    const settings = makeSettingsManager({
      auxiliaryLlmSlotsJson: JSON.stringify({
        compression: {
          enabled: true,
          provider: 'auto',
          tier: 'quality',
          maxInputTokens: 96000,
          maxOutputTokens: 4096,
          temperature: 0.2,
          timeoutMs: 60000,
          requireJson: false,
          allowFrontierFallback: true,
        },
      }),
    });
    const { tool } = toolByName('set_setting', settings, { broadcastSettingsChange: broadcast });
    const nextSlots = {
      compression: {
        enabled: false,
        provider: 'auto',
        tier: 'quality',
        maxInputTokens: 64000,
        maxOutputTokens: 2048,
        temperature: 0.1,
        timeoutMs: 45000,
        requireJson: false,
        allowFrontierFallback: true,
      },
    };

    const result = await tool.handler({
      key: 'auxiliaryLlmSlotsJson',
      value: nextSlots,
    });

    expect(settings.set).toHaveBeenCalledWith(
      'auxiliaryLlmSlotsJson',
      JSON.stringify(nextSlots),
    );
    expect(broadcast).toHaveBeenCalledWith({
      key: 'auxiliaryLlmSlotsJson',
      value: JSON.stringify(nextSlots),
    });
    expect(result).toMatchObject({
      newValue: nextSlots,
    });
  });

  it('requires every open setting policy to carry a runtime value schema', () => {
    for (const [key, policy] of Object.entries(SETTINGS_TOOL_POLICY)) {
      if (policy.tier !== 'open') {
        continue;
      }
      expect(policy).toHaveProperty('schema');
      const schema = (policy as { schema?: { safeParse: (value: unknown) => { success: boolean } } }).schema;
      expect(schema?.safeParse(DEFAULT_SETTINGS[key as keyof AppSettings]).success).toBe(true);
    }
  });

  it('rejects malformed nested values for open settings instead of only checking top-level shape', async () => {
    const settings = makeSettingsManager();
    const { tool } = toolByName('set_setting', settings);

    await expect(
      tool.handler({ key: 'defaultModelByProvider', value: { claude: 123 } }),
    ).rejects.toThrow(/Invalid value/);
    await expect(
      tool.handler({ key: 'customModelsByProvider', value: { claude: 'not-an-array' } }),
    ).rejects.toThrow(/Invalid value/);
    await expect(
      tool.handler({ key: 'customModelsByProvider', value: { claude: ['future-model', ''] } }),
    ).rejects.toThrow(/Invalid value/);
    await expect(
      tool.handler({ key: 'crossModelReviewProviders', value: ['gemini', 'not-a-provider'] }),
    ).rejects.toThrow(/Invalid value/);
    await expect(
      tool.handler({
        key: 'auxiliaryLlmSlotsJson',
        value: { compression: { enabled: 'yes' } },
      }),
    ).rejects.toThrow(/Invalid value/);
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('accepts provider-specific custom model arrays as an open setting', async () => {
    const broadcast = vi.fn();
    const settings = makeSettingsManager({ customModelsByProvider: {} });
    const { tool } = toolByName('set_setting', settings, { broadcastSettingsChange: broadcast });
    const customModels = { claude: ['claude-future-opus'], codex: ['gpt-9-codex'] };

    const result = await tool.handler({
      key: 'customModelsByProvider',
      value: customModels,
    });

    expect(settings.set).toHaveBeenCalledWith('customModelsByProvider', customModels);
    expect(broadcast).toHaveBeenCalledWith({
      key: 'customModelsByProvider',
      value: customModels,
    });
    expect(result).toMatchObject({
      ok: true,
      key: 'customModelsByProvider',
      newValue: customModels,
    });
  });

  it('accepts an optional HTTP(S) remote model catalog override URL as an open setting', async () => {
    const broadcast = vi.fn();
    const settings = makeSettingsManager({ modelCatalogRemoteOverrideUrl: '' });
    const { tool } = toolByName('set_setting', settings, { broadcastSettingsChange: broadcast });

    const result = await tool.handler({
      key: 'modelCatalogRemoteOverrideUrl',
      value: 'https://catalog.example.com/models-override.json',
    });

    expect(settings.set).toHaveBeenCalledWith(
      'modelCatalogRemoteOverrideUrl',
      'https://catalog.example.com/models-override.json',
    );
    expect(broadcast).toHaveBeenCalledWith({
      key: 'modelCatalogRemoteOverrideUrl',
      value: 'https://catalog.example.com/models-override.json',
    });
    expect(result).toMatchObject({
      ok: true,
      key: 'modelCatalogRemoteOverrideUrl',
      newValue: 'https://catalog.example.com/models-override.json',
    });
  });

  it('logs an audit line for successful tool-initiated mutations', async () => {
    loggerMocks.info.mockClear();
    const settings = makeSettingsManager({ theme: 'dark' });
    const { tool } = toolByName('set_setting', settings);

    await tool.handler({ key: 'theme', value: 'light' });

    expect(loggerMocks.info).toHaveBeenCalledWith('Setting changed via MCP tool', {
      source: 'mcp-tool',
      action: 'set_setting',
      key: 'theme',
      oldValue: 'dark',
      newValue: 'light',
      restartRequired: false,
    });
  });

  it('resets an open setting and returns the default value', async () => {
    const broadcast = vi.fn();
    const settings = makeSettingsManager({ theme: 'light' });
    const { tool } = toolByName('reset_setting', settings, { broadcastSettingsChange: broadcast });

    const result = await tool.handler({ key: 'theme' });

    expect(settings.resetOne).toHaveBeenCalledWith('theme');
    expect(broadcast).toHaveBeenCalledWith({ key: 'theme', value: DEFAULT_SETTINGS.theme });
    expect(result).toMatchObject({
      ok: true,
      key: 'theme',
      oldValue: 'light',
      newValue: DEFAULT_SETTINGS.theme,
    });
  });

  it('forwards update_node_config to the injected node config updater', async () => {
    const updateNodeConfig = vi.fn(async (args: unknown) => ({ ok: true, args }));
    const { tool } = toolByName('update_node_config', makeSettingsManager(), { updateNodeConfig });

    const result = await tool.handler({
      nodeId: 'windows-pc',
      extensionRelay: { enabled: true },
    });

    expect(updateNodeConfig).toHaveBeenCalledWith({
      nodeId: 'windows-pc',
      extensionRelay: { enabled: true },
    });
    expect(result).toMatchObject({ ok: true });
  });

  it('keeps unknown future keys fail-closed', () => {
    expect(getSettingsToolPolicy('futureTokenSetting')).toMatchObject({
      tier: 'secret',
      restartRequired: false,
    });
    expect(getSettingsToolPolicy('futureRegularSetting')).toMatchObject({
      tier: 'read-only',
      restartRequired: false,
    });
  });
});
