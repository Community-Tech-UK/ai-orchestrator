/**
 * Orchestrator settings MCP tools.
 *
 * Adds a policy-checked programmatic settings surface to the existing
 * orchestrator-tools MCP server. Settings writes still go through
 * SettingsManager, so the normal validation, normalization, cache invalidation,
 * and event emission paths stay central.
 */

import type { z } from 'zod';
import {
  SettingsToolGetPayloadSchema,
  SettingsToolListPayloadSchema,
  SettingsToolResetPayloadSchema,
  SettingsToolSetPayloadSchema,
  SettingsToolUpdateNodeConfigPayloadSchema,
} from '@contracts/schemas/settings';
import {
  DEFAULT_SETTINGS,
  SETTINGS_METADATA,
  type AppSettings,
} from '../../shared/types/settings.types';
import {
  assertReadableSetting,
  assertWritableSetting,
  coerceWritableSettingValue,
  getSettingsToolPolicy,
  requireKnownSettingsToolKey,
  settingsValueForTool,
  type SettingsToolPolicy,
  type SettingsToolPolicyTier,
} from '../core/config/settings-control-policy';
import { getLogger } from '../logging/logger';
import type { McpServerToolDefinition } from './mcp-server-tools';

const logger = getLogger('SettingsTools');

export { SETTINGS_TOOL_POLICY, getSettingsToolPolicy } from '../core/config/settings-control-policy';

export type SettingsToolListArgs = z.infer<typeof SettingsToolListPayloadSchema>;
export type SettingsToolGetArgs = z.infer<typeof SettingsToolGetPayloadSchema>;
export type SettingsToolSetArgs = z.infer<typeof SettingsToolSetPayloadSchema>;
export type SettingsToolResetArgs = z.infer<typeof SettingsToolResetPayloadSchema>;
export type SettingsToolUpdateNodeConfigArgs = z.infer<
  typeof SettingsToolUpdateNodeConfigPayloadSchema
>;

export interface SettingsManagerForTools {
  getAll(): AppSettings;
  get<K extends keyof AppSettings>(key: K): AppSettings[K];
  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void;
  resetOne<K extends keyof AppSettings>(key: K): void;
}

export type SettingsChangeBroadcaster = (payload: {
  key: keyof AppSettings;
  value: AppSettings[keyof AppSettings];
}) => void;

export type UpdateNodeConfigFn = (
  args: SettingsToolUpdateNodeConfigArgs,
) => Promise<unknown>;

export interface SettingsToolContext {
  settingsManager?: SettingsManagerForTools | null;
  broadcastSettingsChange?: SettingsChangeBroadcaster | null;
  updateNodeConfig?: UpdateNodeConfigFn | null;
}

export interface SettingsToolListItem {
  key: keyof AppSettings;
  value: unknown;
  defaultValue: unknown;
  type: string;
  category: string;
  writable: boolean;
  restartRequired: boolean;
  description: string;
  policyTier: SettingsToolPolicyTier;
}

export interface SettingsToolSetResult {
  ok: true;
  key: keyof AppSettings;
  oldValue: unknown;
  newValue: unknown;
  restartRequired: boolean;
}

const metadataByKey = new Map(SETTINGS_METADATA.map((metadata) => [metadata.key, metadata]));

