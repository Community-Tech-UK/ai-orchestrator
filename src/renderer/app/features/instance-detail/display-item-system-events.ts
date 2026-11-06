import type { OutputMessage } from '../../core/state/instance/instance.types';
import { resolveSystemMessageAudience } from '../../../../shared/utils/system-message-audience';
import type { DisplayItem } from './display-item.types';

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

/**
 * `groupAction` of the row that folds routine notices. Orchestration groups use
 * their snake_case action name, so a fold can never be mistaken for one.
 */
export const ROUTINE_NOTICE_GROUP_ACTION = 'routine-notices';

/** `metadata.type` values that mark an approval or question prompt. */
const APPROVAL_PROMPT_TYPES: ReadonlySet<string> = new Set([
  'permission_denial',
  'secret_required',
  'input_required',
  'deferred_permission',
  'acp_permission_request',
  'mcp_elicitation',
  'acp_elicitation',
]);

/**
 * Approvals and failed tools are never folded away, whatever an emit site
 * flagged. The flag asks to be quiet; these have to stay in plain view.
 */
function mustStayOutsideRoutineFold(message: OutputMessage): boolean {
  const metadata = message.metadata;
  if (!metadata) return false;
  const action = metadata['action'];
  if (typeof action === 'string' && ALWAYS_VISIBLE_SYSTEM_ACTIONS.has(action)) return true;
  const type = metadata['type'];
  if (typeof type === 'string' && APPROVAL_PROMPT_TYPES.has(type)) return true;
  return metadata['presentationKind'] === 'request-receipt'
    || metadata['errorPresentation'] !== undefined
    || metadata['permissionDecision'] === true
    || metadata['secretRequestBlocked'] === true
    || metadata['is_error'] === true
    || metadata['isError'] === true
    || metadata['checkFailed'] === true;
}

/**
 * True for a system message its emit site flagged `audience: 'routine'` that is
 * safe to fold into the "N system events" row. Unflagged messages are never
 * routine, whatever they say.
 */
export function isFoldableRoutineNotice(message: OutputMessage): boolean {
  return resolveSystemMessageAudience(message) === 'routine' && !mustStayOutsideRoutineFold(message);
}

/** "1 system event" / "3 system events". */
export function buildRoutineGroupLabel(count: number): string {
  return count === 1 ? '1 system event' : `${count} system events`;
}

/** A new fold row holding one routine notice. */
export function createRoutineNoticeGroup(message: OutputMessage, bufferIndex?: number): DisplayItem {
  return {
    id: `sysgrp-${message.id}`,
    type: 'system-event-group',
    systemEvents: [message],
    groupAction: ROUTINE_NOTICE_GROUP_ACTION,
    groupLabel: buildRoutineGroupLabel(1),
    groupPreview: buildSystemGroupPreview(message.content),
    timestamp: message.timestamp,
    bufferIndex,
  };
}

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
