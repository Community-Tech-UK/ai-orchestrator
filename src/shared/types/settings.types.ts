/**
 * Settings Types - Application settings configuration
 *
 * Configuration hierarchy (highest to lowest priority):
 * 1. Project config (.ai-orchestrator.json in project root)
 * 2. User config (stored in app data)
 * 3. Default config (built-in defaults)
 */

export type ThemeMode = 'light' | 'dark' | 'system';
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
}

/**
 * Default settings values
 */
export const DEFAULT_SETTINGS: AppSettings = {
  // General
  defaultYoloMode: false,
  defaultWorkingDirectory: '',
  defaultCli: 'auto',
  defaultModel: 'opus',
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
};

/**
 * Settings metadata for UI rendering
 *
 * FUTURE SETTINGS TO CONSIDER:
 * - Keyboard shortcuts customization
 * - Auto-save/restore sessions
 * - Notification preferences (child completed, errors, etc.)
 * - API key management (though CLIs handle this)
 * - Proxy settings
 * - Log level / debug mode
 * - Export/import settings
 * - Per-project settings overrides
 * - Default instance name template
 * - Auto-scroll behavior
 * - Message timestamp format
 * - Syntax highlighting theme for code blocks
 */
export interface SettingMetadata {
  key: keyof AppSettings;
  label: string;
  description: string;
  type: 'boolean' | 'string' | 'number' | 'select' | 'directory' | 'multi-select';
  category: 'general' | 'orchestration' | 'memory' | 'display' | 'advanced' | 'review' | 'network' | 'mcp' | 'rtk';
  options?: { value: string | number; label: string }[];
  min?: number;
  max?: number;
  placeholder?: string;
}

