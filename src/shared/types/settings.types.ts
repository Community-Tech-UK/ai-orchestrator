/**
 * Settings Types - Application settings configuration
 *
 * Configuration hierarchy (highest to lowest priority):
 * 1. Project config (.ai-orchestrator.json in project root)
 * 2. User config (stored in app data)
 * 3. Default config (built-in defaults)
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type CanonicalCliType = 'claude' | 'gemini' | 'codex' | 'copilot' | 'auto';
export type CliType = CanonicalCliType | 'openai'; // legacy alias kept for persisted settings compatibility
export type ConfigSource = 'project' | 'user' | 'default';

/**
 * Application settings that are persisted to disk
 */
export interface AppSettings {
  // General
  defaultYoloMode: boolean;
  defaultWorkingDirectory: string;
  defaultCli: CliType;
  defaultModel: string; // Model to use for all providers (passed via --model flag)
  theme: ThemeMode;

  // Orchestration
  maxChildrenPerParent: number;
  maxTotalInstances: number; // 0 = unlimited
  autoTerminateIdleMinutes: number; // 0 = disabled
  allowNestedOrchestration: boolean;

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
  maxRecentDirectories: number; // 5-50, max directories to remember

  // Advanced
  customModelOverride: string; // empty = use default
  parserBufferMaxKB: number; // max size for NDJSON parser buffer

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
  theme: 'dark',

  // Orchestration
  maxChildrenPerParent: 10,
  maxTotalInstances: 20,
  autoTerminateIdleMinutes: 30,
  allowNestedOrchestration: false,

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
  maxRecentDirectories: 15,

  // Advanced
  customModelOverride: '',
  parserBufferMaxKB: 1024, // 1MB max parser buffer

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
  category: 'general' | 'orchestration' | 'memory' | 'display' | 'advanced' | 'review';
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
      { value: 'copilot', label: 'GitHub Copilot' }
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
      { value: 'gpt-5.4', label: 'GPT-5.4' },
      { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
      { value: 'gpt-4o', label: 'GPT-4o' },
      { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
      { value: 'o3', label: 'OpenAI o3' },
      { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Preview)' },
      { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro (Preview)' },
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
    max: 50
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
