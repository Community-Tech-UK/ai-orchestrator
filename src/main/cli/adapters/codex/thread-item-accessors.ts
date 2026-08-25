/**
 * Pure accessors for Codex app-server ThreadItem payloads.
 *
 * The app-server wire format has drifted between snake_case and camelCase
 * across Codex releases, so every field read tolerates both spellings.
 * Extracted from CodexCliAdapter (no state involved) to keep the adapter lean.
 */

import type { ThreadItem } from './app-server-types';

export function isCommandExecutionItem(item: ThreadItem): boolean {
  return item.type === 'command_execution' || item.type === 'commandExecution';
}

export function getCommandAggregatedOutput(item: ThreadItem): string | undefined {
  if (typeof item.aggregated_output === 'string') {
    return item.aggregated_output;
  }
  if (typeof item.aggregatedOutput === 'string') {
    return item.aggregatedOutput;
  }
  return undefined;
}

export function getCommandExitCode(item: ThreadItem): number | undefined {
  if (typeof item.exit_code === 'number') {
    return item.exit_code;
  }
  if (typeof item.exitCode === 'number') {
    return item.exitCode;
  }
  return undefined;
}

export function getFileChangePath(item: ThreadItem): string {
  if (typeof item.path === 'string' && item.path.trim()) {
    return item.path;
  }
  if (Array.isArray(item.changes)) {
    const firstPath = item.changes
      .map((change) => change?.path)
      .find((path): path is string => typeof path === 'string' && path.trim().length > 0);
    if (firstPath) {
      return firstPath;
    }
  }
  return 'unknown';
}

export function getFileChangeInput(item: ThreadItem): Record<string, unknown> {
  if (Array.isArray(item.changes)) {
    const changes = item.changes.flatMap((change) => {
      if (!change || typeof change !== 'object') return [];
      const record = change as Record<string, unknown>;
      const path = typeof record['path'] === 'string' && record['path'].trim()
        ? record['path']
        : undefined;
      if (!path) return [];
      const kind = normalizeFileChangeKind(record['kind'])
        ?? readFirstNonEmptyString(record, ['changeType', 'change_type', 'type']);
      const diff = typeof record['diff'] === 'string' ? record['diff'] : undefined;
      return [{ path, ...(kind ? { kind } : {}), ...(diff !== undefined ? { diff } : {}) }];
    });
    if (changes.length > 0) return { changes };
  }
  const path = getFileChangePath(item);
  const changeType = item.changeType
    ?? (typeof item['change_type'] === 'string' ? item['change_type'] : undefined);
  return {
    file_path: path,
    ...(changeType ? { change_type: changeType } : {}),
  };
}

export function isFailedThreadItemStatus(item: ThreadItem): boolean {
  return item.status === 'failed' || item.status === 'declined';
}

function normalizeFileChangeKind(value: unknown): string | Record<string, unknown> | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const type = typeof record['type'] === 'string' && record['type'].trim()
    ? record['type']
    : undefined;
  if (!type) return undefined;
  const movePath = record['move_path'];
  return {
    type,
    ...((typeof movePath === 'string' || movePath === null) ? { move_path: movePath } : {}),
  };
}

function readFirstNonEmptyString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  return keys
    .map((key) => record[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

export function getToolCallName(item: ThreadItem): string {
  for (const value of [item.tool, item.toolName, item['name']]) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return 'unknown';
}

export function getToolCallInput(item: ThreadItem): Record<string, unknown> {
  for (const value of [item.input, item['arguments'], item['args']]) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return {};
}
