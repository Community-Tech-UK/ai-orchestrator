import type { SettingsTab } from './settings-navigation';

export interface SettingsNavPage {
  id: string;
  label: string;
  summary: string;
  tabs: readonly SettingsTab[];
  keywords?: string;
}
export const SETTINGS_PAGES: readonly SettingsNavPage[] = [
  { id: 'general', label: 'General', summary: 'Defaults and startup.', tabs: ['general'] },
  { id: 'display', label: 'Display & input', summary: 'Appearance, keyboard and voice.', tabs: ['display', 'keyboard', 'voice'] },
  { id: 'agents', label: 'Agents', summary: 'Agent behavior and helper models.', tabs: ['orchestration', 'cross-session-messaging', 'auxiliary-models'] },
  { id: 'review', label: 'Second opinion', summary: 'Check agent output.', tabs: ['review'] },
  { id: 'permissions', label: 'Permissions & safety', summary: 'Approvals and desktop access.', tabs: ['permissions', 'computer-use'] },
  { id: 'models', label: 'Models', summary: 'Provider models and overrides.', tabs: ['models'] },
  { id: 'tools', label: 'Tools & plugins', summary: 'Tool servers and integrations.', tabs: ['mcp', 'hooks', 'ecosystem'] },
  { id: 'workspace', label: 'Workspace & history', summary: 'Worktrees, snapshots and archives.', tabs: ['worktrees', 'snapshots', 'archive'] },
  { id: 'accounts', label: 'Accounts', summary: 'Subscriptions and account routing.', tabs: ['provider-accounts', 'copilot-accounts'] },
  { id: 'phone', label: 'Phone & remote', summary: 'Phone connections and remote computers.', tabs: ['connections', 'mobile', 'remote-nodes', 'remote-config', 'network'] },
  { id: 'health', label: 'Health', summary: 'Diagnostics, updates and usage limits.', tabs: ['cli-health', 'doctor', 'provider-quota', 'rtk-savings'] },
  { id: 'advanced', label: 'Advanced', summary: 'Runtime options and storage.', tabs: ['advanced', 'memory'] },
];
export function pageForTab(tab: SettingsTab): SettingsNavPage {
  const page = SETTINGS_PAGES.find(page => page.tabs.includes(tab));
  if (!page) throw new Error(`Settings tab has no page: ${tab}`);
  return page;
}
