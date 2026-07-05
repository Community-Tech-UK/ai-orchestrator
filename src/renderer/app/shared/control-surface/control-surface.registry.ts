import { controlSurfaceIcon } from './control-surface-icons';
import type {
  ControlSurfaceGroup,
  ControlSurfaceId,
  ControlSurfaceItem,
  ControlSurfaceKind,
  ControlSurfaceLayout,
  ControlSurfaceNavGroup,
} from './control-surface.types';

const GROUP_LABELS: Record<ControlSurfaceGroup, string> = {
  settings: 'Settings',
  automation: 'Automation',
  agents: 'Agents',
  knowledge: 'Knowledge',
  code: 'Code',
  monitoring: 'Monitoring',
  integrations: 'Integrations',
  storage: 'Storage',
};

const GROUP_ORDER: readonly ControlSurfaceGroup[] = [
  'settings',
  'automation',
  'agents',
  'knowledge',
  'code',
  'monitoring',
  'integrations',
  'storage',
];

interface SurfaceDefinition {
  readonly id: ControlSurfaceId;
  readonly path: string;
  readonly label: string;
  readonly title?: string;
  readonly subtitle: string;
  readonly group: ControlSurfaceGroup;
  readonly kind: ControlSurfaceKind;
  readonly layout?: ControlSurfaceLayout;
  readonly dashboard?: boolean;
  readonly settings?: boolean;
  readonly backRoute?: string;
}

function surface(definition: SurfaceDefinition): ControlSurfaceItem {
  return {
    id: definition.id,
    path: definition.path,
    label: definition.label,
    title: definition.title ?? definition.label,
    subtitle: definition.subtitle,
    icon: controlSurfaceIcon(definition.id, definition.group),
    group: definition.group,
    kind: definition.kind,
    layout: definition.layout ?? 'standard',
    showInDashboardNav: definition.dashboard ?? false,
    showInControlNav: true,
    showInSettingsNav: definition.settings ?? false,
    backRoute: definition.backRoute,
  };
}

