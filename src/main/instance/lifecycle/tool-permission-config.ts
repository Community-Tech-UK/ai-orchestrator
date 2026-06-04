import type { AgentToolPermissions } from '../../../shared/types/agent.types';
import { getDisallowedTools } from '../../../shared/utils/permission-mapper';
import { ToolListFilter, type DenyRule } from '../../tools/tool-list-filter';
import { HOST_CLI_CLOUD_SCHEDULER_TOOLS } from '../../cli/adapters/host-cli-tool-policy';

// Tools that require Claude CLI's interactive terminal and auto-deny in --print mode.
// Always disallow these so Claude doesn't attempt them and misinterpret the
// auto-denial as user rejection.
const PRINT_MODE_INCOMPATIBLE_TOOLS = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];

// The authoritative guarantee that these are blocked lives in ClaudeCliAdapter.buildArgs
// (covers every spawn path). They are folded into the cold-spawn denylist here too so the
// explicit --disallowedTools flag carries them and the deny set stays self-describing.
// (Read-only CronList/CronDelete are intentionally left available for cleanup.)

const STANDARD_INTERACTIVE_ALLOWED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'Task',
  'TaskOutput',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'Skill',
];

export type AllowedToolsPolicy = 'allow-all' | 'standard-unless-yolo';

export interface ToolPermissionConfig {
  allowedTools: string[] | undefined;
  denyRules: DenyRule[];
  disallowedTools: string[];
  disallowedToolsForSpawn: string[] | undefined;
  toolFilter: ToolListFilter;
}

export function buildToolPermissionConfig(
  permissions: AgentToolPermissions,
  options: {
    allowedToolsPolicy: AllowedToolsPolicy;
    yoloMode?: boolean;
  },
): ToolPermissionConfig {
  const disallowedTools = [
    ...getDisallowedTools(permissions),
    ...PRINT_MODE_INCOMPATIBLE_TOOLS,
    ...HOST_CLI_CLOUD_SCHEDULER_TOOLS,
  ];
  const denyRules: DenyRule[] = disallowedTools.map((tool) => ({
    pattern: tool,
    type: 'blanket',
  }));

  return {
    allowedTools: resolveAllowedTools(options),
    denyRules,
    disallowedTools,
    disallowedToolsForSpawn: disallowedTools.length > 0 ? disallowedTools : undefined,
    toolFilter: new ToolListFilter(denyRules),
  };
}

export function attachToolFilterMetadata(
  target: { metadata?: Record<string, unknown> },
  toolFilter: ToolListFilter,
): void {
  target.metadata ??= {};
  target.metadata['toolFilter'] = toolFilter;
}

function resolveAllowedTools(options: {
  allowedToolsPolicy: AllowedToolsPolicy;
  yoloMode?: boolean;
}): string[] | undefined {
  if (options.allowedToolsPolicy === 'allow-all' || options.yoloMode) {
    return undefined;
  }

  return [...STANDARD_INTERACTIVE_ALLOWED_TOOLS];
}
