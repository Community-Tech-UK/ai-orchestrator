/**
 * Settings Types - Application settings configuration
 *
 * Configuration hierarchy (highest to lowest priority):
 * 1. Project config (.ai-orchestrator.json in project root)
 * 2. User config (stored in app data)
 * 3. Default config (built-in defaults)
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type DisplayDensity = 'comfortable' | 'compact';
export type SidebarStyle = 'standard' | 'compact';
export type CanonicalCliType = 'claude' | 'gemini' | 'codex' | 'copilot' | 'auto' | 'cursor';
export type CliType = CanonicalCliType | 'openai'; // legacy alias kept for persisted settings compatibility
export type ConfigSource = 'project' | 'user' | 'default';
export type DefaultMissedRunPolicy = 'skip' | 'notify' | 'runOnce';
export type PauseReachabilityProbeMode = 'disabled' | 'reachable-means-vpn' | 'unreachable-means-vpn';

/**
 * Application settings that are persisted to disk
 */
export interface AppSettings {
  // General
  defaultYoloMode: boolean;
  defaultWorkingDirectory: string;
  defaultCli: CliType;
  /**
   * Last-selected model when no per-provider memory exists. Kept for
   * backward compatibility with existing reads; the source of truth for
   * "what model should this provider start with" is `defaultModelByProvider`.
   * On changes, both fields are kept in sync for the currently-selected
   * provider so older code paths that still read `defaultModel` keep working.
   */
  defaultModel: string;
  /**
   * Last-selected model per CLI provider, so switching from
   * Claude → Copilot → Claude restores Claude's previous selection
   * instead of forcing the user to re-pick. Keys are `CanonicalCliType`
   * values minus 'auto' (auto has no concrete model). Missing entries
   * fall back to `getPrimaryModelForProvider(provider)`.
   */
  defaultModelByProvider: Record<string, string>;
  theme: ThemeMode;

  // Orchestration
  maxChildrenPerParent: number;
  maxTotalInstances: number; // 0 = unlimited
  autoTerminateIdleMinutes: number; // 0 = disabled
  allowNestedOrchestration: boolean;
  defaultMissedRunPolicy: DefaultMissedRunPolicy;

  // Memory Management
  outputBufferSize: number; // messages kept in memory per instance
  enableDiskStorage: boolean; // save older output to disk
  maxDiskStorageMB: number; // max disk space for output storage (0 = unlimited)
  memoryWarningThresholdMB: number; // warn when heap exceeds this (0 = disabled)
  autoTerminateOnMemoryPressure: boolean; // terminate idle instances when memory critical
  persistSessionContent: boolean; // persist session content (conversation/tool output) to disk

  // Display
  fontSize: number; // 12-20
  displayDensity: DisplayDensity;
  sidebarStyle: SidebarStyle;
  contextWarningThreshold: number; // 0-100 percentage
  showToolMessages: boolean;
  showThinking: boolean; // Display AI thinking process in collapsible panels
  thinkingDefaultExpanded: boolean; // Show thinking panels expanded instead of collapsed

  // Recent Directories
  maxRecentDirectories: number; // 5-500, max directories to remember

  // Advanced
  customModelOverride: string; // empty = use default
  parserBufferMaxKB: number; // max size for NDJSON parser buffer
  codememEnabled: boolean;
  codememIndexingEnabled: boolean;
  codememLspWorkerEnabled: boolean;
  commandDiagnosticsAvailable: boolean;
  broadRootFileThreshold: number;

  // Cross-Model Review
  crossModelReviewEnabled: boolean;
  crossModelReviewDepth: 'structured' | 'tiered';
  crossModelReviewMaxReviewers: number;
  crossModelReviewProviders: string[];
  crossModelReviewTimeout: number;
  crossModelReviewTypes: string[];

  // Remote Nodes
  remoteNodesEnabled: boolean;
  remoteNodesServerPort: number;
  remoteNodesServerHost: string;
  remoteNodesEnrollmentToken: string;
  remoteNodesAutoOffloadBrowser: boolean;
  remoteNodesAutoOffloadGpu: boolean;
  remoteNodesNamespace: string;
  remoteNodesRequireTls: boolean;
  remoteNodesTlsMode: 'auto' | 'custom';
  remoteNodesTlsCertPath: string;
  remoteNodesTlsKeyPath: string;
  remoteNodesRegisteredNodes: string;

  // Network (Pause on VPN)
  pauseFeatureEnabled: boolean;
  pauseOnVpnEnabled: boolean;
  pauseVpnInterfacePattern: string;
  pauseTreatExistingVpnAsActive: boolean;
  pauseDetectorDiagnostics: boolean;
  pauseReachabilityProbeHost: string;
  pauseReachabilityProbeMode: PauseReachabilityProbeMode;
  pauseReachabilityProbeIntervalSec: number;
  pauseAllowPrivateRanges: boolean;

  // MCP Safety
  mcpCleanupBackupsOnQuit: boolean;
  mcpDisableProviderBackups: boolean;
  mcpAllowWorldWritableParent: boolean;

  // RTK (Rust Token Killer) — compresses LLM-bound shell command output 60–90%.
  // See bigchange_rtk_integration.md for details. On by default; users can opt out
  // via the RTK Savings settings tab.
  rtkEnabled: boolean;
  /** When true, never use a system-installed rtk; only the bundled binary. */
  rtkBundledOnly: boolean;

  // Notifications
  /** Show a desktop notification when an agent transitions from busy to idle. Default: true. */
  notifyOnAgentCompletion: boolean;
}

/**
 * Default settings values
 */
