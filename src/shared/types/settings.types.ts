/**
 * Settings Types - Application settings configuration
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type CliType = 'claude' | 'gemini' | 'openai' | 'auto';

/**
 * Application settings that are persisted to disk
 */
export interface AppSettings {
  // General
  defaultYoloMode: boolean;
  defaultWorkingDirectory: string;
  defaultCli: CliType;
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

  // Display
  fontSize: number; // 12-20
  contextWarningThreshold: number; // 0-100 percentage
  showToolMessages: boolean;

  // Advanced
  customModelOverride: string; // empty = use default
  parserBufferMaxKB: number; // max size for NDJSON parser buffer
}

/**
 * Default settings values
 */
export const DEFAULT_SETTINGS: AppSettings = {
  // General
  defaultYoloMode: true,
  defaultWorkingDirectory: '',
  defaultCli: 'auto',
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

  // Display
  fontSize: 14,
  contextWarningThreshold: 80,
  showToolMessages: true,

  // Advanced
  customModelOverride: '',
  parserBufferMaxKB: 1024, // 1MB max parser buffer
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
  type: 'boolean' | 'string' | 'number' | 'select' | 'directory';
  category: 'general' | 'orchestration' | 'memory' | 'display' | 'advanced';
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
    description: 'Enable YOLO mode (auto-approve all actions) for new instances',
    type: 'boolean',
    category: 'general',
  },
  {
    key: 'defaultWorkingDirectory',
    label: 'Default Working Directory',
    description: 'Starting folder for new instances (empty = home directory)',
    type: 'directory',
    category: 'general',
    placeholder: '~/Projects',
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
      { value: 'openai', label: 'OpenAI CLI' },
    ],
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
      { value: 'system', label: 'System' },
    ],
  },

  // Orchestration
  {
    key: 'maxChildrenPerParent',
    label: 'Max Children per Parent',
    description: 'Maximum child instances per parent (0 = unlimited)',
    type: 'number',
    category: 'orchestration',
    min: 0,
    max: 100,
  },
  {
    key: 'maxTotalInstances',
    label: 'Max Total Instances',
    description: 'Maximum total instances allowed (0 = unlimited)',
    type: 'number',
    category: 'orchestration',
    min: 0,
    max: 100,
  },
  {
    key: 'autoTerminateIdleMinutes',
    label: 'Auto-terminate Idle Instances',
    description: 'Terminate instances after N minutes of inactivity (0 = disabled)',
    type: 'number',
    category: 'orchestration',
    min: 0,
    max: 120,
  },
  {
    key: 'allowNestedOrchestration',
    label: 'Allow Nested Orchestration',
    description: 'Allow child instances to spawn their own children',
    type: 'boolean',
    category: 'orchestration',
  },

  // Display
  {
    key: 'fontSize',
    label: 'Font Size',
    description: 'Base font size for output display',
    type: 'number',
    category: 'display',
    min: 12,
    max: 20,
  },
  {
    key: 'contextWarningThreshold',
    label: 'Context Warning Threshold',
    description: 'Show warning when context usage exceeds this percentage',
    type: 'number',
    category: 'display',
    min: 50,
    max: 100,
  },
  {
    key: 'showToolMessages',
    label: 'Show Tool Messages',
    description: 'Display tool use and tool result messages in output',
    type: 'boolean',
    category: 'display',
  },

  // Memory Management
  {
    key: 'outputBufferSize',
    label: 'In-Memory Buffer Size',
    description: 'Messages kept in memory per instance (older ones saved to disk)',
    type: 'number',
    category: 'memory',
    min: 100,
    max: 5000,
  },
  {
    key: 'enableDiskStorage',
    label: 'Enable Disk Storage',
    description: 'Save older output to disk to reduce memory usage',
    type: 'boolean',
    category: 'memory',
  },
  {
    key: 'maxDiskStorageMB',
    label: 'Max Disk Storage (MB)',
    description: 'Maximum disk space for output storage (0 = unlimited)',
    type: 'number',
    category: 'memory',
    min: 0,
    max: 10000,
  },
  {
    key: 'memoryWarningThresholdMB',
    label: 'Memory Warning Threshold (MB)',
    description: 'Show warning when heap usage exceeds this (0 = disabled)',
    type: 'number',
    category: 'memory',
    min: 0,
    max: 8192,
  },
  {
    key: 'autoTerminateOnMemoryPressure',
    label: 'Auto-terminate on Memory Pressure',
    description: 'Terminate idle instances when memory is critical',
    type: 'boolean',
    category: 'memory',
  },

  // Advanced
  {
    key: 'customModelOverride',
    label: 'Custom Model Override',
    description: 'Override the default model (leave empty for CLI default)',
    type: 'string',
    category: 'advanced',
    placeholder: 'e.g., claude-3-opus-20240229',
  },
  {
    key: 'parserBufferMaxKB',
    label: 'Parser Buffer Max (KB)',
    description: 'Maximum size for NDJSON parser buffer before reset',
    type: 'number',
    category: 'advanced',
    min: 256,
    max: 10240,
  },
];
