import type { SettingMetadata } from './settings-metadata.types';

export const INTEGRATION_SETTINGS_METADATA: SettingMetadata[] = [
  {
    key: 'mcpCleanupBackupsOnQuit',
    label: 'Delete MCP config backups on quit',
    description: 'When the app quits, remove the ".orc.bak" safety copies it makes before editing a provider\'s MCP config file.',
    type: 'boolean',
    category: 'mcp',
  },
  {
    key: 'mcpDisableProviderBackups',
    label: "Don't back up MCP configs before editing",
    description: "Skip making a safety copy before editing a provider's MCP config. Not recommended — backups let you recover if an edit goes wrong.",
    type: 'boolean',
    category: 'mcp',
  },
  {
    key: 'mcpAllowWorldWritableParent',
    label: 'Allow MCP configs in world-writable folders',
    description: 'Allow editing MCP configs even when their folder can be written by any user on the machine. Normally blocked, because it is a security risk.',
    type: 'boolean',
    category: 'mcp',
  },
  {
    key: 'rtkEnabled',
    label: 'Compress command output to save tokens',
    description: 'Shrink the shell-command output sent to the model by 60–90% using the bundled "RTK" tool, so you spend fewer tokens. Restart the app to apply this to running instances.',
    type: 'boolean',
    category: 'rtk',
  },
  {
    key: 'rtkBundledOnly',
    label: 'Only use the built-in RTK',
    description: 'Always use the RTK tool shipped inside this app, never one installed elsewhere on your system. Keeps behavior consistent across machines.',
    type: 'boolean',
    category: 'rtk',
  },
  {
    key: 'notifyOnAgentCompletion',
    label: 'Notify when an agent finishes',
    description: 'Show a desktop notification when an agent goes from busy to idle (only when this window is not focused).',
    type: 'boolean',
    category: 'general',
  },
  {
    key: 'cliUpdatePolicy',
    label: 'CLI provider updates',
    description: 'How to handle newer versions of the AI CLIs this app wraps (Claude, Codex, Gemini, Copilot). "Notify" shows a one-click update button; "Auto-apply" installs safe updates for you when no instances are running; "Off" hides update checks.',
    type: 'select',
    category: 'general',
    options: [
      { value: 'notify', label: 'Notify me (one-click update)' },
      { value: 'auto', label: 'Auto-apply safe updates' },
      { value: 'off', label: 'Off' },
    ],
  },
];