export const CONTROL_SURFACES: readonly ControlSurfaceItem[] = [
  surface({ id: 'settings', path: '/settings', label: 'Settings', subtitle: 'Configure app behavior, providers, and diagnostics.', group: 'settings', kind: 'setting' }),
  surface({ id: 'chat-search', path: '/chat-search', label: 'Chat Search', subtitle: 'Find prior conversations and reusable context.', group: 'knowledge', kind: 'tool' }),
  surface({ id: 'automations', path: '/automations', label: 'Automations', subtitle: 'Schedule and monitor recurring agent work.', group: 'automation', kind: 'workflow', dashboard: true }),
  surface({ id: 'campaigns', path: '/campaigns', label: 'Campaigns', subtitle: 'Coordinate multi-loop campaign runs.', group: 'automation', kind: 'workflow', layout: 'wide', dashboard: true }),
  surface({ id: 'workflows', path: '/workflows', label: 'Workflows', subtitle: 'Compose reusable automation flows.', group: 'automation', kind: 'workflow', dashboard: true }),
  surface({ id: 'hooks', path: '/hooks', label: 'Hooks', subtitle: 'Run commands on agent lifecycle events.', group: 'automation', kind: 'workflow', dashboard: true, settings: true }),
  surface({ id: 'skills', path: '/skills', label: 'Skills', subtitle: 'Browse available agent skills.', group: 'agents', kind: 'tool', dashboard: true }),
  surface({ id: 'reviews', path: '/reviews', label: 'Code Reviews', subtitle: 'Inspect review output and follow-up work.', group: 'agents', kind: 'workflow', dashboard: true }),
  surface({ id: 'specialists', path: '/specialists', label: 'Agent Roles', subtitle: 'Choose specialist personas and responsibilities.', group: 'agents', kind: 'tool', dashboard: true }),
  surface({ id: 'worktrees', path: '/worktrees', label: 'Worktrees', subtitle: 'Manage git worktrees for parallel agent work.', group: 'code', kind: 'tool', dashboard: true, settings: true }),
  surface({ id: 'supervision', path: '/supervision', label: 'Supervisor', subtitle: 'Observe active agent trees and state.', group: 'monitoring', kind: 'diagnostic', layout: 'wide', dashboard: true }),
  surface({ id: 'rlm', path: '/rlm', label: 'Learning Database', subtitle: 'Inspect reinforcement learning memory context.', group: 'knowledge', kind: 'view', dashboard: true }),
  surface({ id: 'training', path: '/training', label: 'Training Data', subtitle: 'Review training datasets and learning signals.', group: 'knowledge', kind: 'tool', dashboard: true }),
  surface({ id: 'memory', path: '/memory', label: 'Memory Browser', subtitle: 'Browse remembered project and session context.', group: 'knowledge', kind: 'view', dashboard: true }),
  surface({ id: 'memory-stats', path: '/memory/stats', label: 'Memory Stats', subtitle: 'Inspect memory usage and storage health.', group: 'knowledge', kind: 'diagnostic' }),
  surface({ id: 'debate', path: '/debate', label: 'Debate Arena', subtitle: 'Run and inspect multi-agent debates.', group: 'agents', kind: 'workflow', dashboard: true }),
  surface({ id: 'verification', path: '/verification', label: 'Verification', subtitle: 'Run cross-model verification workflows.', group: 'monitoring', kind: 'workflow', layout: 'wide', dashboard: true }),
  surface({ id: 'verification-settings', path: '/verification/settings', label: 'Verification Settings', subtitle: 'Configure verification CLI behavior.', group: 'settings', kind: 'setting' }),
  surface({ id: 'lsp', path: '/lsp', label: 'Language Server', subtitle: 'Inspect language-server integration state.', group: 'code', kind: 'tool', dashboard: true }),
  surface({ id: 'mcp', path: '/mcp', label: 'MCP Servers', subtitle: 'Manage tool servers shared across provider CLIs.', group: 'integrations', kind: 'integration', dashboard: true, settings: true }),
  surface({ id: 'browser', path: '/browser', label: 'Browser Gateway', subtitle: 'Control managed browser automation.', group: 'integrations', kind: 'tool', layout: 'wide', dashboard: true }),
  surface({ id: 'vcs', path: '/vcs', label: 'Git', subtitle: 'Review source-control state and changes.', group: 'code', kind: 'tool', dashboard: true }),
  surface({ id: 'tasks', path: '/tasks', label: 'Background Jobs', subtitle: 'Monitor local background repo jobs.', group: 'code', kind: 'diagnostic', dashboard: true }),
  surface({ id: 'plan', path: '/plan', label: 'Plan Mode', subtitle: 'Draft and review structured implementation plans.', group: 'code', kind: 'tool', dashboard: true }),
  surface({ id: 'stats', path: '/stats', label: 'Statistics', subtitle: 'Inspect app metrics and throughput.', group: 'monitoring', kind: 'diagnostic', dashboard: true }),
  surface({ id: 'cost', path: '/cost', label: 'Costs & Usage', subtitle: 'Track provider spend and usage.', group: 'monitoring', kind: 'diagnostic', dashboard: true }),
  surface({ id: 'snapshots', path: '/snapshots', label: 'Snapshots', subtitle: 'Capture and restore workspace checkpoints.', group: 'storage', kind: 'tool', dashboard: true, settings: true }),
  surface({ id: 'replay', path: '/replay', label: 'Replay', subtitle: 'Replay sessions and observation streams.', group: 'monitoring', kind: 'view', layout: 'wide', dashboard: true }),
  surface({ id: 'remote-access', path: '/remote-access', label: 'Remote Access', subtitle: 'Control remote access and pairing surfaces.', group: 'integrations', kind: 'integration', dashboard: true }),
  surface({ id: 'search', path: '/search', label: 'Search Code', subtitle: 'Search indexed codebase content.', group: 'code', kind: 'tool', dashboard: true }),
  surface({ id: 'security', path: '/security', label: 'Security', subtitle: 'Review security and audit findings.', group: 'monitoring', kind: 'diagnostic', dashboard: true }),
  surface({ id: 'logs', path: '/logs', label: 'Logs', subtitle: 'Inspect app logs and debug output.', group: 'monitoring', kind: 'diagnostic', dashboard: true }),
  surface({ id: 'observations', path: '/observations', label: 'Telemetry', subtitle: 'Review observations and reflections.', group: 'knowledge', kind: 'diagnostic', dashboard: true }),
  surface({ id: 'knowledge', path: '/knowledge', label: 'Knowledge Graph', subtitle: 'Explore structured project knowledge.', group: 'knowledge', kind: 'view', layout: 'wide', dashboard: true }),
  surface({ id: 'plugins', path: '/plugins', label: 'Plugins', subtitle: 'Manage runtime plugin integrations.', group: 'integrations', kind: 'integration', dashboard: true }),
  surface({ id: 'models', path: '/models', label: 'Models', subtitle: 'Choose provider models and overrides.', group: 'settings', kind: 'setting', dashboard: true, settings: true }),
  surface({ id: 'remote-config', path: '/remote-config', label: 'Remote Config', subtitle: 'Sync settings from remote configuration sources.', group: 'integrations', kind: 'integration', dashboard: true, settings: true }),
  surface({ id: 'communication', path: '/communication', label: 'Instance Messaging', subtitle: 'Configure cross-instance communication.', group: 'integrations', kind: 'integration', dashboard: true }),
  surface({ id: 'multi-edit', path: '/multi-edit', label: 'Multi-File Edit', subtitle: 'Review and apply coordinated edits.', group: 'code', kind: 'tool', layout: 'wide', dashboard: true }),
  surface({ id: 'editor', path: '/editor', label: 'Editor', subtitle: 'Edit workspace files directly.', group: 'code', kind: 'tool', layout: 'fullBleed', dashboard: true }),
  surface({ id: 'archive', path: '/archive', label: 'Archive', subtitle: 'Browse and restore archived sessions.', group: 'storage', kind: 'view', dashboard: true, settings: true }),
  surface({ id: 'semantic-search', path: '/semantic-search', label: 'Semantic Search', subtitle: 'Search code and memory semantically.', group: 'code', kind: 'tool', dashboard: true }),
  surface({ id: 'channels', path: '/channels', label: 'Discord & WhatsApp', title: 'Discord & WhatsApp', subtitle: 'Connect external messaging channels.', group: 'integrations', kind: 'integration', dashboard: true }),
  surface({ id: 'remote-nodes', path: '/remote-nodes', label: 'Remote Nodes', subtitle: 'Pair and monitor remote worker nodes.', group: 'integrations', kind: 'integration', dashboard: true }),
  surface({ id: 'ask-council', path: '/ask-council', label: 'Ask Council', subtitle: 'Compare answers across multiple providers.', group: 'agents', kind: 'workflow', layout: 'wide' }),
  surface({ id: 'fleet', path: '/fleet', label: 'Fleet Dashboard', subtitle: 'Monitor attention zones across the agent fleet.', group: 'monitoring', kind: 'diagnostic', layout: 'wide', dashboard: true }),
  surface({ id: 'compare-split', path: '/compare/split', label: 'Split Compare', subtitle: 'Compare two sessions side by side.', group: 'monitoring', kind: 'tool', layout: 'fullBleed' }),
];

