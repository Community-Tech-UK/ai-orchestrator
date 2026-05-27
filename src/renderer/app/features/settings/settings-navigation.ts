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
 * preferences; grouped items separate agent behavior, workspace tools,
 * network/remote controls, and health diagnostics.
 */
export const NAV_ITEMS: SettingsNavItem[] = [
  {
    id: 'general',
    label: 'General',
    summary: 'Default CLI, model, working directory, and approval behavior.',
    keywords: 'yolo cli directory startup notifications model',
  },
  {
    id: 'display',
    label: 'Display',
    summary: 'Interface appearance and transcript visibility controls.',
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
    summary: 'Control how many agents can run and how they spawn child work.',
    group: 'Agent behavior',
    keywords: 'children instances nesting limits idle',
  },
  {
    id: 'review',
    label: 'Cross-Model Review',
    summary: 'Verify agent output with secondary models.',
    group: 'Agent behavior',
    keywords: 'verification verify reviewers gemini codex',
  },
  {
    id: 'memory',
    label: 'Memory',
    summary: 'Session persistence, output buffers, and storage limits.',
    group: 'Agent behavior',
    keywords: 'buffer disk storage persistence heap',
  },
  {
    id: 'permissions',
    label: 'Permissions',
    summary: 'Default approval rules for filesystem, network, and browser actions.',
    group: 'Agent behavior',
    keywords: 'allow deny security tools approval rules',
  },
  {
    id: 'connections',
    label: 'Connections',
    summary: 'Connect external services that can control Orchestrator remotely.',
    group: 'Workspace tools',
    keywords: 'providers accounts auth login',
  },
  {
    id: 'models',
    label: 'Models',
    summary: 'Choose provider models and per-model overrides.',
    group: 'Workspace tools',
    recommended: true,
    keywords: 'model opus sonnet gpt gemini haiku',
  },
  {
    id: 'mcp',
    label: 'MCP Servers',
    summary: 'Manage tool servers shared across provider CLIs.',
    group: 'Workspace tools',
    keywords: 'mcp servers tools context protocol',
  },
  {
    id: 'hooks',
    label: 'Hooks',
    summary: 'Run custom commands on agent lifecycle events.',
    group: 'Workspace tools',
    keywords: 'hooks events automation scripts triggers',
  },
  {
    id: 'worktrees',
    label: 'Worktrees',
    summary: 'Configure git worktrees for parallel agent work.',
    group: 'Workspace tools',
    keywords: 'git worktree branch parallel',
  },
  {
    id: 'snapshots',
    label: 'Snapshots',
    summary: 'Capture and restore workspace checkpoints.',
    group: 'Workspace tools',
    keywords: 'checkpoint restore backup',
  },
  {
    id: 'archive',
    label: 'Archive',
    summary: 'Browse and restore archived sessions.',
    group: 'Workspace tools',
    keywords: 'archived sessions history old',
  },
  {
    id: 'network',
    label: 'Network',
    summary: 'Configure VPN-aware pausing and outbound reachability checks.',
    group: 'Network & Remote',
    keywords: 'vpn pause proxy offline reachability probe',
  },
  {
    id: 'remote-nodes',
    label: 'Remote Nodes',
    summary: 'Pair and monitor remote worker machines.',
    group: 'Network & Remote',
    keywords: 'remote nodes offload distributed gpu browser',
  },
  {
    id: 'remote-config',
    label: 'Remote Config',
    summary: 'Sync settings from a remote configuration source.',
    group: 'Network & Remote',
    keywords: 'sync cloud remote shared',
  },
  {
    id: 'cli-health',
    label: 'CLI Health',
    summary: 'Check installed AI CLIs and available updates.',
    group: 'Health & Diagnostics',
    keywords: 'cli health version update install diagnose',
  },
  {
    id: 'doctor',
    label: 'Doctor',
    summary: 'Diagnose startup, provider, browser, and instruction issues.',
    group: 'Health & Diagnostics',
    keywords: 'diagnostics troubleshoot environment health checks',
  },
  {
    id: 'provider-quota',
    label: 'Provider Quota',
    summary: 'Monitor provider usage windows and refresh cadence.',
    group: 'Health & Diagnostics',
    keywords: 'quota rate limit usage cost',
  },
  {
    id: 'rtk-savings',
    label: 'RTK Savings',
    summary: 'Inspect token savings from RTK output compression.',
    group: 'Health & Diagnostics',
    keywords: 'rtk token cost savings compression',
  },
  {
    id: 'ecosystem',
    label: 'Ecosystem',
    summary: 'Browse commands, agents, tools, and plugin integrations.',
    group: 'Workspace tools',
    keywords: 'integrations extensions plugins',
  },
  {
    id: 'advanced',
    label: 'Advanced',
    summary: 'Low-level parser, indexing, and diagnostic switches.',
    group: 'Health & Diagnostics',
    keywords: 'parser codemem buffer experimental',
  },
];

const SETTINGS_TAB_IDS = new Set<SettingsTab>(NAV_ITEMS.map((item) => item.id));

export function isSettingsTab(value: string | null | undefined): value is SettingsTab {
  return Boolean(value && SETTINGS_TAB_IDS.has(value as SettingsTab));
}