export function createSettingsToolDefinitions(
  context: SettingsToolContext,
): McpServerToolDefinition[] {
  return [
    {
      name: 'list_settings',
      description:
        'List Harness app settings that agents can inspect. Values are redacted for secret-tier keys, and each row reports whether it can be changed with set_setting/reset_setting plus whether a restart is required.',
      inputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description:
              'Optional category filter, such as general, display, orchestration, memory, advanced, review, network, mcp, rtk, remote-nodes, mobile, or auxiliary-llm.',
          },
        },
        required: [],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = SettingsToolListPayloadSchema.parse(args ?? {});
        const manager = requireSettingsManager(context);
        const current = manager.getAll();
        const all = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[];
        const settings = all
          .map((key): SettingsToolListItem => describeSetting(key, current[key]))
          .filter((item) => !parsed.category || item.category === parsed.category);
        return { count: settings.length, settings };
      },
    },
    {
      name: 'get_setting',
      description:
        'Read one Harness app setting by key. Secret-tier settings are never returned; use list_settings to discover whether a key is readable and writable.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Setting key from list_settings.' },
        },
        required: ['key'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = SettingsToolGetPayloadSchema.parse(args);
        const key = requireKnownSettingsToolKey(parsed.key);
        const policy = getSettingsToolPolicy(key);
        assertReadableSetting(key, policy);
        return {
          key,
          value: settingsValueForTool(key, requireSettingsManager(context).get(key), policy),
          restartRequired: policy.restartRequired,
          writable: policy.tier === 'open',
          policyTier: policy.tier,
        };
      },
    },
    {
      name: 'set_setting',
      description:
        'Set one writable Harness app setting. Refuses read-only and secret keys. JSON-backed settings such as auxiliaryLlmSlotsJson accept real objects and are stringified internally.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Writable setting key from list_settings.' },
          value: { description: 'New setting value. Type must match the setting.' },
        },
        required: ['key', 'value'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = SettingsToolSetPayloadSchema.parse(args);
        const { key, value: nextRaw, policy } = coerceWritableSettingValue(
          parsed.key,
          parsed.value,
        );
        const manager = requireSettingsManager(context);
        const oldRaw = manager.get(key);
        manager.set(key, nextRaw);
        const persistedRaw = manager.get(key);
        context.broadcastSettingsChange?.({ key, value: persistedRaw });
        logSettingMutation('set_setting', key, oldRaw, persistedRaw, policy);
        return mutationResult(key, oldRaw, persistedRaw, policy);
      },
    },
    {
      name: 'reset_setting',
      description:
        'Reset one writable Harness app setting to its built-in default. Refuses read-only and secret keys for the same policy reasons as set_setting.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Writable setting key from list_settings.' },
        },
        required: ['key'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = SettingsToolResetPayloadSchema.parse(args);
        const key = requireKnownSettingsToolKey(parsed.key);
        const policy = getSettingsToolPolicy(key);
        assertWritableSetting(key, policy);
        const manager = requireSettingsManager(context);
        const oldRaw = manager.get(key);
        manager.resetOne(key);
        const nextRaw = manager.get(key);
        context.broadcastSettingsChange?.({ key, value: nextRaw });
        logSettingMutation('reset_setting', key, oldRaw, nextRaw, policy);
        return mutationResult(key, oldRaw, nextRaw, policy);
      },
    },
    {
      name: 'update_node_config',
      description:
        'Push a sensitive per-node worker config.update to a connected remote node using the same service-scoped path as the Settings UI. Supports browserAutomation, androidAutomation, and extensionRelay blocks; call list_remote_nodes first to find the node.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: {
            type: 'string',
            description:
              'Connected worker node id or exact node name, for example "windows-pc".',
          },
          browserAutomation: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              profileDir: { type: 'string' },
              headless: { type: 'boolean' },
              chromePath: { type: 'string' },
              remoteDebuggingPort: { type: 'integer', minimum: 1, maximum: 65535 },
            },
            required: ['enabled'],
            additionalProperties: false,
          },
          androidAutomation: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              sdkPath: { type: 'string' },
              defaultAvd: { type: 'string' },
              headlessEmulator: { type: 'boolean' },
              maxEmulators: { type: 'integer', minimum: 1, maximum: 4 },
              bootTimeoutMs: { type: 'integer', minimum: 10000, maximum: 600000 },
              allowPhysicalDevices: { type: 'boolean' },
              injectMaestroMcp: { type: 'boolean' },
              appiumMcp: { type: 'boolean' },
              mobileMcpVersion: { type: 'string' },
            },
            required: ['enabled'],
            additionalProperties: false,
          },
          extensionRelay: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
            },
            required: ['enabled'],
            additionalProperties: false,
          },
        },
        required: ['nodeId'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = SettingsToolUpdateNodeConfigPayloadSchema.parse(args);
        if (!context.updateNodeConfig) {
          throw new Error(
            'update_node_config is unavailable: remote node config updates are not wired in this process',
          );
        }
        logger.info('Node config update requested via MCP tool', {
          source: 'mcp-tool',
          nodeId: parsed.nodeId,
          blocks: Object.keys(parsed).filter((key) => key !== 'nodeId'),
        });
        return context.updateNodeConfig(parsed);
      },
    },
  ];
}

