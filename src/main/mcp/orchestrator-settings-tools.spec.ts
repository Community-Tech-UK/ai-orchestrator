import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types/settings.types';
import { assertPrivilegedSettingsCliWritable } from '../core/config/settings-control-policy';

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
  privilegedGetSetting,
  privilegedListSettings,
  privilegedSetSetting,
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

describe('privileged settings CLI writability reporting', () => {
  function privilegedList() {
    const settings = makeSettingsManager();
    const result = privilegedListSettings({ settingsManager: settings }, {});
    return new Map(result.settings.map((setting) => [setting.key, setting]));
  }

  it('reports read-only-tier keys as CLI-writable', () => {
    const byKey = privilegedList();

    // The tool tier says read-only; the privileged CLI can still write these.
    expect(byKey.get('defaultYoloMode')).toMatchObject({
      policyTier: 'read-only',
      writable: false,
      cliWritable: true,
    });
    expect(byKey.get('remoteNodesEnabled')).toMatchObject({
      policyTier: 'read-only',
      cliWritable: true,
    });
  });

  it('reports secret-tier keys as CLI-writable while keeping values redacted', () => {
    expect(privilegedList().get('remoteNodesEnrollmentToken')).toMatchObject({
      policyTier: 'secret',
      value: '[redacted]',
      writable: false,
      cliWritable: true,
    });
  });

  it('reports the 2026-08-29 widened browser credential keys as CLI-writable', () => {
    // Deliberate widening, authorised by the operator: these three were the
    // only settings blocking an unattended portal login. They stay closed-tier
    // to the safe MCP tool surface; only the privileged repair CLI may write
    // them. See the note on PRIVILEGED_CLI_OPERATOR_ONLY_KEYS.
    const byKey = privilegedList();

    for (const key of [
      'browserAllowSharedTabCredentialFill',
      'browserVaultAutoUnlock',
      'browserVaultMasterPasswordFile',
    ] as const) {
      expect(byKey.get(key)?.cliWritable, key).toBe(true);
      expect(byKey.get(key)?.writable, key).toBe(false);
    }
  });

  it('reports operator-only anchors as not CLI-writable', () => {
    const byKey = privilegedList();

    for (const key of [
      'computerUseEnabled',
      'graphAgentWritableAccountsJson',
      'contextEvidenceModeByProvider',
      'localAiGuardDailyFallbackBudgetUsd',
    ] as const) {
      expect(byKey.get(key)?.cliWritable, key).toBe(false);
    }
  });

  it('agrees with the mutation guard for every classified key', () => {
    // The reported column and the guard that actually refuses the write must
    // never drift apart, or the CLI advertises a write it then rejects.
    for (const setting of privilegedList().values()) {
      let mutationAllowed = true;
      try {
        assertPrivilegedSettingsCliWritable(setting.key);
      } catch {
        mutationAllowed = false;
      }
      expect(setting.cliWritable, setting.key).toBe(mutationAllowed);
    }
  });

  it('keeps CLI writability a superset of safe-tool writability', () => {
    // Both docs tell agents to ignore the policy tier and read CLI-Write. That
    // advice is only sound while every open-tier key is also CLI-writable; an
    // open-tier key added to the operator-only denylist would silently make it
    // wrong.
    for (const setting of privilegedList().values()) {
      if (setting.writable) {
        expect(setting.cliWritable, setting.key).toBe(true);
      }
    }
  });

  it('holds the operator-only anchor count the docs quote', () => {
    // docs/AIO_MCP_CLI.md and docs/llm/AIO_MCP_CLI_REFERENCE.md both state 20
    // anchors and enumerate them by group. History: the count reached 21 on
    // 2026-08-26 (`computerUseAutonomyLevel` took the Computer Use group from
    // five keys to six, after Copilot account routing added two on 2026-08-25,
    // `providersExcludedFromAutomation` on 2026-08-19 and `allowPrCreation`
    // under WS-B1 phase 1). On 2026-08-29 the operator authorised removing the
    // two credential-vault unlock keys and the shared-tab credential-fill
    // switch so unattended logins need no GUI step, taking it to 18. On
    // 2026-09-02 Workspace Secret Card added `workspaceSecretsEnabled` and
    // `workspaceSecretsAllowAgentRequests`, taking it to 20. That is pinned
    // separately in settings-control-policy.workspace-secrets.spec.ts.
    // Fail here if a 21st is added, or one is removed, without updating the
    // prose.
    const anchors = [...privilegedList().values()].filter((setting) => !setting.cliWritable);

    expect(anchors).toHaveLength(20);
  });

  it('refuses an operator-only key before parsing the supplied value', () => {
    const settings = makeSettingsManager();

    // A badly typed value on an operator-only key must still report the
    // authorization refusal the docs promise, not a value-shape error.
    expect(() => privilegedSetSetting(
      { settingsManager: settings },
      { key: 'computerUseEnabled', value: 'not-a-boolean' },
    )).toThrow(/operator-only/);
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('populates cliWritable on privileged_get', () => {
    const settings = makeSettingsManager();

    expect(privilegedGetSetting({ settingsManager: settings }, { key: 'defaultYoloMode' }))
      .toMatchObject({ policyTier: 'read-only', writable: false, cliWritable: true });
    expect(privilegedGetSetting(
      { settingsManager: settings },
      { key: 'computerUseEnabled' },
    )).toMatchObject({ cliWritable: false });
    // Widened 2026-08-29: this key used to be the `false` case here.
    expect(privilegedGetSetting(
      { settingsManager: settings },
      { key: 'browserAllowSharedTabCredentialFill' },
    )).toMatchObject({ cliWritable: true });
  });

  it('leaves the safe list_settings tool output free of cliWritable', async () => {
    const { tool } = toolByName('list_settings');

    const result = await tool.handler({}) as {
      settings: Record<string, unknown>[];
    };

    expect(result.settings.every((setting) => !('cliWritable' in setting))).toBe(true);
  });
});
