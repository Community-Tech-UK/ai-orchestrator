import type { SettingMetadata } from './settings-metadata.types';

export const INTEGRATION_SETTINGS_METADATA: SettingMetadata[] = [
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
  {
    key: 'notifyOnAgentCompletion',
    label: 'Notify when agent finishes',
    description: 'Show a desktop notification when an agent transitions from busy to idle (only when the window is not focused)',
    type: 'boolean',
    category: 'general',
  },
];