function describeSetting(
  key: keyof AppSettings,
  rawValue: AppSettings[keyof AppSettings],
): SettingsToolListItem {
  const metadata = metadataByKey.get(key);
  const policy = getSettingsToolPolicy(key);
  const category = metadata?.category ?? inferCategory(key);
  return {
    key,
    value: settingsValueForTool(key, rawValue, policy),
    defaultValue: settingsValueForTool(key, DEFAULT_SETTINGS[key], policy),
    type: metadata?.type ?? inferValueType(DEFAULT_SETTINGS[key]),
    category,
    writable: policy.tier === 'open',
    restartRequired: policy.restartRequired,
    description: metadata?.description ?? fallbackDescription(key),
    policyTier: policy.tier,
  };
}

function requireSettingsManager(context: SettingsToolContext): SettingsManagerForTools {
  if (!context.settingsManager) {
    throw new Error(
      'settings tools are unavailable: SettingsManager is not wired in this process',
    );
  }
  return context.settingsManager;
}

function mutationResult(
  key: keyof AppSettings,
  oldRaw: AppSettings[keyof AppSettings],
  newRaw: AppSettings[keyof AppSettings],
  policy: SettingsToolPolicy,
): SettingsToolSetResult {
  return {
    ok: true,
    key,
    oldValue: settingsValueForTool(key, oldRaw, policy),
    newValue: settingsValueForTool(key, newRaw, policy),
    restartRequired: policy.restartRequired,
  };
}

function logSettingMutation(
  action: 'set_setting' | 'reset_setting',
  key: keyof AppSettings,
  oldRaw: AppSettings[keyof AppSettings],
  newRaw: AppSettings[keyof AppSettings],
  policy: SettingsToolPolicy,
): void {
  logger.info('Setting changed via MCP tool', {
    source: 'mcp-tool',
    action,
    key,
    oldValue: settingsValueForTool(key, oldRaw, policy),
    newValue: settingsValueForTool(key, newRaw, policy),
    restartRequired: policy.restartRequired,
  });
}

function inferValueType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value !== null && typeof value === 'object') return 'object';
  return typeof value;
}

function inferCategory(key: keyof AppSettings): string {
  if (key.startsWith('remoteNodes') || key.startsWith('thinClient')) return 'remote-nodes';
  if (key.startsWith('mobileGateway')) return 'mobile';
  if (key.startsWith('auxiliaryLlm')) return 'auxiliary-llm';
  if (key.startsWith('pause')) return 'network';
  if (key.startsWith('crossModelReview')) return 'review';
  if (key.startsWith('mcp')) return 'mcp';
  if (key.startsWith('rtk')) return 'rtk';
  if (
    key.startsWith('codebase') ||
    key.startsWith('codemem') ||
    key.startsWith('projectKnowledge') ||
    key === 'projectPluginTrust' ||
    key.startsWith('chromeDevtools') ||
    key === 'detectDegradedAdapterOutput' ||
    key === 'enableSpawnWorkerOffload'
  ) {
    return 'advanced';
  }
  return 'general';
}

function fallbackDescription(key: keyof AppSettings): string {
  return `Persisted Harness setting: ${key}.`;
}