export const SETTINGS_METADATA: SettingMetadata[] = [
  // General
  {
    key: 'defaultYoloMode',
    label: 'YOLO Mode by Default',
    description:
      'Enable YOLO mode (auto-approve all actions) for new instances',
    type: 'boolean',
    category: 'general'
  },
  {
    key: 'defaultWorkingDirectory',
    label: 'Default Working Directory',
    description: 'Starting folder for new instances (empty = home directory)',
    type: 'directory',
    category: 'general',
    placeholder: '~/Projects'
  },
  {
    key: 'defaultCli',
    label: 'Default CLI',
    description: 'Which AI CLI to use when multiple are available',
    type: 'select',
    category: 'general',
    options: [
      { value: 'auto', label: 'Auto-detect' },
      { value: 'claude', label: 'Claude Code' },
      { value: 'gemini', label: 'Gemini CLI' },
      { value: 'codex', label: 'OpenAI Codex CLI' },
      { value: 'copilot', label: 'GitHub Copilot' },
      { value: 'cursor', label: 'Cursor CLI' }
    ]
  },
  {
    key: 'defaultModel',
    label: 'Default Model',
    description: 'Model to use for new instances (passed via --model flag)',
    type: 'select',
    category: 'general',
    options: [
      { value: 'opus', label: 'Opus (latest)' },
      { value: 'sonnet', label: 'Sonnet (latest)' },
      { value: 'haiku', label: 'Haiku (latest)' },
      { value: 'gpt-5.5', label: 'GPT-5.5' },
      { value: 'gpt-5.5-mini', label: 'GPT-5.5 Mini' },
      { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
      { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
      { value: 'gpt-5.2', label: 'GPT-5.2' },
      { value: 'o3', label: 'OpenAI o3' },
      { value: 'gemini-3-pro-preview', label: 'Gemini 3.1 Pro (Preview)' },
      { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (canonical ID — currently capacity-limited)' },
      { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (Preview)' },
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }
    ]
  },
  {
    key: 'theme',
    label: 'Theme',
    description: 'Application color theme',
    type: 'select',
    category: 'general',
    options: [
      { value: 'dark', label: 'Dark' },
      { value: 'light', label: 'Light' },
      { value: 'system', label: 'System' }
    ]
  },

  // Orchestration
  {
    key: 'maxChildrenPerParent',
    label: 'Max Children per Parent',
    description: 'Maximum child instances per parent (0 = unlimited)',
    type: 'number',
    category: 'orchestration',
    min: 0,
    max: 100
  },
  {
    key: 'maxTotalInstances',
    label: 'Max Total Instances',
    description: 'Maximum total instances allowed (0 = unlimited)',
    type: 'number',
    category: 'orchestration',
    min: 0,
    max: 100
  },
  {
    key: 'autoTerminateIdleMinutes',
    label: 'Auto-terminate Idle Instances',
    description:
      'Terminate instances after N minutes of inactivity (0 = disabled)',
    type: 'number',
    category: 'orchestration',
    min: 0,
    max: 120
  },
  {
    key: 'allowNestedOrchestration',
    label: 'Allow Nested Orchestration',
    description: 'Allow child instances to spawn their own children',
    type: 'boolean',
    category: 'orchestration'
  },
  {
    key: 'defaultMissedRunPolicy',
    label: 'Default Missed Run Policy',
    description: 'Default behavior when scheduled automation runs are missed',
    type: 'select',
    category: 'orchestration',
    options: [
      { value: 'skip', label: 'Skip' },
      { value: 'notify', label: 'Notify' },
      { value: 'runOnce', label: 'Run Once' },
    ],
  },

  // Memory
  {
    key: 'persistSessionContent',
    label: 'Persist Session Content',
    description:
      'Save conversation and tool output to disk for session continuity',
    type: 'boolean',
    category: 'memory'
  },

  // Display
  {
    key: 'fontSize',
    label: 'Font Size',
    description: 'Base font size for output display',
    type: 'number',
    category: 'display',
    min: 12,
    max: 20
  },
  {
    key: 'contextWarningThreshold',
    label: 'Context Warning Threshold',
    description: 'Show warning when context usage exceeds this percentage',
    type: 'number',
    category: 'display',
    min: 50,
    max: 100
  },
  {
    key: 'showToolMessages',
    label: 'Show Tool Messages',
    description: 'Display tool use and tool result messages in output',
    type: 'boolean',
    category: 'display'
  },
  {
    key: 'showThinking',
    label: 'Show Thinking/Reasoning',
    description: 'Display AI thinking process in collapsible panels',
    type: 'boolean',
    category: 'display'
  },
  {
    key: 'thinkingDefaultExpanded',
    label: 'Expand Thinking by Default',
    description: 'Show thinking panels expanded instead of collapsed',
    type: 'boolean',
    category: 'display'
  },
  {
    key: 'maxRecentDirectories',
    label: 'Recent Directories Limit',
    description: 'Maximum number of recently opened directories to remember',
    type: 'number',
    category: 'display',
    min: 5,
    max: 500
  },

  // Memory Management
  {
    key: 'outputBufferSize',
    label: 'In-Memory Buffer Size',
    description:
      'Messages kept in memory per instance (older ones saved to disk)',
    type: 'number',
    category: 'memory',
    min: 100,
    max: 5000
  },
  {
    key: 'enableDiskStorage',
    label: 'Enable Disk Storage',
    description: 'Save older output to disk to reduce memory usage',
    type: 'boolean',
    category: 'memory'
  },
  {
    key: 'maxDiskStorageMB',
    label: 'Max Disk Storage (MB)',
    description: 'Maximum disk space for output storage (0 = unlimited)',
    type: 'number',
    category: 'memory',
    min: 0,
    max: 10000
  },
  {
    key: 'memoryWarningThresholdMB',
    label: 'Memory Warning Threshold (MB)',
    description: 'Show warning when heap usage exceeds this (0 = disabled)',
    type: 'number',
    category: 'memory',
    min: 0,
    max: 8192
  },
  {
    key: 'autoTerminateOnMemoryPressure',
    label: 'Auto-terminate on Memory Pressure',
    description: 'Terminate idle instances when memory is critical',
    type: 'boolean',
    category: 'memory'
  },

  // Advanced
  {
    key: 'customModelOverride',
    label: 'Custom Model Override',
    description: 'Override the default model (leave empty for CLI default)',
    type: 'string',
    category: 'advanced',
    placeholder: 'e.g., claude-3-opus-20240229'
  },
  {
    key: 'parserBufferMaxKB',
    label: 'Parser Buffer Max (KB)',
    description: 'Maximum size for NDJSON parser buffer before reset',
    type: 'number',
    category: 'advanced',
    min: 256,
    max: 10240
  },
  {
    key: 'codememEnabled',
    label: 'Enable Codemem',
    description: 'Enable the codemem index and agent-facing code memory features',
    type: 'boolean',
    category: 'advanced'
  },
  {
    key: 'codememIndexingEnabled',
    label: 'Enable Codemem Indexing',
    description: 'Maintain the persistent workspace symbol and merkle index',
    type: 'boolean',
    category: 'advanced'
  },
  {
    key: 'codememLspWorkerEnabled',
    label: 'Enable Codemem LSP Worker',
    description: 'Start the background LSP worker used by codemem deep queries',
    type: 'boolean',
    category: 'advanced'
  },
  {
    key: 'commandDiagnosticsAvailable',
    label: 'Enable Command Diagnostics',
    description: 'Show command registry diagnostics in Doctor reports',
    type: 'boolean',
    category: 'advanced'
  },
  {
    key: 'broadRootFileThreshold',
    label: 'Broad Instruction Scan Threshold',
    description: 'Warn when project-level instruction files apply broadly above this file count',
    type: 'number',
    category: 'advanced',
    min: 0,
    max: 100000
  },

  // Cross-Model Review
  {
    key: 'crossModelReviewEnabled',
    label: 'Enable Cross-Model Review',
    description: 'Automatically verify AI output using secondary models (Gemini, Codex, etc.)',
    type: 'boolean',
    category: 'review',
  },
  {
    key: 'crossModelReviewDepth',
    label: 'Review Depth',
    description: 'Level of verification detail (structured = standard, tiered = deep for complex output)',
    type: 'select',
    category: 'review',
    options: [
      { value: 'structured', label: 'Structured (standard)' },
      { value: 'tiered', label: 'Tiered (auto-escalate for complex)' },
    ],
  },
  {
    key: 'crossModelReviewMaxReviewers',
    label: 'Max Reviewers',
    description: 'Number of secondary models to use for each review',
    type: 'number',
    category: 'review',
    min: 1,
    max: 4,
  },
  {
    key: 'crossModelReviewProviders',
    label: 'Preferred Review Providers',
    description: 'Which CLIs to use for reviews (empty = auto-detect available)',
    type: 'multi-select',
    category: 'review',
    options: [
      { value: 'gemini', label: 'Gemini CLI' },
      { value: 'codex', label: 'OpenAI Codex CLI' },
      { value: 'copilot', label: 'GitHub Copilot' },
      { value: 'claude', label: 'Claude Code' },
      { value: 'cursor', label: 'Cursor CLI' },
    ],
  },
  {
    key: 'crossModelReviewTimeout',
    label: 'Review Timeout (seconds)',
    description: 'Maximum time to wait for each reviewer response',
    type: 'number',
    category: 'review',
    min: 10,
    max: 120,
  },
  {
    key: 'crossModelReviewTypes',
    label: 'Review Triggers',
    description: 'Which output types trigger automatic review',
    type: 'multi-select',
    category: 'review',
    options: [
      { value: 'code', label: 'Code' },
      { value: 'plan', label: 'Plans' },
      { value: 'architecture', label: 'Architecture' },
    ],
  },

  // Network (Pause on VPN)
  {
    key: 'pauseFeatureEnabled',
    label: 'Enable VPN pause feature',
    description: 'Master switch for VPN pause, detector, network gate, and queue persistence.',
    type: 'boolean',
    category: 'network',
  },
  {
    key: 'pauseOnVpnEnabled',
    label: 'Pause on VPN',
    description: 'Automatically pause AI traffic when a VPN is detected.',
    type: 'boolean',
    category: 'network',
  },
  {
    key: 'pauseVpnInterfacePattern',
    label: 'Interface pattern',
    description: 'Network interface names matching this regex are treated as VPN.',
    type: 'string',
    category: 'network',
    placeholder: '^(utun[0-9]+|ipsec[0-9]+)$',
  },
  {
    key: 'pauseTreatExistingVpnAsActive',
    label: 'Treat existing VPN as active',
    description: 'If a calibrated matching interface is present at launch, treat the VPN as already up.',
    type: 'boolean',
    category: 'network',
  },
  {
    key: 'pauseDetectorDiagnostics',
    label: 'Verbose detection logging',
    description: 'Record detector ticks for VPN pattern calibration.',
    type: 'boolean',
    category: 'network',
  },
  {
    key: 'pauseReachabilityProbeHost',
    label: 'Reachability probe host',
    description: 'Optional host:port for a VPN-only reachability check.',
    type: 'string',
    category: 'network',
    placeholder: 'host.internal:443',
  },
  {
    key: 'pauseReachabilityProbeMode',
    label: 'Probe mode',
    description: 'How to interpret reachability probe results.',
    type: 'select',
    category: 'network',
    options: [
      { value: 'disabled', label: 'Disabled' },
      { value: 'reachable-means-vpn', label: 'Reachable means VPN' },
      { value: 'unreachable-means-vpn', label: 'Unreachable means VPN' },
    ],
  },
  {
    key: 'pauseReachabilityProbeIntervalSec',
    label: 'Probe interval',
    description: 'How often to run the reachability probe.',
    type: 'number',
    category: 'network',
    min: 10,
    max: 600,
  },
  {
    key: 'pauseAllowPrivateRanges',
    label: 'Allow private ranges during pause',
    description: 'Permit RFC 1918 private network hosts while paused.',
    type: 'boolean',
    category: 'network',
  },
  {
    key: 'mcpCleanupBackupsOnQuit',
    label: 'Clean up MCP config backups on quit',
    description: 'Remove .orc.bak files created before editing provider MCP configs',
    type: 'boolean',
    category: 'mcp',
  },
  {
    key: 'mcpDisableProviderBackups',
    label: 'Do not write MCP config backups',
    description: 'Skip safety backups before editing provider MCP configs',
    type: 'boolean',
    category: 'mcp',
  },
  {
    key: 'mcpAllowWorldWritableParent',
    label: 'Allow world-writable MCP config parents',
    description: 'Permit writes to MCP config folders whose parent directory is world-writable',
    type: 'boolean',
    category: 'mcp',
  },
  {
    key: 'rtkEnabled',
    label: 'Enable RTK token-saving rewrites',
    description: 'Compress LLM-bound shell command output 60–90% via the rtk binary. Requires app restart to take effect on running instances.',
    type: 'boolean',
    category: 'rtk',
  },
  {
    key: 'rtkBundledOnly',
    label: 'Use bundled rtk only',
    description: 'Always use the rtk binary shipped with this app, never a system-installed rtk on PATH. Useful for reproducibility.',
    type: 'boolean',
    category: 'rtk',
  },
];

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
