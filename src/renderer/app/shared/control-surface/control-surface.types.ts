export type ControlSurfaceKind =
  | 'setting'
  | 'tool'
  | 'view'
  | 'diagnostic'
  | 'integration'
  | 'workflow';

export type ControlSurfaceLayout =
  | 'standard'
  | 'wide'
  | 'fullBleed';

export type ControlSurfaceGroup =
  | 'settings'
  | 'automation'
  | 'agents'
  | 'knowledge'
  | 'code'
  | 'monitoring'
  | 'integrations'
  | 'storage';

export type ControlSurfaceId =
  | 'settings'
  | 'chat-search'
  | 'automations'
  | 'campaigns'
  | 'workflows'
  | 'hooks'
  | 'skills'
  | 'reviews'
  | 'specialists'
  | 'worktrees'
  | 'supervision'
  | 'rlm'
  | 'training'
  | 'memory'
  | 'memory-stats'
  | 'debate'
  | 'verification'
  | 'verification-settings'
  | 'lsp'
  | 'mcp'
  | 'browser'
  | 'vcs'
  | 'tasks'
  | 'plan'
  | 'stats'
  | 'cost'
  | 'snapshots'
  | 'replay'
  | 'remote-access'
  | 'search'
  | 'security'
  | 'logs'
  | 'observations'
  | 'knowledge'
  | 'plugins'
  | 'models'
  | 'remote-config'
  | 'communication'
  | 'multi-edit'
  | 'editor'
  | 'archive'
  | 'semantic-search'
  | 'channels'
  | 'remote-nodes'
  | 'ask-council'
  | 'fleet'
  | 'compare-split';

export interface ControlSurfaceItem {
  readonly id: ControlSurfaceId;
  readonly path: string;
  readonly label: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly icon: string;
  readonly group: ControlSurfaceGroup;
  readonly kind: ControlSurfaceKind;
  readonly layout: ControlSurfaceLayout;
  readonly showInDashboardNav: boolean;
  readonly showInControlNav: boolean;
  readonly showInSettingsNav: boolean;
  readonly backRoute?: string;
}

export interface ControlSurfaceNavGroup {
  readonly id: ControlSurfaceGroup;
  readonly label: string;
  readonly items: readonly ControlSurfaceItem[];
}

export interface ControlSurfaceRouteData {
  readonly controlSurfaceId: ControlSurfaceId;
}