export const DEFAULT_SETTINGS: AppSettings = {
  // General
  defaultYoloMode: false,
  defaultWorkingDirectory: '',
  defaultCli: 'auto',
  defaultModel: 'opus[1m]',
  defaultModelByProvider: {},
  theme: 'dark',

  // Orchestration
  maxChildrenPerParent: 10,
  maxTotalInstances: 20,
  autoTerminateIdleMinutes: 30,
  allowNestedOrchestration: false,
  defaultMissedRunPolicy: 'notify',

  // Memory Management
  outputBufferSize: 500, // keep 500 messages in memory per instance
  enableDiskStorage: true, // save older output to disk
  maxDiskStorageMB: 500, // 500MB max disk storage
  memoryWarningThresholdMB: 1024, // warn at 1GB heap
  autoTerminateOnMemoryPressure: true,
  persistSessionContent: true,

  // Display
  fontSize: 14,
  displayDensity: 'comfortable',
  sidebarStyle: 'standard',
  contextWarningThreshold: 80,
  showToolMessages: true,
  showThinking: true,
  thinkingDefaultExpanded: false,

  // Recent Directories
  maxRecentDirectories: 200,

  // Advanced
  customModelOverride: '',
  parserBufferMaxKB: 1024, // 1MB max parser buffer
  codememEnabled: true,
  codememIndexingEnabled: true,
  codememLspWorkerEnabled: true,
  commandDiagnosticsAvailable: true,
  broadRootFileThreshold: 100,

  // Cross-Model Review
  crossModelReviewEnabled: true,
  crossModelReviewDepth: 'structured',
  crossModelReviewMaxReviewers: 2,
  crossModelReviewProviders: [],
  crossModelReviewTimeout: 30,
  crossModelReviewTypes: ['code', 'plan', 'architecture'],

  // Remote Nodes
  remoteNodesEnabled: false,
  remoteNodesServerPort: 4878,
  remoteNodesServerHost: '0.0.0.0',
  remoteNodesEnrollmentToken: '',
  remoteNodesAutoOffloadBrowser: true,
  remoteNodesAutoOffloadGpu: false,
  remoteNodesNamespace: 'default',
  remoteNodesRequireTls: false,
  remoteNodesTlsMode: 'auto' as const,
  remoteNodesTlsCertPath: '',
  remoteNodesTlsKeyPath: '',
  remoteNodesRegisteredNodes: '{}',

  // Network (Pause on VPN)
  pauseFeatureEnabled: true,
  pauseOnVpnEnabled: true,
  pauseVpnInterfacePattern: '^(utun[0-9]+|ipsec[0-9]+|ppp[0-9]+|tap[0-9]+)$',
  pauseTreatExistingVpnAsActive: true,
  pauseDetectorDiagnostics: false,
  pauseReachabilityProbeHost: '',
  pauseReachabilityProbeMode: 'disabled',
  pauseReachabilityProbeIntervalSec: 30,
  pauseAllowPrivateRanges: false,

  // MCP Safety
  mcpCleanupBackupsOnQuit: true,
  mcpDisableProviderBackups: false,
  mcpAllowWorldWritableParent: false,

  // RTK
  rtkEnabled: true,
  rtkBundledOnly: false,

  // Notifications
  notifyOnAgentCompletion: true,
};

export { SETTINGS_METADATA } from './settings-metadata';
export type { SettingMetadata } from './settings-metadata';

// ============================================
// Project Configuration Types
// ============================================

/**
 * Project-level configuration file format
 * Stored in .ai-orchestrator.json in project root
 */
export interface ProjectConfig {
  // Project identity
  name?: string;
  description?: string;

  // Override settings (partial)
  settings?: Partial<AppSettings>;

  // Agent configuration
  defaultAgent?: string; // Default agent mode for this project

  // Custom commands for this project
  commands?: {
    name: string;
    description: string;
    template: string;
    hint?: string;
  }[];

  // File patterns to ignore
  ignorePatterns?: string[];

  // Custom system prompt additions
  systemPromptAdditions?: string;
}

/**
 * Resolved configuration with source tracking
 */
export interface ResolvedConfig {
  settings: AppSettings;
  sources: Record<keyof AppSettings, ConfigSource>;
  projectConfig?: ProjectConfig;
  projectPath?: string;
}

/**
 * Project config file name
 */
export const PROJECT_CONFIG_FILE = '.ai-orchestrator.json';

/**
 * Legacy project config file name (for backward compatibility)
 */
export const LEGACY_PROJECT_CONFIG_FILE = '.claude-orchestrator.json';

/**
 * Merge project config with user settings
 */
export function mergeConfigs(
  defaultSettings: AppSettings,
  userSettings: Partial<AppSettings>,
  projectSettings?: Partial<AppSettings>
): ResolvedConfig {
  const settings = { ...defaultSettings };
  const sources: Record<string, ConfigSource> = {};
  const applySetting = <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
    source: ConfigSource
  ) => {
    settings[key] = value;
    sources[key] = source;
  };

  // Start with defaults
  for (const key of Object.keys(defaultSettings) as (keyof AppSettings)[]) {
    sources[key] = 'default';
  }

  // Apply user settings
  if (userSettings) {
    for (const [key, value] of Object.entries(userSettings)) {
      if (value !== undefined) {
        const typedKey = key as keyof AppSettings;
        applySetting(typedKey, value as AppSettings[typeof typedKey], 'user');
      }
    }
  }

  // Apply project settings (highest priority)
  if (projectSettings) {
    for (const [key, value] of Object.entries(projectSettings)) {
      if (value !== undefined) {
        const typedKey = key as keyof AppSettings;
        applySetting(typedKey, value as AppSettings[typeof typedKey], 'project');
      }
    }
  }

  return {
    settings,
    sources: sources as Record<keyof AppSettings, ConfigSource>
  };
}
