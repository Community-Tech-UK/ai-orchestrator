import type { InlineHelpVariant } from './ui/inline-help.component';

export type SettingsTab =
  | 'general'
  | 'orchestration'
  | 'connections'
  | 'network'
  | 'memory'
  | 'display'
  | 'ecosystem'
  | 'permissions'
  | 'review'
  | 'advanced'
  | 'keyboard'
  | 'remote-nodes'
  | 'doctor'
  | 'cli-health'
  | 'provider-quota'
  | 'rtk-savings'
  | 'models'
  | 'mcp'
  | 'hooks'
  | 'worktrees'
  | 'snapshots'
  | 'archive'
  | 'remote-config';

/** Tabs whose content is an embedded full-width feature page (no 760px cap). */
export const WIDE_TABS: ReadonlySet<SettingsTab> = new Set<SettingsTab>([
  'models',
  'mcp',
  'hooks',
  'worktrees',
  'snapshots',
  'archive',
  'remote-config',
  'doctor',
]);

/** localStorage key used to remember the last-opened settings section. */
export const LAST_TAB_KEY = 'aiorch.settings.lastTab';

/** localStorage key used to remember the help pane collapsed state. */
export const HELP_COLLAPSED_KEY = 'aiorch.settings.helpCollapsed';

/** Tone for a live nav badge. */
export type NavBadgeStatus = 'ok' | 'warn' | 'error' | 'info';

/** A live, computed health badge shown next to a nav item. */
export interface NavBadge {
  text: string;
  status: NavBadgeStatus;
}

/** A live status line shown in the contextual help pane. */
export interface HelpStatus {
  variant: InlineHelpVariant;
  text: string;
}

export interface SettingsNavItem {
  id: SettingsTab;
  label: string;
  /** One-line description shown in the section header. */
  summary: string;
  group?: string;
  recommended?: boolean;
  /** Extra search terms beyond the label/summary. */
  keywords?: string;
}

/**
 * Settings sections, ordered for the nav. Ungrouped items are everyday
 * preferences; grouped items separate agent configuration, workspace tooling,
 * network/remote, and advanced diagnostics.
 */
export const NAV_ITEMS: SettingsNavItem[] = [
  {
    id: 'general',
    label: 'General',
    summary: 'Default CLI, working directory, and core application behavior.',
    keywords: 'yolo cli directory startup notifications model',
  },
  {
    id: 'display',
    label: 'Display',
    summary: 'Theme, font size, and how agent output is rendered.',
    recommended: true,
    keywords: 'theme dark light appearance font thinking tool messages',
  },
  {
    id: 'keyboard',
    label: 'Keyboard',
    summary: 'Review and customize keyboard shortcuts.',
    keywords: 'shortcuts keybindings hotkeys',
  },
  {
    id: 'orchestration',
    label: 'Orchestration',
    summary: 'Limits and policy for spawning and running agents.',
    group: 'Agents',
    keywords: 'children instances nesting limits idle',
  },
  {
    id: 'review',
    label: 'Cross-Model Review',
    summary: 'Automatic verification of agent output by secondary models.',
    group: 'Agents',
    keywords: 'verification verify reviewers gemini codex',
  },
  {
    id: 'memory',
    label: 'Memory',
    summary: 'Session persistence and in-memory output buffers.',
    group: 'Agents',
    keywords: 'buffer disk storage persistence heap',
  },
  {
    id: 'permissions',
    label: 'Permissions',
    summary: 'Control what agents may do without asking first.',
    group: 'Agents',
    keywords: 'allow deny security tools approval rules',
  },
  {
    id: 'connections',
    label: 'Connections',
    summary: 'Manage links to AI providers and external services.',
    group: 'Workspace',
    keywords: 'providers accounts auth login',
  },
  {
    id: 'models',
    label: 'Models',
    summary: 'Choose and configure the model used for each provider.',
    group: 'Workspace',
    recommended: true,
    keywords: 'model opus sonnet gpt gemini haiku',
  },
  {
    id: 'mcp',
    label: 'MCP Servers',
    summary: 'Manage Model Context Protocol servers across providers.',
    group: 'Workspace',
    keywords: 'mcp servers tools context protocol',
  },
  {
    id: 'hooks',
    label: 'Hooks',
    summary: 'Run custom commands on agent lifecycle events.',
    group: 'Workspace',
    keywords: 'hooks events automation scripts triggers',
  },
  {
    id: 'worktrees',
    label: 'Worktrees',
    summary: 'Manage git worktrees used for parallel agent work.',
    group: 'Workspace',
    keywords: 'git worktree branch parallel',
  },
  {
    id: 'snapshots',
    label: 'Snapshots',
    summary: 'Capture and restore project state checkpoints.',
    group: 'Workspace',
    keywords: 'checkpoint restore backup',
  },
  {
    id: 'archive',
    label: 'Archive',
    summary: 'Browse and restore archived sessions.',
    group: 'Workspace',
    keywords: 'archived sessions history old',
  },
  {
    id: 'network',
    label: 'Network',
    summary: 'VPN-aware pausing and connection safety controls.',
    group: 'Network & Remote',
    keywords: 'vpn pause proxy offline reachability probe',
  },
  {
    id: 'remote-nodes',
    label: 'Remote Nodes',
    summary: 'Offload work to enrolled remote machines.',
    group: 'Network & Remote',
    keywords: 'remote nodes offload distributed gpu browser',
  },
  {
    id: 'remote-config',
    label: 'Remote Config',
    summary: 'Synchronize configuration from a remote source.',
    group: 'Network & Remote',
    keywords: 'sync cloud remote shared',
  },
  {
    id: 'cli-health',
    label: 'CLI Health',
    summary: 'Check installed AI CLIs and keep them up to date.',
    group: 'Diagnostics',
    keywords: 'cli health version update install diagnose',
  },
  {
    id: 'doctor',
    label: 'Doctor',
    summary: 'Diagnose environment and configuration issues.',
    group: 'Diagnostics',
    keywords: 'diagnostics troubleshoot environment health checks',
  },
  {
    id: 'provider-quota',
    label: 'Provider Quota',
    summary: 'Track provider rate limits and usage quotas.',
    group: 'Diagnostics',
    keywords: 'quota rate limit usage cost',
  },
  {
    id: 'rtk-savings',
    label: 'RTK Savings',
    summary: 'Token-saving output compression stats and controls.',
    group: 'Diagnostics',
    keywords: 'rtk token cost savings compression',
  },
  {
    id: 'ecosystem',
    label: 'Ecosystem',
    summary: 'Integrations with the wider tool ecosystem.',
    group: 'Diagnostics',
    keywords: 'integrations extensions plugins',
  },
  {
    id: 'advanced',
    label: 'Advanced',
    summary: 'Low-level tuning and diagnostic options.',
    group: 'Diagnostics',
    keywords: 'parser codemem buffer experimental',
  },
];

const SETTINGS_TAB_IDS = new Set<SettingsTab>(NAV_ITEMS.map((item) => item.id));

export function isSettingsTab(value: string | null | undefined): value is SettingsTab {
  return Boolean(value && SETTINGS_TAB_IDS.has(value as SettingsTab));
}
