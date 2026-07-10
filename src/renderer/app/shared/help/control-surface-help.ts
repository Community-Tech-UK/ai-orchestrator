/**
 * Control-surface help registry.
 *
 * Maps every Control Center surface id to its Help & tips content. Typed as a
 * total `Record` so adding a new surface without help content is a compile
 * error - every page must have a help entry.
 */

import type { ControlSurfaceId } from '../control-surface/control-surface.types';
import type { HelpEntry } from './help-content.types';
import {
  AUTOMATIONS_HELP,
  CAMPAIGNS_HELP,
  HOOKS_HELP,
  WORKFLOWS_HELP,
} from './content/automation.help';
import {
  ASK_COUNCIL_HELP,
  DEBATE_HELP,
  DOC_REVIEW_HELP,
  REVIEWS_HELP,
  SKILLS_HELP,
  SPECIALISTS_HELP,
} from './content/agents.help';
import {
  CHAT_SEARCH_HELP,
  KNOWLEDGE_GRAPH_HELP,
  MEMORY_BROWSER_HELP,
  MEMORY_STATS_HELP,
  OBSERVATIONS_HELP,
  RLM_HELP,
  TRAINING_HELP,
} from './content/knowledge.help';
import {
  EDITOR_HELP,
  LSP_HELP,
  MULTI_EDIT_HELP,
  PLAN_HELP,
  SEARCH_CODE_HELP,
  SEMANTIC_SEARCH_HELP,
  TASKS_HELP,
  VCS_HELP,
  WORKTREES_HELP,
} from './content/code.help';
import {
  COMPARE_SPLIT_HELP,
  COST_HELP,
  FLEET_HELP,
  LOGS_HELP,
  REPLAY_HELP,
  SECURITY_HELP,
  STATS_HELP,
  SUPERVISION_HELP,
  VERIFICATION_HELP,
} from './content/monitoring.help';
import {
  BROWSER_GATEWAY_HELP,
  CHANNELS_HELP,
  COMMUNICATION_HELP,
  MCP_HELP,
  PLUGINS_HELP,
  REMOTE_ACCESS_HELP,
  REMOTE_CONFIG_HELP,
  REMOTE_NODES_SURFACE_HELP,
} from './content/integrations.help';
import {
  ARCHIVE_HELP,
  MODELS_HELP,
  SETTINGS_SURFACE_HELP,
  SNAPSHOTS_HELP,
  VERIFICATION_SETTINGS_HELP,
} from './content/storage-settings.help';

export const CONTROL_SURFACE_HELP: Record<ControlSurfaceId, HelpEntry> = {
  'settings': SETTINGS_SURFACE_HELP,
  'chat-search': CHAT_SEARCH_HELP,
  'automations': AUTOMATIONS_HELP,
  'campaigns': CAMPAIGNS_HELP,
  'workflows': WORKFLOWS_HELP,
  'hooks': HOOKS_HELP,
  'skills': SKILLS_HELP,
  'reviews': REVIEWS_HELP,
  'doc-review': DOC_REVIEW_HELP,
  'specialists': SPECIALISTS_HELP,
  'worktrees': WORKTREES_HELP,
  'supervision': SUPERVISION_HELP,
  'rlm': RLM_HELP,
  'training': TRAINING_HELP,
  'memory': MEMORY_BROWSER_HELP,
  'memory-stats': MEMORY_STATS_HELP,
  'debate': DEBATE_HELP,
  'verification': VERIFICATION_HELP,
  'verification-settings': VERIFICATION_SETTINGS_HELP,
  'lsp': LSP_HELP,
  'mcp': MCP_HELP,
  'browser': BROWSER_GATEWAY_HELP,
  'vcs': VCS_HELP,
  'tasks': TASKS_HELP,
  'plan': PLAN_HELP,
  'stats': STATS_HELP,
  'cost': COST_HELP,
  'snapshots': SNAPSHOTS_HELP,
  'replay': REPLAY_HELP,
  'remote-access': REMOTE_ACCESS_HELP,
  'search': SEARCH_CODE_HELP,
  'security': SECURITY_HELP,
  'logs': LOGS_HELP,
  'observations': OBSERVATIONS_HELP,
  'knowledge': KNOWLEDGE_GRAPH_HELP,
  'plugins': PLUGINS_HELP,
  'models': MODELS_HELP,
  'remote-config': REMOTE_CONFIG_HELP,
  'communication': COMMUNICATION_HELP,
  'multi-edit': MULTI_EDIT_HELP,
  'editor': EDITOR_HELP,
  'archive': ARCHIVE_HELP,
  'semantic-search': SEMANTIC_SEARCH_HELP,
  'channels': CHANNELS_HELP,
  'remote-nodes': REMOTE_NODES_SURFACE_HELP,
  'ask-council': ASK_COUNCIL_HELP,
  'fleet': FLEET_HELP,
  'compare-split': COMPARE_SPLIT_HELP,
};
