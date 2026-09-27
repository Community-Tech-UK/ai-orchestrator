import type { OutputMessage } from '../../core/state/instance/instance.types';

export const SYSTEM_GROUP_TIME_GAP_MS = 5 * 60 * 1000;

const SYSTEM_GROUP_PREVIEW_MAX_LEN = 120;

export const ALWAYS_VISIBLE_SYSTEM_ACTIONS: ReadonlySet<string> = new Set([
  'task_complete',
  'task_error',
  'child_completed',
  'all_children_completed',
  'request_user_action',
  'user_action_response',
  'unknown',
]);

export const QUIET_INTERRUPT_SYSTEM_MESSAGES = new Set<string>([
  'Interrupted — waiting for input',
  'Interrupted — session restarted (resume failed)',
]);

/**
 * A provider compaction's start/finish notices. The compaction boundary row
 * (which also carries `providerCompaction: 'completed'`) says it happened, so a
 * successful lifecycle shows one row instead of three. Failures stay visible.
 */
export function isQuietProviderCompactionMarker(message: OutputMessage): boolean {
  const metadata = message.metadata;
  if (message.type !== 'system' || !metadata) return false;
  if (metadata['threadCompacted'] === true || metadata['isCompactionBoundary'] === true) return false;
  const phase = metadata['providerCompaction'];
  if (phase === 'started') return true;
  const outcome = metadata['providerCompactionOutcome'];
  return phase === 'completed' && (outcome === undefined || outcome === 'settled');
}

const SYSTEM_ACTION_LABELS: Readonly<Record<string, string>> = {
  consensus_query: 'Consensus query',
  get_children: 'Active children polled',
  get_child_output: 'Child output fetched',
  get_child_summary: 'Child summary fetched',
  get_child_artifacts: 'Child artifacts fetched',
  get_child_section: 'Child section fetched',
  task_progress: 'Task progress',
  call_tool: 'Tool calls',
  message_child: 'Messages to children',
  spawn_child: 'Child spawned',
  terminate_child: 'Children terminated',
};

export function resolveSystemActionLabel(action: string): string {
  const knownLabel = SYSTEM_ACTION_LABELS[action];
  if (knownLabel) return knownLabel;

  const humanized = action.replace(/_/g, ' ').trim();
  if (!humanized) return 'System event';
  return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}

export function buildSystemGroupPreview(content: string): string {
  if (!content) return '';

  const cleaned = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/^\s*[-*#>]+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length <= SYSTEM_GROUP_PREVIEW_MAX_LEN) return cleaned;
  return `${cleaned.slice(0, SYSTEM_GROUP_PREVIEW_MAX_LEN - 3).trimEnd()}...`;
}
