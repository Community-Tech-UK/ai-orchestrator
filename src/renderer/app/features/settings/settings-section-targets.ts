import type { SettingsTab } from './settings-navigation';

export interface SettingsSectionTarget {
  tab: SettingsTab;
  anchor: string;
  label: string;
  keywords: string;
}
/** Bespoke pages have no metadata rows; their mounted hosts are stable anchors. */
export const SETTINGS_SECTION_TARGETS: readonly SettingsSectionTarget[] = [
  { tab: 'connections', anchor: 'discord', label: 'Discord', keywords: 'discord bot server phone chat pair' },
  { tab: 'connections', anchor: 'whatsapp', label: 'WhatsApp', keywords: 'whatsapp phone chat pair' },
  { tab: 'mobile', anchor: 'phone', label: 'Phone app', keywords: 'iphone ios tailscale qr pair mobile' },
  { tab: 'provider-quota', anchor: 'limits', label: 'Quota & usage limits', keywords: 'quota limit rate usage windows' },
  { tab: 'keyboard', anchor: 'shortcuts', label: 'Shortcuts', keywords: 'shortcut keybinding hotkey keyboard' },
  { tab: 'permissions', anchor: 'approvals', label: 'Approval rules', keywords: 'allow deny permissions filesystem network browser' },
  { tab: 'computer-use', anchor: 'desktop', label: 'Desktop access', keywords: 'computer use apps accessibility' },
  { tab: 'cross-session-messaging', anchor: 'messaging', label: 'Session messaging', keywords: 'relay consent live session message' },
  { tab: 'auxiliary-models', anchor: 'helpers', label: 'Helper models', keywords: 'local ollama auxiliary routing cheap' },
  { tab: 'voice', anchor: 'speech', label: 'Voice', keywords: 'speech microphone stt whisper transcription' },
  { tab: 'provider-accounts', anchor: 'accounts', label: 'Provider accounts', keywords: 'claude codex mimo subscription login pool' },
  { tab: 'copilot-accounts', anchor: 'accounts', label: 'Copilot accounts', keywords: 'github routing repository seat account' },
  { tab: 'remote-nodes', anchor: 'workers', label: 'Remote nodes', keywords: 'worker pair browser gpu remote computer order pause test machine checks windows pc' },
  { tab: 'cli-health', anchor: 'updates', label: 'CLI health', keywords: 'version update install diagnose' },
  { tab: 'doctor', anchor: 'diagnostics', label: 'Doctor', keywords: 'diagnostics troubleshoot startup health' },
  { tab: 'models', anchor: 'models', label: 'Models', keywords: 'provider model overrides' },
  { tab: 'mcp', anchor: 'servers', label: 'MCP servers', keywords: 'tools servers context protocol connectors microsoft 365 mail calendar always allow' },
  { tab: 'hooks', anchor: 'events', label: 'Hooks', keywords: 'lifecycle commands events scripts triggers' },
  { tab: 'ecosystem', anchor: 'plugins', label: 'Ecosystem', keywords: 'plugins integrations extensions tools commands agents' },
  { tab: 'worktrees', anchor: 'worktrees', label: 'Worktrees', keywords: 'git branch parallel workspace' },
  { tab: 'snapshots', anchor: 'snapshots', label: 'Snapshots', keywords: 'backup checkpoint restore' },
  { tab: 'archive', anchor: 'history', label: 'Archive', keywords: 'history old sessions restore' },
  { tab: 'remote-config', anchor: 'sync', label: 'Remote configuration', keywords: 'sync cloud shared settings' },
];