const CONTROL_SURFACE_BY_ID = new Map<ControlSurfaceId, ControlSurfaceItem>(
  CONTROL_SURFACES.map((item) => [item.id, item]),
);

export function listControlSurfaces(): readonly ControlSurfaceItem[] {
  return CONTROL_SURFACES;
}

export function tryGetControlSurface(id: string): ControlSurfaceItem | undefined {
  return CONTROL_SURFACE_BY_ID.get(id as ControlSurfaceId);
}

export function getControlSurface(id: ControlSurfaceId): ControlSurfaceItem {
  const item = CONTROL_SURFACE_BY_ID.get(id);
  if (!item) {
    throw new Error(`Unknown control surface: ${id}`);
  }
  return item;
}

export function listControlNavGroups(): readonly ControlSurfaceNavGroup[] {
  return groupSurfaces(CONTROL_SURFACES.filter((item) => item.showInControlNav));
}

export function listDashboardNavGroups(): readonly ControlSurfaceNavGroup[] {
  return groupSurfaces(CONTROL_SURFACES.filter((item) => item.showInDashboardNav));
}

export function listSettingsExternalLinks(): readonly ControlSurfaceItem[] {
  return CONTROL_SURFACES.filter((item) => item.showInSettingsNav);
}

function groupSurfaces(items: readonly ControlSurfaceItem[]): readonly ControlSurfaceNavGroup[] {
  return GROUP_ORDER
    .map((group) => ({
      id: group,
      label: GROUP_LABELS[group],
      items: items.filter((item) => item.group === group),
    }))
    .filter((group) => group.items.length > 0);
}
